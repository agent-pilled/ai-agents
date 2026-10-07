// Leak probes, run inside the sandbox before the harness starts. Each probe
// passes when the sandbox holds and fails when something leaks; "info" marks
// an observation with no pass condition. The sandbox entry script and the
// runner add the probes that need the token or the host's view.
import { lookup, Resolver } from "node:dns/promises";
import {
  lstat,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { basename, join } from "node:path";

export interface ProbeResult {
  readonly probe: string;
  readonly result: "pass" | "fail" | "info";
  readonly detail: string;
}

/** What the runner knows about the host and the sandbox layout. */
export interface ProbeConfig {
  readonly hostHome: string;
  readonly hostUid: number;
  readonly sandboxHome: string;
  readonly sandboxUser: string;
  /** The bridge's port on 127.0.0.1 inside the sandbox. */
  readonly bridgePort: number;
  readonly brokerSocket: string;
  /** A target the egress proxy must allow, such as the model API. */
  readonly allowedTarget: string;
  /** A target the egress proxy must deny. */
  readonly deniedTarget: string;
  /** Names of the environment variables the sandbox may hold. */
  readonly allowedEnv: readonly string[];
  /** Directories that must accept writes: HOME, tmp, the workspace, the output channel. */
  readonly writable: readonly string[];
  /** Directories that must refuse writes. */
  readonly readOnly: readonly string[];
  /** Process names that may be visible inside the sandbox. */
  readonly allowedProcesses: readonly string[];
  /** A variable run.sh exports in its own environment; no process inside may hold it. */
  readonly launcherCanary: string;
}

/** Public addresses that must be unreachable without the proxy. */
const publicTcpTargets = [
  { probe: "net-direct-tcp-ipv4", host: "1.1.1.1", port: 443 },
  { probe: "net-direct-tcp-ipv6", host: "2606:4700:4700::1111", port: 443 },
] as const;
const publicName = "example.com";
const publicDnsServer = "1.1.1.1";
/** The entry script as bash holds it open, on a descriptor of its choosing. */
const entryScript = "/opt/forgecrew/spike/sandbox-entry.sh";

/** The probes runProbes reports, in order. The summary checks a run against it. */
export const sandboxProbeNames = [
  "net-interfaces",
  "net-direct-tcp-ipv4",
  "net-direct-tcp-ipv6",
  "net-dns-system",
  "net-dns-direct",
  "net-abstract-sockets",
  "proxy-allows-model-api",
  "proxy-denies-other",
  "broker-reachable",
  "fs-host-home-absent",
  "fs-ssh-material-absent",
  "fs-other-users-absent",
  "fs-writes-refused",
  "fs-writes-accepted",
  "env-host-absent",
  "proc-host-processes-invisible",
  "proc-launcher-env-absent",
  "proc-launcher-argv-absent",
  "proc-no-capabilities",
  "proc-entry-fds-clean",
] as const;

export type ProbeEntry = readonly [
  name: string,
  run: () => ProbeResult | Promise<ProbeResult>,
];

/**
 * Runs every probe against the live sandbox, in order, and hands each result
 * to onResult as soon as it is known, so a crash later loses nothing earlier.
 */
export async function runProbes(
  config: ProbeConfig,
  onResult: (result: ProbeResult) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runProbeTable(sandboxProbes(config, env), onResult);
}

/** Runs each probe; one that throws fails under its own name and the rest still run. */
export async function runProbeTable(
  table: readonly ProbeEntry[],
  onResult: (result: ProbeResult) => void,
): Promise<void> {
  for (const [name, run] of table) {
    try {
      const { result, detail } = await run();
      onResult({ probe: name, result, detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onResult({
        probe: name,
        result: "fail",
        detail: `the probe threw: ${message}`,
      });
    }
  }
}

/** The in-sandbox probes, named as in sandboxProbeNames. */
export function sandboxProbes(
  config: ProbeConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProbeEntry[] {
  return [
    ["net-interfaces", () => onlyLoopback(networkInterfaces())],
    ...publicTcpTargets.map(
      ({ probe, host, port }): ProbeEntry => [
        probe,
        () => tcpBlocked(probe, host, port),
      ],
    ),
    ["net-dns-system", () => dnsLookupBlocked("net-dns-system", publicName)],
    [
      "net-dns-direct",
      () => dnsServerBlocked("net-dns-direct", publicName, publicDnsServer),
    ],
    [
      "net-abstract-sockets",
      async () => noAbstractSockets(await readOr("/proc/net/unix")),
    ],
    [
      "proxy-allows-model-api",
      () =>
        proxyAnswers(
          "proxy-allows-model-api",
          config.bridgePort,
          config.allowedTarget,
          200,
        ),
    ],
    [
      "proxy-denies-other",
      () =>
        proxyAnswers(
          "proxy-denies-other",
          config.bridgePort,
          config.deniedTarget,
          403,
        ),
    ],
    ["broker-reachable", () => brokerServesOpenApi(config.brokerSocket)],
    [
      "fs-host-home-absent",
      () =>
        config.hostHome === config.sandboxHome
          ? {
              probe: "fs-host-home-absent",
              result: "info",
              detail: `the host HOME and the sandbox HOME share the path ${config.hostHome}`,
            }
          : pathsAbsent("fs-host-home-absent", [config.hostHome]),
    ],
    [
      "fs-ssh-material-absent",
      () =>
        pathsAbsent("fs-ssh-material-absent", [
          join(config.hostHome, ".ssh"),
          "/root/.ssh",
          "/etc/ssh",
          `/run/user/${config.hostUid}`,
        ]),
    ],
    [
      "fs-other-users-absent",
      async () =>
        combine("fs-other-users-absent", [
          onlyPasswdUsers(await readOr("/etc/passwd"), [config.sandboxUser]),
          await onlyDirEntries("home-dirs", "/home", [
            basename(config.sandboxHome),
          ]),
          await pathsAbsent("root-and-shadow", ["/root", "/etc/shadow"]),
        ]),
    ],
    ["fs-writes-refused", () => writesRefused(config.readOnly)],
    ["fs-writes-accepted", () => writesAccepted(config.writable)],
    ["env-host-absent", () => envConfined(env, config.allowedEnv)],
    [
      "proc-host-processes-invisible",
      () => processesConfined("/proc", config.allowedProcesses),
    ],
    [
      "proc-launcher-env-absent",
      () => launcherEnvAbsent("/proc", config.launcherCanary),
    ],
    ["proc-launcher-argv-absent", () => launcherArgvAbsent("/proc")],
    [
      "proc-no-capabilities",
      async () => noCapabilities(await readOr("/proc/self/status")),
    ],
    [
      "proc-entry-fds-clean",
      () => parentFdsClean("/proc", process.ppid, [0, 1, 2], [entryScript]),
    ],
  ];
}

export async function tcpBlocked(
  probe: string,
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<ProbeResult> {
  const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve({ probe, result: "fail", detail: `connected to ${target}` });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ probe, result: "pass", detail: `${target}: timed out` });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        probe,
        result: "pass",
        detail: `${target}: ${errorCode(error)}`,
      });
    });
  });
}

export async function dnsLookupBlocked(
  probe: string,
  hostname: string,
): Promise<ProbeResult> {
  try {
    const addresses = await lookup(hostname, { all: true });
    const list = addresses.map((entry) => entry.address).join(", ");
    return { probe, result: "fail", detail: `${hostname} resolved to ${list}` };
  } catch (error) {
    return {
      probe,
      result: "pass",
      detail: `${hostname}: ${errorCode(error)}`,
    };
  }
}

export async function dnsServerBlocked(
  probe: string,
  hostname: string,
  server: string,
): Promise<ProbeResult> {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers([server]);
  try {
    const addresses = await resolver.resolve4(hostname);
    return {
      probe,
      result: "fail",
      detail: `${server} resolved ${hostname} to ${addresses.join(", ")}`,
    };
  } catch (error) {
    return { probe, result: "pass", detail: `${server}: ${errorCode(error)}` };
  }
}

export function onlyLoopback(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): ProbeResult {
  const probe = "net-interfaces";
  const names = Object.keys(interfaces);
  const external = names.filter((name) =>
    (interfaces[name] ?? []).some((info) => !info.internal),
  );
  return external.length === 0
    ? { probe, result: "pass", detail: `only loopback: ${listOf(names)}` }
    : {
        probe,
        result: "fail",
        detail: `external interfaces: ${listOf(external)}`,
      };
}

/** Abstract Unix sockets live in the network namespace, outside any mount. */
export function noAbstractSockets(
  procNetUnix: string | undefined,
): ProbeResult {
  const probe = "net-abstract-sockets";
  if (procNetUnix === undefined) {
    return { probe, result: "fail", detail: "cannot read /proc/net/unix" };
  }
  const abstract = procNetUnix
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[7])
    .filter((path): path is string => path?.startsWith("@") ?? false);
  return abstract.length === 0
    ? { probe, result: "pass", detail: "no abstract sockets visible" }
    : {
        probe,
        result: "fail",
        detail: `${abstract.length} visible: ${abstract.slice(0, 5).join(", ")}`,
      };
}

/** Sends CONNECT through the bridge and compares the proxy's status. */
export function proxyAnswers(
  probe: string,
  port: number,
  target: string,
  expectedStatus: number,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    let received = "";
    const done = (result: ProbeResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
      const end = received.indexOf("\r\n");
      if (end === -1) {
        return;
      }
      const status = Number(received.slice(0, end).split(" ")[1]);
      done({
        probe,
        result: status === expectedStatus ? "pass" : "fail",
        detail: `CONNECT ${target}: ${status}, expected ${expectedStatus}`,
      });
    });
    socket.once("timeout", () =>
      done({ probe, result: "fail", detail: `CONNECT ${target}: timed out` }),
    );
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done({
        probe,
        result: "fail",
        detail: `CONNECT ${target}: ${errorCode(error)}`,
      }),
    );
    socket.once("close", () =>
      done({
        probe,
        result: "fail",
        detail: `CONNECT ${target}: closed without a status`,
      }),
    );
  });
}

export function brokerServesOpenApi(
  socketPath: string,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const probe = "broker-reachable";
  return new Promise((resolve) => {
    const outgoing = request(
      { socketPath, path: "/openapi.json", timeout: timeoutMs },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const version = openApiVersion(body);
          resolve(
            response.statusCode === 200 && version !== undefined
              ? {
                  probe,
                  result: "pass",
                  detail: `GET /openapi.json: OpenAPI ${version}`,
                }
              : {
                  probe,
                  result: "fail",
                  detail: `GET /openapi.json: ${response.statusCode}, no OpenAPI document`,
                },
          );
        });
      },
    );
    outgoing.once("timeout", () => outgoing.destroy(new Error("timed out")));
    outgoing.once("error", (error) =>
      resolve({
        probe,
        result: "fail",
        detail: `${socketPath}: ${errorCode(error)}`,
      }),
    );
    outgoing.end();
  });
}

export async function pathsAbsent(
  probe: string,
  paths: readonly string[],
): Promise<ProbeResult> {
  const present: string[] = [];
  for (const path of paths) {
    if (await exists(path)) {
      present.push(path);
    }
  }
  return present.length === 0
    ? { probe, result: "pass", detail: `absent: ${listOf(paths)}` }
    : { probe, result: "fail", detail: `present: ${listOf(present)}` };
}

export async function onlyDirEntries(
  probe: string,
  dir: string,
  allowed: readonly string[],
): Promise<ProbeResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    return { probe, result: "pass", detail: `${dir}: ${errorCode(error)}` };
  }
  const extra = entries.filter((entry) => !allowed.includes(entry));
  return extra.length === 0
    ? {
        probe,
        result: "pass",
        detail: `${dir} holds ${listOf(entries) || "nothing"}`,
      }
    : {
        probe,
        result: "fail",
        detail: `${dir} also holds ${listOf(extra)}`,
      };
}

export function onlyPasswdUsers(
  passwd: string | undefined,
  allowed: readonly string[],
): ProbeResult {
  const probe = "passwd-users";
  if (passwd === undefined) {
    return { probe, result: "pass", detail: "no /etc/passwd" };
  }
  const users = passwd
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split(":")[0] ?? "");
  const extra = users.filter((user) => !allowed.includes(user));
  return extra.length === 0
    ? { probe, result: "pass", detail: `users: ${listOf(users)}` }
    : { probe, result: "fail", detail: `other users: ${listOf(extra)}` };
}

/** Compares variable names only; values may hold secrets. */
export function envConfined(
  env: NodeJS.ProcessEnv,
  allowed: readonly string[],
): ProbeResult {
  const probe = "env-host-absent";
  const names = Object.keys(env).sort();
  const extra = names.filter((name) => !allowed.includes(name));
  return extra.length === 0
    ? { probe, result: "pass", detail: `variables: ${listOf(names)}` }
    : {
        probe,
        result: "fail",
        detail: `unexpected variables: ${listOf(extra)}`,
      };
}

export async function writesRefused(
  paths: readonly string[],
): Promise<ProbeResult> {
  const probe = "fs-writes-refused";
  const writable: string[] = [];
  for (const path of paths) {
    if ((await tryWrite(path)) === "written") {
      writable.push(path);
    }
  }
  return writable.length === 0
    ? { probe, result: "pass", detail: `refused: ${listOf(paths)}` }
    : { probe, result: "fail", detail: `writable: ${listOf(writable)}` };
}

export async function writesAccepted(
  paths: readonly string[],
): Promise<ProbeResult> {
  const probe = "fs-writes-accepted";
  const refused: string[] = [];
  for (const path of paths) {
    const outcome = await tryWrite(path);
    if (outcome !== "written") {
      refused.push(`${path} (${outcome})`);
    }
  }
  return refused.length === 0
    ? { probe, result: "pass", detail: `writable: ${listOf(paths)}` }
    : { probe, result: "fail", detail: `refused: ${listOf(refused)}` };
}

/**
 * Inside a PID namespace only the sandbox's own processes are visible. A
 * process is named by the basename of its argv[0], because Node 24 names its
 * main thread MainThread and the kernel reports that as the process name.
 */
export async function processesConfined(
  procRoot: string,
  allowed: readonly string[],
): Promise<ProbeResult> {
  const probe = "proc-host-processes-invisible";
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch (error) {
    return {
      probe,
      result: "fail",
      detail: `${procRoot}: ${errorCode(error)}`,
    };
  }
  const visible: Array<{ pid: string; name: string }> = [];
  for (const pid of entries.filter((entry) => /^\d+$/.test(entry))) {
    visible.push({ pid, name: await processName(join(procRoot, pid)) });
  }
  const label = ({ pid, name }: { pid: string; name: string }) =>
    `${pid}:${name}`;
  const unexpected = visible.filter(({ name }) => !allowed.includes(name));
  return unexpected.length === 0
    ? {
        probe,
        result: "pass",
        detail: `visible: ${listOf(visible.map(label))}`,
      }
    : {
        probe,
        result: "fail",
        detail: `unexpected: ${listOf(unexpected.map(label))}`,
      };
}

/** The basename of argv[0], or the kernel's process name when argv is empty. */
async function processName(processDir: string): Promise<string> {
  const argv0 = (await readOr(join(processDir, "cmdline")))?.split("\0")[0];
  if (argv0 !== undefined && argv0.length > 0) {
    return basename(argv0);
  }
  return (await readOr(join(processDir, "comm")))?.trim() ?? "?";
}

/**
 * The environment run.sh had when it started bwrap must not be visible inside:
 * a bwrap process that stays in the sandbox's PID namespace, such as its PID 1
 * reaper, keeps the environment it was executed with in /proc/PID/environ,
 * whatever --clearenv gives the sandboxed command.
 */
export async function launcherEnvAbsent(
  procRoot: string,
  canary: string,
): Promise<ProbeResult> {
  const probe = "proc-launcher-env-absent";
  let read = 0;
  const holding: string[] = [];
  for (const pid of await pids(procRoot)) {
    const environ = await readOr(join(procRoot, pid, "environ"));
    if (environ === undefined) {
      continue;
    }
    read += 1;
    if (environ.split("\0").some((entry) => entry.startsWith(`${canary}=`))) {
      holding.push(`${pid} (${await processName(join(procRoot, pid))})`);
    }
  }
  return holding.length === 0
    ? {
        probe,
        result: "pass",
        detail: `no readable environment holds ${canary}; ${read} read`,
      }
    : {
        probe,
        result: "fail",
        detail: `${canary} is in the environment of ${listOf(holding)}`,
      };
}

/** No process inside may expose bwrap's own command line, with its host paths. */
export async function launcherArgvAbsent(
  procRoot: string,
): Promise<ProbeResult> {
  const probe = "proc-launcher-argv-absent";
  const exposing: string[] = [];
  for (const pid of await pids(procRoot)) {
    const argv = (await readOr(join(procRoot, pid, "cmdline")))?.split("\0");
    if (
      argv !== undefined &&
      (basename(argv[0] ?? "") === "bwrap" || argv.includes("--unshare-all"))
    ) {
      exposing.push(`${pid} (${await processName(join(procRoot, pid))})`);
    }
  }
  return exposing.length === 0
    ? {
        probe,
        result: "pass",
        detail: "no visible process carries bwrap's arguments",
      }
    : {
        probe,
        result: "fail",
        detail: `bwrap's arguments are visible in /proc/PID/cmdline of ${listOf(exposing)}`,
      };
}

async function pids(procRoot: string): Promise<string[]> {
  try {
    return (await readdir(procRoot)).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
}

export function noCapabilities(status: string | undefined): ProbeResult {
  const probe = "proc-no-capabilities";
  const effective = /^CapEff:\s*([0-9a-f]+)$/m.exec(status ?? "")?.[1];
  if (effective === undefined) {
    return { probe, result: "fail", detail: "cannot read CapEff" };
  }
  return /^0+$/.test(effective)
    ? { probe, result: "pass", detail: `CapEff ${effective}` }
    : { probe, result: "fail", detail: `CapEff ${effective}` };
}

/**
 * The entry script must hold no descriptor beyond stdio and its own script,
 * which bash keeps open on a high descriptor of its choosing.
 */
export async function parentFdsClean(
  procRoot: string,
  pid: number,
  allowedFds: readonly number[],
  allowedTargets: readonly string[],
): Promise<ProbeResult> {
  const probe = "proc-entry-fds-clean";
  const dir = join(procRoot, String(pid), "fd");
  let fds: string[];
  try {
    fds = await readdir(dir);
  } catch (error) {
    return { probe, result: "fail", detail: `${dir}: ${errorCode(error)}` };
  }
  const extra: string[] = [];
  for (const fd of fds.filter((entry) => !allowedFds.includes(Number(entry)))) {
    const target = await readlink(join(dir, fd)).catch(() => "?");
    if (!allowedTargets.includes(target)) {
      extra.push(`${fd} -> ${target}`);
    }
  }
  return extra.length === 0
    ? { probe, result: "pass", detail: `descriptors: ${listOf(fds)}` }
    : {
        probe,
        result: "fail",
        detail: `extra descriptors: ${listOf(extra)}`,
      };
}

/** Parses the probe configuration and names the first missing or mistyped field. */
export function parseProbeConfig(text: string): ProbeConfig {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("probe config: expected an object");
  }
  const record = value as Record<string, unknown>;
  const strings = [
    "hostHome",
    "sandboxHome",
    "sandboxUser",
    "brokerSocket",
    "allowedTarget",
    "deniedTarget",
    "launcherCanary",
  ] as const;
  const numbers = ["hostUid", "bridgePort"] as const;
  const lists = [
    "allowedEnv",
    "writable",
    "readOnly",
    "allowedProcesses",
  ] as const;
  for (const key of strings) {
    if (typeof record[key] !== "string") {
      throw new Error(`probe config: ${key} must be a string`);
    }
  }
  for (const key of numbers) {
    if (!Number.isInteger(record[key])) {
      throw new Error(`probe config: ${key} must be an integer`);
    }
  }
  for (const key of lists) {
    const list = record[key];
    if (
      !Array.isArray(list) ||
      !list.every((item) => typeof item === "string")
    ) {
      throw new Error(`probe config: ${key} must be a list of strings`);
    }
  }
  return record as unknown as ProbeConfig;
}

/** Joins a list for a detail line, capped so a leak cannot flood the output. */
function listOf(items: readonly string[], limit = 12): string {
  return items.length <= limit
    ? items.join(", ")
    : `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

function combine(probe: string, parts: readonly ProbeResult[]): ProbeResult {
  const failed = parts.filter((part) => part.result === "fail");
  return {
    probe,
    result: failed.length === 0 ? "pass" : "fail",
    detail: (failed.length === 0 ? parts : failed)
      .map((part) => `${part.probe}: ${part.detail}`)
      .join("; "),
  };
}

async function tryWrite(dir: string): Promise<"written" | string> {
  const file = join(dir, `.forgecrew-probe-${process.pid}`);
  try {
    await writeFile(file, "", { flag: "wx" });
  } catch (error) {
    return errorCode(error);
  }
  await rm(file, { force: true });
  return "written";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readOr(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function openApiVersion(body: string): string | undefined {
  try {
    const document: unknown = JSON.parse(body);
    if (
      typeof document === "object" &&
      document !== null &&
      "openapi" in document
    ) {
      const { openapi } = document;
      return typeof openapi === "string" ? openapi : undefined;
    }
  } catch {
    // Not JSON: no OpenAPI document.
  }
  return undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    return (error as NodeJS.ErrnoException).code ?? error.message;
  }
  return String(error);
}

import { createSocket } from "node:dgram";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBridge } from "./bridge.ts";
import { createBrokerStub } from "./broker-stub.ts";
import { createEgressProxy } from "./egress-proxy.ts";
import {
  brokerServesOpenApi,
  dnsLookupBlocked,
  dnsServerBlocked,
  envConfined,
  launcherArgvAbsent,
  launcherEnvAbsent,
  noAbstractSockets,
  noCapabilities,
  onlyDirEntries,
  onlyLoopback,
  onlyPasswdUsers,
  type ProbeResult,
  parentFdsClean,
  parseProbeConfig,
  pathsAbsent,
  processesConfined,
  proxyAnswers,
  runProbeTable,
  sandboxProbeNames,
  sandboxProbes,
  tcpBlocked,
  writesAccepted,
  writesRefused,
} from "./probes.ts";
import {
  cleanUp,
  closedPort,
  listen,
  onCleanUp,
  portOf,
  startTcpEcho,
  tempDir,
} from "./test-support.ts";

afterEach(cleanUp);

// Each probe must pass when the sandbox holds and fail when it leaks, so each
// is tested both ways where the leak can be staged outside a sandbox.

describe("tcpBlocked", () => {
  it("passes when the connection fails", async () => {
    const result = await tcpBlocked("tcp", "127.0.0.1", await closedPort());
    expect(result).toMatchObject({ probe: "tcp", result: "pass" });
  });

  it("fails when the connection succeeds", async () => {
    const { port } = await startTcpEcho();
    const result = await tcpBlocked("tcp", "127.0.0.1", port);
    expect(result).toMatchObject({ probe: "tcp", result: "fail" });
  });
});

describe("dnsLookupBlocked", () => {
  it("passes when the name does not resolve", async () => {
    const result = await dnsLookupBlocked("dns", "forgecrew-probe.invalid");
    expect(result).toMatchObject({ result: "pass" });
  });

  it("fails when the name resolves", async () => {
    const result = await dnsLookupBlocked("dns", "localhost");
    expect(result).toMatchObject({ result: "fail" });
  });
});

describe("dnsServerBlocked", () => {
  it("passes when the server cannot be reached", async () => {
    const server = `127.0.0.1:${await closedPort()}`;
    const result = await dnsServerBlocked("dns", "example.com", server);
    expect(result).toMatchObject({ result: "pass" });
  });

  it("fails when the server answers", async () => {
    const server = await startDnsResponder("192.0.2.7");
    const result = await dnsServerBlocked("dns", "example.com", server);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("192.0.2.7");
  });
});

describe("runProbeTable", () => {
  it("reports each result in order, under the probe's table name", async () => {
    const seen: ProbeResult[] = [];
    await runProbeTable(
      [
        ["first", () => ({ probe: "first", result: "pass", detail: "ok" })],
        [
          "renamed",
          async () => ({ probe: "inner", result: "info", detail: "x" }),
        ],
      ],
      (result) => seen.push(result),
    );
    expect(seen).toEqual([
      { probe: "first", result: "pass", detail: "ok" },
      { probe: "renamed", result: "info", detail: "x" },
    ]);
  });

  it("turns a probe that throws into its failure and runs the rest", async () => {
    const seen: ProbeResult[] = [];
    await runProbeTable(
      [
        [
          "broken",
          async () => {
            throw new Error("boom");
          },
        ],
        ["last", () => ({ probe: "last", result: "pass", detail: "ok" })],
      ],
      (result) => seen.push(result),
    );
    expect(seen).toEqual([
      { probe: "broken", result: "fail", detail: "the probe threw: boom" },
      { probe: "last", result: "pass", detail: "ok" },
    ]);
  });
});

describe("sandboxProbes", () => {
  it("holds exactly the probes sandboxProbeNames lists, in that order", () => {
    const config = parseProbeConfig(
      JSON.stringify({
        hostHome: "/home/operator",
        hostUid: 1000,
        sandboxHome: "/home/sandbox",
        sandboxUser: "sandbox",
        bridgePort: 3128,
        brokerSocket: "/run/forgecrew/broker.sock",
        allowedTarget: "api.anthropic.com:443",
        deniedTarget: "example.com:443",
        allowedEnv: [],
        writable: [],
        readOnly: [],
        allowedProcesses: [],
        launcherCanary: "FORGECREW_LAUNCH_CANARY",
      }),
    );
    expect(sandboxProbes(config).map(([name]) => name)).toEqual([
      ...sandboxProbeNames,
    ]);
  });
});

describe("onlyLoopback", () => {
  it("passes with only internal addresses", () => {
    const result = onlyLoopback({ lo: [address("127.0.0.1", true)] });
    expect(result).toMatchObject({ probe: "net-interfaces", result: "pass" });
  });

  it("fails and names any external interface", () => {
    const result = onlyLoopback({
      lo: [address("127.0.0.1", true)],
      eth0: [address("192.0.2.10", false)],
    });
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("eth0");
  });
});

describe("noAbstractSockets", () => {
  const header = "Num       RefCount Protocol Flags    Type St Inode Path\n";

  it("passes when no abstract socket is visible", () => {
    const text = `${header}0000000000000000: 00000002 00000000 00010000 0001 01 1234 /run/forgecrew/proxy.sock\n`;
    expect(noAbstractSockets(text)).toMatchObject({ result: "pass" });
  });

  it("fails when an abstract socket is visible", () => {
    const text = `${header}0000000000000000: 00000002 00000000 00010000 0001 01 1234 @/tmp/.X11-unix/X0\n`;
    const result = noAbstractSockets(text);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("@/tmp/.X11-unix/X0");
  });
});

describe("proxyAnswers", () => {
  it("passes when the proxy answers with the expected status", async () => {
    const { port, allowed, denied } = await startChain();
    expect(await proxyAnswers("allow", port, allowed, 200)).toMatchObject({
      result: "pass",
    });
    expect(await proxyAnswers("deny", port, denied, 403)).toMatchObject({
      result: "pass",
    });
  });

  it("fails and reports the status when it differs", async () => {
    const { port, denied } = await startChain();
    const result = await proxyAnswers("allow", port, denied, 200);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("403");
  });

  it("fails when nothing listens", async () => {
    const result = await proxyAnswers(
      "allow",
      await closedPort(),
      "example.com:443",
      200,
    );
    expect(result).toMatchObject({ result: "fail" });
  });
});

describe("brokerServesOpenApi", () => {
  it("passes when the broker serves its description", async () => {
    const socketPath = join(await tempDir(), "broker.sock");
    const broker = createBrokerStub({ log: () => {} });
    await listen(broker.server, { path: socketPath });
    onCleanUp(() => broker.close());

    expect(await brokerServesOpenApi(socketPath)).toMatchObject({
      probe: "broker-reachable",
      result: "pass",
    });
  });

  it("fails when the socket serves something else", async () => {
    const socketPath = join(await tempDir(), "other.sock");
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    await listen(server, { path: socketPath });
    onCleanUp(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    expect(await brokerServesOpenApi(socketPath)).toMatchObject({
      result: "fail",
    });
  });

  it("fails when the socket is missing", async () => {
    const socketPath = join(await tempDir(), "missing.sock");
    expect(await brokerServesOpenApi(socketPath)).toMatchObject({
      result: "fail",
    });
  });
});

describe("pathsAbsent", () => {
  it("passes when no path exists", async () => {
    const dir = await tempDir();
    const result = await pathsAbsent("absent", [join(dir, "nope")]);
    expect(result).toMatchObject({ result: "pass" });
  });

  it("fails and lists the paths that exist", async () => {
    const dir = await tempDir();
    const present = join(dir, ".ssh");
    await mkdir(present);
    const result = await pathsAbsent("absent", [present, join(dir, "nope")]);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain(present);
    expect(result.detail).not.toContain("nope");
  });
});

describe("onlyDirEntries", () => {
  it("passes when the directory holds only the allowed entries", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "sandbox"));
    expect(await onlyDirEntries("home", dir, ["sandbox"])).toMatchObject({
      result: "pass",
    });
  });

  it("fails and names the extra entries", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "sandbox"));
    await mkdir(join(dir, "alice"));
    const result = await onlyDirEntries("home", dir, ["sandbox"]);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("alice");
  });
});

describe("onlyPasswdUsers", () => {
  it("passes with only the allowed users", () => {
    const passwd = "sandbox:x:1000:1000::/home/sandbox:/bin/bash\n";
    expect(onlyPasswdUsers(passwd, ["sandbox"])).toMatchObject({
      result: "pass",
    });
  });

  it("fails and names other users", () => {
    const passwd =
      "root:x:0:0::/root:/bin/bash\nsandbox:x:1000:1000::/home/sandbox:/bin/bash\n";
    const result = onlyPasswdUsers(passwd, ["sandbox"]);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("root");
  });
});

describe("envConfined", () => {
  it("passes when every variable is expected", () => {
    const result = envConfined({ HOME: "/home/sandbox", PATH: "/usr/bin" }, [
      "HOME",
      "PATH",
    ]);
    expect(result).toMatchObject({ probe: "env-host-absent", result: "pass" });
  });

  it("fails and names unexpected variables, never their values", () => {
    const result = envConfined(
      { HOME: "/home/sandbox", AWS_SECRET_ACCESS_KEY: "s3cr3t" },
      ["HOME"],
    );
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("AWS_SECRET_ACCESS_KEY");
    expect(result.detail).not.toContain("s3cr3t");
  });
});

describe("writesRefused and writesAccepted", () => {
  const isRoot = process.getuid?.() === 0;

  it("report a writable directory as writable", async () => {
    const dir = await tempDir();
    expect(await writesRefused([dir])).toMatchObject({
      probe: "fs-writes-refused",
      result: "fail",
    });
    expect(await writesAccepted([dir])).toMatchObject({
      probe: "fs-writes-accepted",
      result: "pass",
    });
  });

  it.skipIf(isRoot)("report a read-only directory as refused", async () => {
    const dir = join(await tempDir(), "readonly");
    await mkdir(dir);
    await chmod(dir, 0o555);
    onCleanUp(() => chmod(dir, 0o755));

    expect(await writesRefused([dir])).toMatchObject({ result: "pass" });
    expect(await writesAccepted([dir])).toMatchObject({ result: "fail" });
  });

  it("count a missing directory as refused", async () => {
    const dir = join(await tempDir(), "missing");
    expect(await writesRefused([dir])).toMatchObject({ result: "pass" });
  });
});

describe("processesConfined", () => {
  it("passes when every visible process is expected", async () => {
    const proc = await fakeProc({ "1": "bwrap", "2": "bash", "7": "node" });
    expect(
      await processesConfined(proc, ["bwrap", "bash", "node"]),
    ).toMatchObject({ result: "pass" });
  });

  it("fails and names unexpected processes", async () => {
    const proc = await fakeProc({ "1": "systemd", "2": "bash" });
    const result = await processesConfined(proc, ["bwrap", "bash"]);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("1:systemd");
  });

  it("names a process by its argv[0], since Node 24 names its main thread MainThread", async () => {
    const proc = await fakeProc(
      { "1": "bwrap", "2": "bash", "3": "MainThread" },
      {},
      {
        "1": ["bwrap", "--unshare-all"],
        "2": ["/bin/bash", "/opt/forgecrew/spike/sandbox-entry.sh"],
        "3": ["node", "/opt/forgecrew/spike/cli.ts", "bridge"],
      },
    );
    expect(
      await processesConfined(proc, ["bwrap", "bash", "node"]),
    ).toMatchObject({
      result: "pass",
      detail: "visible: 1:bwrap, 2:bash, 3:node",
    });
  });

  it("fails on an unexpected argv[0] whatever the process name", async () => {
    const proc = await fakeProc(
      { "1": "node" },
      {},
      { "1": ["/usr/lib/systemd/systemd", "--user"] },
    );
    const result = await processesConfined(proc, ["node"]);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("1:systemd");
  });
});

describe("launcherEnvAbsent", () => {
  const canary = "FORGECREW_LAUNCH_CANARY";

  it("fails and names every process whose environment holds the launcher's canary", async () => {
    const proc = await fakeProc(
      { "1": "bwrap", "2": "bash" },
      {},
      {},
      {
        "1": [`${canary}=1`, "PATH=/usr/bin"],
        "2": ["HOME=/home/sandbox"],
      },
    );

    const result = await launcherEnvAbsent(proc, canary);

    expect(result).toMatchObject({
      probe: "proc-launcher-env-absent",
      result: "fail",
    });
    expect(result.detail).toContain("1 (bwrap)");
    expect(result.detail).not.toContain("2 (bash)");
  });

  it("passes when no readable environment holds it, and counts what it read", async () => {
    const proc = await fakeProc(
      { "1": "bash", "2": "node" },
      {},
      {},
      { "1": ["HOME=/home/sandbox"], "2": ["PATH=/usr/bin"] },
    );

    expect(await launcherEnvAbsent(proc, canary)).toEqual({
      probe: "proc-launcher-env-absent",
      result: "pass",
      detail: `no readable environment holds ${canary}; 2 read`,
    });
  });
});

describe("launcherArgvAbsent", () => {
  it("fails when a visible process carries bwrap's arguments", async () => {
    const proc = await fakeProc(
      { "1": "bwrap", "2": "bash" },
      {},
      {
        "1": ["bwrap", "--unshare-all", "--bind", "/home/operator/run", "/out"],
        "2": ["/bin/bash", "/opt/forgecrew/spike/sandbox-entry.sh"],
      },
    );

    const result = await launcherArgvAbsent(proc);

    expect(result).toMatchObject({
      probe: "proc-launcher-argv-absent",
      result: "fail",
    });
    expect(result.detail).toContain("1 (bwrap)");
  });

  it("passes when no visible process carries them", async () => {
    const proc = await fakeProc(
      { "1": "bash" },
      {},
      { "1": ["/bin/bash", "/opt/forgecrew/spike/sandbox-entry.sh"] },
    );

    expect(await launcherArgvAbsent(proc)).toMatchObject({
      probe: "proc-launcher-argv-absent",
      result: "pass",
    });
  });
});

describe("noCapabilities", () => {
  it("passes when the effective set is empty", () => {
    const status = "Name:\tnode\nCapEff:\t0000000000000000\n";
    expect(noCapabilities(status)).toMatchObject({ result: "pass" });
  });

  it("fails when any capability is effective", () => {
    const status = "Name:\tnode\nCapEff:\t0000000000000400\n";
    expect(noCapabilities(status)).toMatchObject({ result: "fail" });
  });

  it("fails when the set cannot be read", () => {
    expect(noCapabilities("Name:\tnode\n")).toMatchObject({ result: "fail" });
  });
});

describe("parentFdsClean", () => {
  const entry = "/opt/forgecrew/spike/sandbox-entry.sh";

  it("passes with stdio and the entry script, whatever its descriptor", async () => {
    const proc = await fakeProc(
      { "2": "bash" },
      {
        "2": {
          "0": "/dev/null",
          "1": "/out/log",
          "2": "/out/log",
          "254": entry,
        },
      },
    );
    expect(await parentFdsClean(proc, 2, [0, 1, 2], [entry])).toMatchObject({
      result: "pass",
    });
  });

  it("fails and names any other descriptor with its target", async () => {
    const proc = await fakeProc(
      { "2": "bash" },
      {
        "2": {
          "0": "/dev/null",
          "1": "/out/log",
          "2": "/out/log",
          "3": "pipe:[1234]",
        },
      },
    );
    const result = await parentFdsClean(proc, 2, [0, 1, 2], [entry]);
    expect(result).toMatchObject({ result: "fail" });
    expect(result.detail).toContain("3 -> pipe:[1234]");
  });
});

describe("parseProbeConfig", () => {
  const valid = {
    hostHome: "/home/operator",
    hostUid: 1000,
    sandboxHome: "/home/sandbox",
    sandboxUser: "sandbox",
    bridgePort: 3128,
    brokerSocket: "/run/forgecrew/broker.sock",
    allowedTarget: "api.anthropic.com:443",
    deniedTarget: "example.com:443",
    allowedEnv: ["HOME"],
    writable: ["/tmp"],
    readOnly: ["/usr"],
    allowedProcesses: ["bwrap"],
    launcherCanary: "FORGECREW_LAUNCH_CANARY",
  };

  it("accepts a complete configuration", () => {
    expect(parseProbeConfig(JSON.stringify(valid))).toEqual(valid);
  });

  it("names a missing or mistyped field", () => {
    const { bridgePort: _, ...missing } = valid;
    expect(() => parseProbeConfig(JSON.stringify(missing))).toThrow(
      "bridgePort",
    );
    expect(() =>
      parseProbeConfig(JSON.stringify({ ...valid, writable: "/tmp" })),
    ).toThrow("writable");
  });
});

function address(value: string, internal: boolean) {
  return {
    address: value,
    netmask: "255.0.0.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${value}/8`,
  };
}

/** A directory shaped like /proc with the given processes, descriptors and arguments. */
async function fakeProc(
  comms: Record<string, string>,
  fds: Record<string, Record<string, string>> = {},
  argvs: Record<string, string[]> = {},
  environs: Record<string, string[]> = {},
): Promise<string> {
  const root = await tempDir();
  for (const [pid, comm] of Object.entries(comms)) {
    await mkdir(join(root, pid, "fd"), { recursive: true });
    await writeFile(join(root, pid, "comm"), `${comm}\n`);
    const argv = argvs[pid];
    if (argv !== undefined) {
      await writeFile(join(root, pid, "cmdline"), `${argv.join("\0")}\0`);
    }
    const environ = environs[pid];
    if (environ !== undefined) {
      await writeFile(join(root, pid, "environ"), `${environ.join("\0")}\0`);
    }
    for (const [fd, target] of Object.entries(fds[pid] ?? {})) {
      await symlink(target, join(root, pid, "fd", fd));
    }
  }
  await mkdir(join(root, "self"));
  return root;
}

/** An echo upstream, the egress proxy allowing it, and the bridge in front. */
async function startChain() {
  const upstream = await startTcpEcho();
  const allowed = `127.0.0.1:${upstream.port}`;
  const dir = await tempDir();
  const proxySocket = join(dir, "proxy.sock");
  const proxy = createEgressProxy({ allow: [allowed], log: () => {} });
  await listen(proxy.server, { path: proxySocket });
  onCleanUp(() => proxy.close());
  const bridge = createBridge({ socketPath: proxySocket, log: () => {} });
  await listen(bridge.server, { host: "127.0.0.1", port: 0 });
  onCleanUp(() => bridge.close());
  return {
    port: portOf(bridge.server),
    allowed,
    denied: `127.0.0.1:${await closedPort()}`,
  };
}

/** A DNS server on 127.0.0.1 that answers every query with one A record. */
async function startDnsResponder(address: string): Promise<string> {
  const server = createSocket("udp4");
  server.on("message", (query, peer) => {
    let end = 12;
    while (end < query.length && query[end] !== 0) {
      end += (query[end] ?? 0) + 1;
    }
    const question = query.subarray(12, end + 5);
    const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    query.copy(header, 0, 0, 2);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]);
    const ip = Buffer.from(address.split(".").map(Number));
    server.send(
      Buffer.concat([header, question, answer, ip]),
      peer.port,
      peer.address,
    );
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  onCleanUp(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `127.0.0.1:${server.address().port}`;
}

// Turns a run directory into a short report: how the harness ended, what
// egress the proxy saw, which probes failed, and what the harness wrote to
// HOME and the workspace. run.sh prints it and saves it as summary.txt.
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { sandboxProbeNames } from "./probes.ts";

const paths = {
  stream: "sandbox-out/stream.jsonl",
  runnerProbes: "host/probes.jsonl",
  harnessExit: "sandbox-out/harness-exit-code",
  harnessStarted: "sandbox-out/harness-started-at",
  sandboxExit: "host/bwrap-exit-code",
  proxy: "host/proxy.jsonl",
  probes: "probes.jsonl",
  home: "host/home-files.tsv",
  workspace: "host/workspace-files.tsv",
} as const;

const listingLimit = 40;

/** Probes the shell scripts report: the sandbox entry, the hook and the runner. */
export const shellProbeNames = [
  "token-absent-from-sandbox-argv",
  "token-in-harness-environ",
  "hook-env-names",
  "hook-env-token-absent",
  "hook-harness-environ-unreadable",
  "token-absent-from-host-argv",
  "token-absent-from-outputs",
  "token-absent-from-home",
] as const;

/** Every probe a complete run reports; a missing one counts as a failure. */
export const expectedProbeNames: readonly string[] = [
  ...sandboxProbeNames,
  ...shellProbeNames,
];

/** The kit's own logs, shown when not empty: the entry script, the probes and the services. */
const kitLogs = [
  "host/bwrap.log",
  "sandbox-out/probes.stderr",
  "sandbox-out/bridge.stderr",
  "host/proxy.stderr",
  "host/broker.stderr",
] as const;

export async function summarize(runDir: string): Promise<string> {
  const refused: string[] = [];
  const read = async (path: string) => {
    const result = await readRegularFile(join(runDir, path));
    if (result.refused !== undefined) {
      refused.push(`${path} (${result.refused})`);
    }
    return result.content;
  };
  const files = {
    probes: await read(paths.probes),
    runnerProbes: await read(paths.runnerProbes),
    stream: await read(paths.stream),
    harnessExit: (await read(paths.harnessExit))?.trim(),
    sandboxExit: (await read(paths.sandboxExit))?.trim(),
    proxy: await read(paths.proxy),
    harnessStarted: (await read(paths.harnessStarted))?.trim(),
    kitLogs: await Promise.all(
      kitLogs.map(async (path) => ({ path, content: await read(path) })),
    ),
    home: await read(paths.home),
    workspace: await read(paths.workspace),
  };
  // The summary is written after the token scans, so it quotes free text from
  // the run's files only when the scan of those files passed. The verdict comes
  // from host/probes.jsonl, which only run.sh writes: the merged probes.jsonl
  // also holds lines the sandbox wrote, and a line there could be forged.
  const quote = jsonLines(files.runnerProbes ?? "").some(
    (entry) =>
      entry.probe === "token-absent-from-outputs" && entry.result === "pass",
  );
  const sections = [
    `Forgecrew bwrap spike, run directory ${runDir}`,
    ...(refused.length === 0
      ? []
      : [
          `Refused to read, because they are not regular files: ${refused.sort().join(", ")}`,
        ]),
    ...(quote
      ? []
      : [
          "The outputs scan did not pass, so this summary quotes neither the harness's text nor the kit's logs.",
        ]),
    harnessSection(files.stream, files.harnessExit, files.sandboxExit, quote),
    egressSection(files.proxy, files.harnessStarted),
    probesSection(files.probes),
    kitLogsSection(files.kitLogs, quote),
    listingSection("HOME", paths.home, files.home),
    listingSection("Workspace", paths.workspace, files.workspace),
  ];
  return withoutControlCharacters(`${sections.join("\n\n")}\n`);
}

/**
 * Replaces every control character except the newline with "?". File names
 * and probe details come partly from the sandbox, and the summary goes to the
 * operator's terminal, where an escape sequence would act.
 */
function withoutControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const control = code < 32 || (code >= 127 && code < 160);
      return control && character !== "\n" ? "?" : character;
    })
    .join("");
}

/**
 * Reads a file only if it is a regular file, without following a symbolic link
 * or waiting on a FIFO. The sandbox can write sandbox-out/, so a link there
 * could point at a host file the sandbox itself cannot read.
 */
async function readRegularFile(
  path: string,
): Promise<{ content?: string; refused?: string }> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ELOOP" ? { refused: "symbolic link" } : {};
  }
  try {
    if (!(await handle.stat()).isFile()) {
      return { refused: "not a regular file" };
    }
    return { content: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

function harnessSection(
  stream: string | undefined,
  harnessExit: string | undefined,
  sandboxExit: string | undefined,
  quote: boolean,
): string {
  const lines = [
    "Harness",
    `  exit status: ${harnessExit ?? "unknown"} (sandbox: ${sandboxExit ?? "unknown"})`,
  ];
  if (stream === undefined) {
    lines.push(`  missing ${paths.stream}`);
    return lines.join("\n");
  }
  const events = jsonLines(stream);
  const init = events.find(
    (event) => event.type === "system" && event.subtype === "init",
  );
  const result = events.findLast((event) => event.type === "result");
  lines.push(
    init === undefined
      ? "  no init event in the stream"
      : `  version ${text(init.claude_code_version)}, model ${text(init.model)}, credential source ${text(init.apiKeySource)}`,
  );
  if (result === undefined) {
    lines.push("  no result event in the stream");
  } else {
    const turns = Number(result.num_turns);
    lines.push(
      `  result: ${text(result.subtype)}${result.is_error === true ? ", flagged is_error," : ""}` +
        ` after ${turns} turn${turns === 1 ? "" : "s"} in ${text(result.duration_ms)} ms` +
        (quote
          ? `: ${truncate(text(result.result), 200)}`
          : " (text withheld)"),
    );
  }
  return lines.join("\n");
}

function egressSection(
  log: string | undefined,
  harnessStartedAt: string | undefined,
): string {
  if (log === undefined) {
    return `Egress through the proxy\n  missing ${paths.proxy}`;
  }
  const entries = jsonLines(log);
  const attempts = entries.filter((entry) => entry.event === "attempt");
  const duringHarness = (entry: Json) =>
    harnessStartedAt !== undefined && text(entry.time) >= harnessStartedAt;
  const harness = attempts.filter(duringHarness);
  const probes = attempts.filter((entry) => !duringHarness(entry));

  const lines = ["Egress through the proxy"];
  if (harnessStartedAt === undefined) {
    lines.push(
      `  all attempts (missing ${paths.harnessStarted}): ${counts(attempts)}`,
    );
    lines.push(...targetLines(attempts, entries));
    return lines.join("\n");
  }
  lines.push(`  while the harness ran: ${counts(harness)}`);
  lines.push(...targetLines(harness, entries));
  lines.push(`  before the harness, from the probes: ${counts(probes)}`);
  return lines.join("\n");
}

function counts(attempts: readonly Json[]): string {
  const allowed = attempts.filter((entry) => entry.decision === "allow").length;
  return `${allowed} allowed, ${attempts.length - allowed} denied`;
}

/** One line per target: tunnels and bytes when allowed, attempts when denied. */
function targetLines(
  attempts: readonly Json[],
  entries: readonly Json[],
): string[] {
  const closedById = new Map(
    entries
      .filter((entry) => entry.event === "closed")
      .map((entry) => [entry.id, entry]),
  );
  const byTarget = new Map<
    string,
    { decision: string; count: number; up: number; down: number }
  >();
  for (const entry of attempts) {
    const key = `${text(entry.decision)} ${text(entry.target)}`;
    const totals = byTarget.get(key) ?? {
      decision: text(entry.decision),
      count: 0,
      up: 0,
      down: 0,
    };
    const closed = closedById.get(entry.id);
    totals.count += 1;
    totals.up += Number(closed?.bytesUp ?? 0);
    totals.down += Number(closed?.bytesDown ?? 0);
    byTarget.set(key, totals);
  }
  return [...byTarget].map(([key, totals]) => {
    const [, target] = key.split(" ");
    return totals.decision === "allow"
      ? `    allowed ${target}: ${plural(totals.count, "tunnel")}, ${totals.up} bytes up, ${totals.down} down`
      : `    denied ${target}: ${plural(totals.count, "attempt")}`;
  });
}

function probesSection(probes: string | undefined): string {
  if (probes === undefined) {
    return `Probes\n  missing ${paths.probes}`;
  }
  const results = jsonLines(probes);
  const count = (result: string) =>
    results.filter((entry) => entry.result === result).length;
  const reported = new Set(results.map((entry) => text(entry.probe)));
  const missing = expectedProbeNames.filter((name) => !reported.has(name));
  const failed = count("fail") + missing.length;
  const missingNote = missing.length > 0 ? ` (${missing.length} missing)` : "";
  const lines = [
    `Probes: ${count("pass")} pass, ${failed} fail${missingNote}, ${count("info")} info`,
  ];
  if (missing.length > 0) {
    lines.push(`  fail  missing: ${missing.join(", ")}`);
  }
  for (const outcome of ["fail", "info"]) {
    for (const entry of results.filter((item) => item.result === outcome)) {
      lines.push(
        `  ${outcome.padEnd(4)}  ${text(entry.probe)}: ${text(entry.detail)}`,
      );
    }
  }
  return lines.join("\n");
}

function kitLogsSection(
  logs: ReadonlyArray<{ path: string; content: string | undefined }>,
  quote: boolean,
): string {
  const written = logs.filter(({ content }) => (content ?? "").trim() !== "");
  if (written.length === 0) {
    return "Kit logs: all empty";
  }
  if (!quote) {
    return `Kit logs: excerpts withheld from ${written.map(({ path }) => path).join(", ")}`;
  }
  return [
    "Kit logs",
    ...written.map(({ path, content }) => {
      const firstLines = (content ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 3)
        .join(" | ");
      return `  ${path}: ${truncate(firstLines, 300)}`;
    }),
  ].join("\n");
}

/** What the harness wrote to a directory, from a listing run.sh made: paths and sizes. */
function listingSection(
  name: string,
  path: string,
  listing: string | undefined,
): string {
  if (listing === undefined) {
    return `${name} after the run\n  missing ${path}`;
  }
  const rows = listing
    .split("\n")
    .slice(1)
    .filter((row) => row.length > 0)
    .map((row) => {
      const [type = "", , size = "0", ...path] = row.split("\t");
      return { type, size: Number(size), path: path.join("\t") };
    });
  const files = rows.filter((row) => row.type === "f");
  const directories = rows.filter((row) => row.type === "d").length;
  const bytes = files.reduce((sum, row) => sum + row.size, 0);
  const lines = [
    `${name} after the run: ${plural(files.length, "file")}, ${plural(directories, "directory", "directories")}, ${bytes} bytes (${path})`,
    ...rows
      .filter((row) => row.type !== "d")
      .slice(0, listingLimit)
      .map(
        (row) =>
          `  ${row.path}  ${row.type === "f" ? row.size : `(type ${row.type})`}`,
      ),
  ];
  const rest = rows.filter((row) => row.type !== "d").length - listingLimit;
  if (rest > 0) {
    lines.push(`  and ${rest} more`);
  }
  return lines.join("\n");
}

type Json = Record<string, unknown>;

function jsonLines(content: string): Json[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null
          ? [value as Json]
          : [];
      } catch {
        return [];
      }
    });
}

function text(value: unknown): string {
  return value === undefined || value === null ? "unknown" : String(value);
}

function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectedProbeNames, summarize } from "./summarize.ts";
import { cleanUp, tempDir } from "./test-support.ts";

afterEach(cleanUp);

describe("summarize", () => {
  it("reports the harness outcome from the stream and the exit codes", async () => {
    const run = await runDir({
      "probes.jsonl": probeLines({}),
      ...runnerScan("pass"),
      "sandbox-out/stream.jsonl": lines(
        {
          type: "system",
          subtype: "init",
          model: "claude-test",
          apiKeySource: "none",
          claude_code_version: "2.1.300",
        },
        { type: "assistant", message: {} },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          duration_ms: 4200,
          result: "pong",
        },
      ),
      "sandbox-out/harness-exit-code": "0\n",
      "host/bwrap-exit-code": "0\n",
    });

    const summary = await summarize(run);

    expect(summary).toContain("exit status: 0 (sandbox: 0)");
    expect(summary).toContain(
      "version 2.1.300, model claude-test, credential source none",
    );
    expect(summary).toContain("result: success after 1 turn in 4200 ms: pong");
  });

  it("marks a result the stream flags as an error", async () => {
    const run = await runDir({
      "probes.jsonl": probeLines({}),
      ...runnerScan("pass"),
      "sandbox-out/stream.jsonl": lines({
        type: "result",
        subtype: "success",
        is_error: true,
        num_turns: 1,
        duration_ms: 2010,
        result: "Failed to authenticate. API Error: 401",
      }),
    });

    const summary = await summarize(run);

    expect(summary).toContain(
      "result: success, flagged is_error, after 1 turn in 2010 ms: Failed to authenticate. API Error: 401",
    );
  });

  it("splits egress into the probes' attempts and the harness's", async () => {
    const run = await runDir({
      "sandbox-out/harness-started-at": "2026-10-06T10:00:10.000Z\n",
      "host/proxy.jsonl": lines(
        { time: "2026-10-06T10:00:00.000Z", event: "listening" },
        attempt(
          1,
          "2026-10-06T10:00:05.000Z",
          "api.anthropic.com:443",
          "allow",
        ),
        attempt(2, "2026-10-06T10:00:06.000Z", "example.com:443", "deny"),
        attempt(
          3,
          "2026-10-06T10:00:11.000Z",
          "api.anthropic.com:443",
          "allow",
        ),
        {
          time: "2026-10-06T10:00:15.000Z",
          id: 3,
          event: "closed",
          target: "api.anthropic.com:443",
          bytesUp: 512,
          bytesDown: 2048,
          durationMs: 4000,
        },
        attempt(4, "2026-10-06T10:00:12.000Z", "statsig.example:443", "deny"),
      ),
    });

    const summary = await summarize(run);

    expect(summary).toContain("while the harness ran: 1 allowed, 1 denied");
    expect(summary).toContain(
      "allowed api.anthropic.com:443: 1 tunnel, 512 bytes up, 2048 down",
    );
    expect(summary).toContain("denied statsig.example:443: 1 attempt");
    expect(summary).toContain(
      "before the harness, from the probes: 1 allowed, 1 denied",
    );
  });

  it("counts probe results and lists every failure and observation", async () => {
    const run = await runDir({
      "probes.jsonl": probeLines({
        "hook-env-token-absent": { result: "fail", detail: "set" },
        "token-in-harness-environ": { result: "info", detail: "present" },
      }),
    });

    const summary = await summarize(run);

    const passing = expectedProbeNames.length - 2;
    expect(summary).toContain(`Probes: ${passing} pass, 1 fail, 1 info`);
    expect(summary).toContain("fail  hook-env-token-absent: set");
    expect(summary).toContain("info  token-in-harness-environ: present");
    expect(summary).not.toContain("net-dns-system");
  });

  it("fails every expected probe that reported nothing", async () => {
    const hookProbes = [
      "hook-env-names",
      "hook-env-token-absent",
      "hook-harness-environ-unreadable",
    ];
    const run = await runDir({
      "probes.jsonl": probeLines({}, hookProbes),
    });

    const summary = await summarize(run);

    const passing = expectedProbeNames.length - hookProbes.length;
    expect(summary).toContain(
      `Probes: ${passing} pass, 3 fail (3 missing), 0 info`,
    );
    expect(summary).toContain(`fail  missing: ${hookProbes.join(", ")}`);
  });

  it("shows the kit's own logs when they are not empty", async () => {
    const run = await runDir({
      "probes.jsonl": probeLines({}),
      ...runnerScan("pass"),
      "sandbox-out/probes.stderr": "TypeError: boom\n    at probe\n",
      "host/bwrap.log": "",
    });

    const summary = await summarize(run);

    expect(summary).toContain(
      "Kit logs\n  sandbox-out/probes.stderr: TypeError: boom | at probe",
    );
    expect(summary).not.toContain("host/bwrap.log:");
  });

  it("quotes neither the harness's text nor the kit's logs unless the outputs scan passed", async () => {
    const files = {
      "sandbox-out/stream.jsonl": lines({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        duration_ms: 900,
        result: "quoted harness text",
      }),
      "sandbox-out/probes.stderr": "quoted log line\n",
    };
    const cases: Array<Record<string, string>> = [
      // the runner's scan failed
      {
        "probes.jsonl": probeLines({
          "token-absent-from-outputs": {
            result: "fail",
            detail: "files holding the token: sandbox-out/probes.stderr",
          },
        }),
        ...runnerScan("fail"),
      },
      // the runner's scan is missing
      { "probes.jsonl": probeLines({}, ["token-absent-from-outputs"]) },
      // the sandbox forged a passing scan in the files it can write
      {
        "probes.jsonl": probeLines({}),
        "sandbox-out/hook-probes.jsonl": lines({
          probe: "token-absent-from-outputs",
          result: "pass",
          detail: "no file holds the token",
        }),
        ...runnerScan("fail"),
      },
    ];
    for (const probes of cases) {
      const summary = await summarize(await runDir({ ...files, ...probes }));

      expect(summary).toContain(
        "The outputs scan did not pass, so this summary quotes neither the harness's text nor the kit's logs.",
      );
      expect(summary).not.toContain("quoted harness text");
      expect(summary).not.toContain("quoted log line");
      expect(summary).toContain(
        "result: success after 1 turn in 900 ms (text withheld)",
      );
      expect(summary).toContain(
        "Kit logs: excerpts withheld from sandbox-out/probes.stderr",
      );
    }
  });

  it("never follows a link the sandbox could have planted", async () => {
    const outside = join(await tempDir(), "host-secret.txt");
    await writeFile(outside, "host-secret-content\n");
    const run = await runDir({
      "probes.jsonl": probeLines({}),
      ...runnerScan("pass"),
      "sandbox-out/stream.jsonl": lines({ type: "result", subtype: "success" }),
    });
    await symlink(outside, join(run, "sandbox-out", "probes.stderr"));
    await symlink(outside, join(run, "sandbox-out", "harness-exit-code"));

    const summary = await summarize(run);

    expect(summary).not.toContain("host-secret-content");
    expect(summary).toContain(
      "Refused to read, because they are not regular files: sandbox-out/harness-exit-code (symbolic link), sandbox-out/probes.stderr (symbolic link)",
    );
    expect(summary).toContain("exit status: unknown");
  });

  it("refuses a FIFO instead of waiting on it", async () => {
    const run = await runDir({
      "probes.jsonl": probeLines({}),
      ...runnerScan("pass"),
    });
    const fifo = join(run, "sandbox-out", "stream.jsonl");
    await mkdir(join(run, "sandbox-out"), { recursive: true });
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    const summary = await summarize(run);

    expect(summary).toContain("sandbox-out/stream.jsonl (not a regular file)");
  });

  it("prints no control character the sandbox could have planted", async () => {
    const terminalTrick = "\u001b[2J\u001b]0;owned\u0007";
    const run = await runDir({
      "probes.jsonl": probeLines({
        "hook-env-names": { result: "info", detail: `NAME${terminalTrick}` },
      }),
      "host/home-files.tsv": `type\tmode\tsize\tpath\nf\t600\t1\tevil${terminalTrick}name\n`,
    });

    const summary = await summarize(run);

    const controls = [...summary].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code !== 10 && (code < 32 || (code >= 127 && code < 160));
    });
    expect(controls).toEqual([]);
    expect(summary).toContain("evil?[2J?]0;owned?name");
  });

  it("says when the kit wrote no log", async () => {
    const run = await runDir({ "host/bwrap.log": "" });

    expect(await summarize(run)).toContain("Kit logs: all empty");
  });

  it("lists what the harness wrote to HOME, by path and size", async () => {
    const run = await runDir({
      "host/home-files.tsv": [
        "type\tmode\tsize\tpath",
        "d\t700\t4096\t.claude",
        "f\t600\t120\t.claude.json",
        "f\t600\t30\t.claude/settings.json",
        "",
      ].join("\n"),
    });

    const summary = await summarize(run);

    expect(summary).toContain(
      "HOME after the run: 2 files, 1 directory, 150 bytes",
    );
    expect(summary).toContain("  .claude.json  120");
    expect(summary).toContain("  .claude/settings.json  30");
  });

  it("lists what the harness wrote to the workspace", async () => {
    const run = await runDir({
      "host/workspace-files.tsv": [
        "type\tmode\tsize\tpath",
        "f\t600\t0\t.env",
        "d\t700\t4096\tnode_modules",
        "",
      ].join("\n"),
    });

    const summary = await summarize(run);

    expect(summary).toContain(
      "Workspace after the run: 1 file, 1 directory, 0 bytes (host/workspace-files.tsv)",
    );
    expect(summary).toContain("  .env  0");
  });

  it("names what is missing from an incomplete run", async () => {
    const run = await runDir({});

    const summary = await summarize(run);

    expect(summary).toContain("missing sandbox-out/stream.jsonl");
    expect(summary).toContain("missing host/proxy.jsonl");
    expect(summary).toContain("missing probes.jsonl");
    expect(summary).toContain("missing host/home-files.tsv");
    expect(summary).toContain("missing host/workspace-files.tsv");
  });
});

function attempt(
  id: number,
  time: string,
  target: string,
  decision: "allow" | "deny",
) {
  return {
    time,
    id,
    event: "attempt",
    method: "CONNECT",
    target,
    decision,
    ...(decision === "deny" ? { reason: "not-allowed" } : {}),
  };
}

/** The outputs scan as run.sh writes it to host/probes.jsonl, which the sandbox cannot write. */
function runnerScan(result: "pass" | "fail"): Record<string, string> {
  return {
    "host/probes.jsonl": lines({
      probe: "token-absent-from-outputs",
      result,
      detail:
        result === "pass"
          ? "no file holds the token"
          : "files holding the token: sandbox-out/probes.stderr",
    }),
  };
}

/** One passing line per expected probe, with overrides, leaving out the omitted ones. */
function probeLines(
  overrides: Record<string, { result: string; detail: string }>,
  omitted: readonly string[] = [],
): string {
  return lines(
    ...expectedProbeNames
      .filter((probe) => !omitted.includes(probe))
      .map((probe) => ({
        probe,
        ...(overrides[probe] ?? { result: "pass", detail: "ok" }),
      })),
  );
}

function lines(...entries: object[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

async function runDir(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

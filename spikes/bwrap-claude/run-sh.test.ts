import { spawnSync } from "node:child_process";
import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUp, tempDir } from "./test-support.ts";

afterEach(cleanUp);

// The runner needs Linux and bwrap for a real run, so these tests cover what
// runs anywhere: argument handling, token validation, the refusal to run
// elsewhere, and the bwrap command that --dry-run prints.

const spikeDir = fileURLToPath(new URL(".", import.meta.url));
const runSh = join(spikeDir, "run.sh");
const scripts = ["run.sh", "sandbox-entry.sh", "hook-probe.sh", "lib.sh"];
const fakeToken = "sk-ant-oat01-FAKE-TOKEN-FOR-TESTS";

describe("run.sh", () => {
  it("prints usage with --help", () => {
    const { status, stdout } = run(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("usage: run.sh --token-file PATH");
  });

  it("requires --token-file", () => {
    const { status, stderr } = run([]);
    expect(status).toBe(2);
    expect(stderr).toContain("--token-file is required");
  });

  it("rejects an unknown option", () => {
    const { status, stderr } = run(["--nope"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unknown option --nope");
  });

  it.each([
    ["an empty token file", ""],
    ["a token file with two lines", "first\nsecond\n"],
    ["a token with spaces", "sk-ant oat01\n"],
  ])("rejects %s", async (_name, content) => {
    const { tokenFile } = await fixtures(content);
    const { status, stderr } = run(["--token-file", tokenFile, "--dry-run"]);
    expect(status).toBe(2);
    expect(stderr).toContain("token file");
  });

  it("refuses to run with xtrace on, before reading the token", async () => {
    const { tokenFile } = await fixtures(`${fakeToken}\n`);
    const result = spawnSync("bash", ["-x", runSh, "--token-file", tokenFile], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("xtrace");
    expect(result.stderr).not.toContain(fakeToken);
  });

  it.runIf(process.platform !== "linux")(
    "refuses a real run outside Linux",
    async () => {
      const { tokenFile } = await fixtures(`${fakeToken}\n`);
      const { status, stderr } = run(["--token-file", tokenFile]);
      expect(status).toBe(1);
      expect(stderr).toContain("needs Linux");
    },
  );

  describe("with --dry-run", () => {
    it("prints a bwrap command that unshares everything and starts clean", async () => {
      const { stdout } = await dryRun();
      for (const flag of [
        "--unshare-all",
        "--unshare-user",
        "--as-pid-1",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
      ]) {
        expect(args(stdout)).toContain(flag);
      }
    });

    it("starts bwrap through env -i and timeout", async () => {
      const { stdout } = await dryRun();
      expect(stdout.split("\n")[0]).toBe(
        "env -i timeout --kill-after=10 300 bwrap \\",
      );
    });

    it("never puts the token on the command line", async () => {
      const { stdout, stderr } = await dryRun();
      expect(stdout).not.toContain(fakeToken);
      expect(stderr).not.toContain(fakeToken);
    });

    it("mounts a fresh HOME, tmp and workspace, and the sockets, and makes the root read-only", async () => {
      const { stdout, out } = await dryRun();
      const command = args(stdout);
      expect(pairAfter(command, "--bind", `${out}/home`)).toBe("/home/sandbox");
      expect(pairAfter(command, "--bind", `${out}/tmp`)).toBe("/tmp");
      expect(pairAfter(command, "--bind", `${out}/workspace`)).toBe(
        "/workspace",
      );
      expect(command).toContain("/run/forgecrew/proxy.sock");
      expect(command).toContain("/run/forgecrew/broker.sock");
      expect(command.indexOf("--remount-ro")).toBeGreaterThan(
        command.lastIndexOf("--ro-bind"),
      );
      expect(pairAfter(command, "--setenv", "HOME")).toBe("/home/sandbox");
    });

    it("binds the given harness and node binaries read-only", async () => {
      const { stdout, claude } = await dryRun();
      expect(pairAfter(args(stdout), "--ro-bind", await realpath(claude))).toBe(
        "/opt/forgecrew/bin/claude",
      );
      expect(
        pairAfter(args(stdout), "--ro-bind", await realpath(process.execPath)),
      ).toBe("/opt/forgecrew/bin/node");
    });

    it("ends with the sandbox entry, its settings and the prompt", async () => {
      const { stdout } = await dryRun(["--prompt", "Say hi", "--no-scrub"]);
      expect(args(stdout).slice(-5)).toEqual([
        "/bin/bash",
        "/opt/forgecrew/spike/sandbox-entry.sh",
        "3128",
        "0",
        "Say hi",
      ]);
    });
  });
});

describe("the shell scripts", () => {
  it.each(scripts)("%s parses", (script) => {
    const result = spawnSync("bash", ["-n", join(spikeDir, script)], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  const shellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
  // CI installs shellcheck with the runner image; a missing one fails there.
  it.skipIf(!shellcheck && process.env.CI !== "true")("pass shellcheck", () => {
    const result = spawnSync("shellcheck", ["--external-sources", ...scripts], {
      cwd: spikeDir,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });
});

function run(argv: string[]) {
  const result = spawnSync("bash", [runSh, ...argv], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function fixtures(token: string) {
  const dir = await tempDir();
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const claude = join(dir, "claude");
  await writeFile(claude, "");
  await chmod(claude, 0o755);
  return { dir, tokenFile, claude };
}

async function dryRun(extra: string[] = []) {
  const { dir, tokenFile, claude } = await fixtures(`${fakeToken}\n`);
  const out = join(dir, "run");
  const result = run([
    "--token-file",
    tokenFile,
    "--claude",
    claude,
    "--node",
    process.execPath,
    "--out",
    out,
    "--dry-run",
    ...extra,
  ]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return { ...result, out, claude };
}

/** Lets bash parse the printed command back into its arguments. */
function args(stdout: string): string[] {
  const parsed = spawnSync("bash", ["-c", `printf '%s\\0' ${stdout}`], {
    encoding: "utf8",
  });
  expect(parsed.status).toBe(0);
  return parsed.stdout.split("\0").slice(0, -1);
}

/** The argument that follows `first` where `flag` precedes it. */
function pairAfter(command: string[], flag: string, first: string): string {
  for (let index = 0; index < command.length - 2; index += 1) {
    if (command[index] === flag && command[index + 1] === first) {
      return command[index + 2] ?? "";
    }
  }
  return "";
}

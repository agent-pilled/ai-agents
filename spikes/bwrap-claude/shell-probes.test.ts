import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseProbeConfig } from "./probes.ts";
import { shellProbeNames } from "./summarize.ts";
import { cleanUp, onCleanUp, tempDir } from "./test-support.ts";

afterEach(cleanUp);

// The probes the shell scripts report, each staged with a leak and without
// one. The fake token reaches every script through the environment, never as
// an argument, because the argv samplers would otherwise see the test itself.

const spikeDir = fileURLToPath(new URL(".", import.meta.url));
const fakeToken = "sk-ant-oat01-FAKE-SHELL-PROBE-TOKEN";
const bashVersion = spawnSync("bash", [
  "-c",
  "echo $((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1]))",
]);
// mapfile -d needs bash 4.4; /proc needs Linux.
const modernBash = Number(bashVersion.stdout.toString()) >= 404;
const withProc = modernBash && process.platform === "linux";
const isRoot = process.getuid?.() === 0;

describe("the shell probes", () => {
  it("are exactly the ones the summary expects", async () => {
    const reported = new Set<string>();
    for (const script of ["run.sh", "sandbox-entry.sh", "hook-probe.sh"]) {
      const source = await readFile(join(spikeDir, script), "utf8");
      const names = /(?:probe_line|scan_for_token) ([a-z0-9-]+)/g;
      for (const match of source.matchAll(names)) {
        reported.add(match[1] ?? "");
      }
    }

    expect([...reported].sort()).toEqual([...shellProbeNames].sort());
  });
});

describe("read_token in run.sh", () => {
  it("keeps the token out of child environments even if the caller exported a variable named token", async () => {
    const tokenFile = join(await tempDir(), "token");
    await writeFile(tokenFile, `${fakeToken}\n`, { mode: 0o600 });

    const output = runBash(
      `source "$KIT/run.sh"
       token_file=$TOKEN_FILE
       read_token
       printf 'parent read %s characters\n' "\${#token}"
       bash -c 'printf "child sees %s\n" "\${token-nothing}"'`,
      { TOKEN_FILE: tokenFile, token: "exported-by-the-caller" },
    );

    expect(output).toBe(
      `parent read ${fakeToken.length} characters\nchild sees nothing\n`,
    );
  });
});

describe("write_probe_config in run.sh", () => {
  it("writes a configuration the probes accept, naming the launcher's canary", () => {
    const output = runBash(
      `source "$KIT/run.sh"
       allow=(api.anthropic.com:443)
       write_probe_config 1000`,
      { HOME: "/home/operator" },
    );

    expect(parseProbeConfig(output)).toMatchObject({
      hostHome: "/home/operator",
      hostUid: 1000,
      allowedTarget: "api.anthropic.com:443",
      launcherCanary: "FORGECREW_LAUNCH_CANARY",
    });
  });
});

describe("the launch in run.sh", () => {
  it("hands bwrap an empty environment, so the canary stays out", async () => {
    const dir = await tempDir();
    const fakeTimeout = join(dir, "timeout");
    const fakeBwrap = join(dir, "bwrap");
    await writeFile(fakeTimeout, '#!/bin/sh\nshift 2\nexec "$@"\n', {
      mode: 0o755,
    });
    await writeFile(fakeBwrap, "#!/bin/sh\nexec /usr/bin/env\n", {
      mode: 0o755,
    });

    const output = runBash(
      `source "$KIT/run.sh"
       export FORGECREW_LAUNCH_CANARY=set-by-test
       timeout_bin=$FAKE_TIMEOUT bwrap_bin=$FAKE_BWRAP timeout_s=5
       build_launch_command
       "\${launch[@]}" --fake-bwrap-argument`,
      { FAKE_TIMEOUT: fakeTimeout, FAKE_BWRAP: fakeBwrap },
    );

    const names = output
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.slice(0, line.indexOf("=")));
    expect(names).not.toContain("FORGECREW_LAUNCH_CANARY");
    expect(names).not.toContain("TOKEN");
    expect(names).not.toContain("HOME");
  });
});

describe("merge_probe_results in run.sh", () => {
  it("merges only regular files and never follows a link the sandbox planted", async () => {
    const dir = await tempDir();
    const outside = join(await tempDir(), "host-secret.jsonl");
    await writeFile(
      outside,
      '{"probe":"x","result":"pass","detail":"host-secret-content"}\n',
    );
    await mkdir(join(dir, "sandbox-out"));
    await mkdir(join(dir, "host"));
    await writeFile(
      join(dir, "sandbox-out", "probes.jsonl"),
      '{"probe":"inside"}\n',
    );
    await symlink(outside, join(dir, "sandbox-out", "hook-probes.jsonl"));
    await writeFile(join(dir, "host", "probes.jsonl"), '{"probe":"host"}\n');

    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "$KIT/run.sh"
         run_dir=$DIR sandbox_out=$DIR/sandbox-out host_dir=$DIR/host
         merge_probe_results`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          KIT: spikeDir,
          DIR: dir,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      "run.sh: warning: skipped sandbox-out/hook-probes.jsonl: not a regular file\n",
    );
    expect(await readFile(join(dir, "probes.jsonl"), "utf8")).toBe(
      '{"probe":"inside"}\n{"probe":"host"}\n',
    );
  });
});

describe("scan_for_token in run.sh", () => {
  it("passes when no file holds the token", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "home"));
    await writeFile(join(dir, "home", "clean.txt"), "nothing here\n");

    expect(await scan(dir)).toEqual({
      probe: "token-absent-from-home",
      result: "pass",
      detail: "no file holds the token",
    });
  });

  it("fails and names the file that holds the token", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "home", ".claude"), { recursive: true });
    await writeFile(
      join(dir, "home", ".claude", "leak.json"),
      `{"t":"${fakeToken}"}`,
    );

    expect(await scan(dir)).toEqual({
      probe: "token-absent-from-home",
      result: "fail",
      detail: "files holding the token: home/.claude/leak.json",
    });
  });

  it.skipIf(isRoot)("fails when it cannot read a file", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "home"));
    const locked = join(dir, "home", "locked.txt");
    await writeFile(locked, fakeToken);
    await chmod(locked, 0o000);
    onCleanUp(() => chmod(locked, 0o600));

    const result = await scan(dir);

    expect(result).toMatchObject({
      probe: "token-absent-from-home",
      result: "fail",
    });
    expect(result.detail).toContain("scan incomplete");
    expect(result.detail).toContain("home/locked.txt");
  });

  function scan(dir: string) {
    return lastProbe(
      runBash(
        `source "$KIT/run.sh"
         token=$TOKEN
         run_dir=$DIR
         scan_for_token token-absent-from-home "$DIR/home"`,
        { DIR: dir },
      ),
    );
  }
});

describe.runIf(withProc)("sample_host_argv in run.sh", () => {
  it("fails and names the process whose arguments hold the token", () => {
    const output = runBash(
      `source "$KIT/run.sh"
       token=$TOKEN
       bash -c 'sleep 1; :' holder "$token" &
       holder=$!
       sample_host_argv "$holder"
       echo "holder=$holder"`,
    );
    const holder = /holder=(\d+)/.exec(output)?.[1];

    expect(probes(output)).toContainEqual({
      probe: "token-absent-from-host-argv",
      result: "fail",
      detail: `the token appeared in the arguments of /proc/${holder}`,
    });
  });

  it("passes when no process argument holds the token", () => {
    const output = runBash(
      `source "$KIT/run.sh"
       token=$TOKEN
       sleep 1 &
       sample_host_argv "$!"`,
    );

    expect(lastProbe(output)).toMatchObject({
      probe: "token-absent-from-host-argv",
      result: "pass",
    });
  });
});

describe("take_token in sandbox-entry.sh", () => {
  it("is the first thing to run: no command starts while descriptor 3 holds the token", async () => {
    const dir = await tempDir();
    const shims = join(dir, "shims");
    const log = join(dir, "started.log");
    await mkdir(shims);
    for (const name of [
      "dirname",
      "basename",
      "readlink",
      "realpath",
      "cat",
      "grep",
      "date",
      "sleep",
      "node",
    ]) {
      await writeFile(
        join(shims, name),
        `#!/bin/sh\necho ${name} >> "$SHIM_LOG"\n`,
        {
          mode: 0o755,
        },
      );
    }
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, fakeToken, { mode: 0o600 });

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `exec 3< "$TOKEN_FILE"
         source "$KIT/sandbox-entry.sh"
         take_token
         echo "read \${#token} characters"`,
      ],
      {
        env: {
          PATH: shims,
          KIT: spikeDir,
          TOKEN_FILE: tokenFile,
          SHIM_LOG: log,
        },
        encoding: "utf8",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`read ${fakeToken.length} characters\n`);
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  });
});

describe.runIf(withProc)("watch_harness in sandbox-entry.sh", () => {
  it("finds the token in the harness's environment but not in any argument", () => {
    const output = runBash(
      `source "$KIT/sandbox-entry.sh"
       token=$TOKEN
       exe=$(readlink -f "$(command -v sleep)")
       CLAUDE_CODE_OAUTH_TOKEN=$token sleep 1 &
       watch_harness "$!" "$exe"`,
    );

    expect(probes(output)).toEqual([
      expect.objectContaining({
        probe: "token-absent-from-sandbox-argv",
        result: "pass",
      }),
      {
        probe: "token-in-harness-environ",
        result: "info",
        detail: "present, as designed until credentials are injected at egress",
      },
    ]);
  });

  it("reports a harness environment without the token", () => {
    const output = runBash(
      `source "$KIT/sandbox-entry.sh"
       token=$TOKEN
       exe=$(readlink -f "$(command -v sleep)")
       sleep 1 &
       watch_harness "$!" "$exe"`,
    );

    expect(probes(output)[1]).toEqual({
      probe: "token-in-harness-environ",
      result: "info",
      detail: "absent from the harness environment at its start",
    });
  });

  it("fails and names, once, the process whose arguments hold the token", () => {
    const output = runBash(
      `source "$KIT/sandbox-entry.sh"
       token=$TOKEN
       bash -c 'sleep 1; :' holder "$token" &
       holder=$!
       watch_harness "$holder" /nonexistent
       echo "holder=$holder"`,
    );
    const holder = /holder=(\d+)/.exec(output)?.[1];

    expect(probes(output)[0]).toEqual({
      probe: "token-absent-from-sandbox-argv",
      result: "fail",
      detail: `the token appeared in the arguments of /proc/${holder}`,
    });
  });
});

describe.runIf(modernBash)("hook-probe.sh", () => {
  it("fails when the token is in the hook's own environment", async () => {
    const results = await runHook({ CLAUDE_CODE_OAUTH_TOKEN: fakeToken });

    expect(results).toContainEqual({
      probe: "hook-env-token-absent",
      result: "fail",
      detail: "CLAUDE_CODE_OAUTH_TOKEN is set in the hook's environment",
    });
  });

  it("passes without the token and lists the variable names it received", async () => {
    const results = await runHook({ FORGECREW_TEST_MARKER: "1" });

    expect(results).toContainEqual({
      probe: "hook-env-token-absent",
      result: "pass",
      detail: "CLAUDE_CODE_OAUTH_TOKEN is not set in the hook's environment",
    });
    const names = results.find((result) => result.probe === "hook-env-names");
    expect(names?.result).toBe("info");
    expect(names?.detail.split(",")).toContain("FORGECREW_TEST_MARKER");
  });

  it.runIf(withProc)(
    "fails when any other process's environment holds the token, ancestor or not",
    async () => {
      const holder = spawnHolder();

      const results = await runHook({});

      expect(results).toContainEqual(
        expect.objectContaining({
          probe: "hook-harness-environ-unreadable",
          result: "fail",
        }),
      );
      const detail = results.find(
        (result) => result.probe === "hook-harness-environ-unreadable",
      )?.detail;
      expect(detail).toContain(`${holder.pid} (sleep)`);
    },
  );

  // A developer's machine may run Claude Code with the variable set, so only
  // CI, where nothing else holds it, checks the clean case.
  it.runIf(withProc && process.env.CI === "true")(
    "passes when no readable environment holds the token",
    async () => {
      const results = await runHook({});

      expect(results).toContainEqual(
        expect.objectContaining({
          probe: "hook-harness-environ-unreadable",
          result: "pass",
        }),
      );
    },
  );

  async function runHook(env: Record<string, string>) {
    const out = join(await tempDir(), "hook-probes.jsonl");
    const result = spawnSync("bash", [join(spikeDir, "hook-probe.sh"), out], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      input: "{}",
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return probes(await readFile(out, "utf8"));
  }

  /** A process outside the hook's ancestry whose environment holds the token. */
  function spawnHolder(): ChildProcess {
    const holder = spawn("sleep", ["5"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CLAUDE_CODE_OAUTH_TOKEN: fakeToken,
      },
      stdio: "ignore",
    });
    onCleanUp(async () => {
      holder.kill("SIGKILL");
    });
    return holder;
  }
});

interface Probe {
  probe: string;
  result: string;
  detail: string;
}

/** Runs a bash script with the kit's directory and the fake token in its environment. */
function runBash(script: string, env: Record<string, string> = {}): string {
  const result = spawnSync("bash", ["-c", script], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      KIT: spikeDir,
      TOKEN: fakeToken,
      ...env,
    },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

function probes(output: string): Probe[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Probe);
}

function lastProbe(output: string): Probe {
  const all = probes(output);
  const last = all[all.length - 1];
  if (last === undefined) {
    throw new Error(`no probe line in: ${output}`);
  }
  return last;
}

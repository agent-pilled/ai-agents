import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha } from "../../../core/domain/index.ts";
import type { PublishOutcome } from "../../../core/ports/index.ts";

export interface Push {
  /** The repository's Git URL. */
  readonly url: string;
  /** An installation token that may push to the repository. */
  readonly token: string;
  /** A local Git repository that holds `head`. */
  readonly source: string;
  readonly head: Sha;
  readonly branch: string;
  readonly expectedHead: Sha;
}

/**
 * Pushes `head` to `branch`, unless the branch no longer points at
 * `expectedHead`.
 *
 * The push runs in an empty scratch repository that borrows `source`'s
 * objects, so the token never reaches a Git process that reads `source`'s
 * configuration or hooks, which a pass may have written. The token travels in
 * an HTTP header set through the environment, never in a URL or an argument.
 */
export async function push({
  url,
  token,
  source,
  head,
  branch,
  expectedHead,
}: Push): Promise<PublishOutcome> {
  const { stdout: commonDir } = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: source },
  );
  const scratch = await mkdtemp(join(tmpdir(), "forgecrew-push-"));
  try {
    await git(["init", "--bare", "--quiet", scratch]);
    await writeFile(
      join(scratch, "objects", "info", "alternates"),
      `${join(commonDir.trim(), "objects")}\n`,
    );

    const ref = `refs/heads/${branch}`;
    const result = await git(
      [
        "push",
        "--porcelain",
        `--force-with-lease=${ref}:${expectedHead}`,
        url,
        `${head}:${ref}`,
      ],
      { cwd: scratch, env: authorization(url, token), check: false },
    );
    if (result.code === 0) return "published";
    if (/^!\t.*\(stale info\)$/m.test(result.stdout)) return "stale-head";
    throw new Error(`git push to ${url} failed: ${result.stderr.trim()}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Git's extra-header setting, scoped to the repository's URL. GitHub accepts an
// installation token as the password of the user `x-access-token`.
function authorization(url: string, token: string): Record<string, string> {
  const credentials = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  };
}

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs Git without the machine's system or global configuration, which could
 * rewrite URLs or add credential helpers, and without prompting.
 */
function git(
  args: readonly string[],
  {
    cwd,
    env = {},
    check = true,
  }: { cwd?: string; env?: Record<string, string>; check?: boolean } = {},
): Promise<Result> {
  const environment = {
    ...withoutGitVariables(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    ...env,
  };
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: environment },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        if (!check && typeof error.code === "number") {
          return resolve({ code: error.code, stdout, stderr });
        }
        reject(
          new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`),
        );
      },
    );
  });
}

// Inherited GIT_DIR and friends would point every command at another
// repository, and inherited GIT_CONFIG_* entries would add configuration.
function withoutGitVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

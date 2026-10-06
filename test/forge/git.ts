import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";
import type { Sha } from "../../src/core/domain/index.ts";

/**
 * A local repository whose `branch` points at `base`, with one more commit,
 * `next`, on top of it on another branch: the commit a dispatcher publishes.
 */
export interface LocalRepository {
  readonly path: string;
  readonly base: Sha;
  readonly next: Sha;
}

export async function localRepository(
  branch: string,
): Promise<LocalRepository> {
  const path = await temporaryDirectory("forgecrew-source-");
  await git(path, "init", "--quiet", "--initial-branch", branch);
  await git(path, "commit", "--quiet", "--allow-empty", "--message", "Base");
  const base = await git(path, "rev-parse", "HEAD");
  await git(path, "switch", "--quiet", "--create", "next");
  await git(path, "commit", "--quiet", "--allow-empty", "--message", "Next");
  const next = await git(path, "rev-parse", "HEAD");
  return { path, base, next };
}

/** A directory removed when the current test finishes. */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * Runs Git with a fictional author and without the machine's own
 * configuration, such as commit signing, so the tests behave the same
 * everywhere.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, {
    cwd,
    env: {
      ...withoutGitVariables(process.env),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Example Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "Example Author",
      GIT_COMMITTER_EMAIL: "author@example.com",
    },
  });
  return stdout.trim();
}

// A test run from a Git hook inherits GIT_DIR and friends, which would point
// every command at the hook's repository.
function withoutGitVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

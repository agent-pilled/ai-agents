import {
  access,
  constants,
  mkdir,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Secret } from "./secret.ts";

// Where the App's ID and private key land. The key is a credential that acts as
// a role, so it is written for its owner alone, never overwrites a file, and
// is named in the operator's next step rather than printed.

/** Raised for a file-system problem. The message never quotes the key. */
export class CredentialsError extends Error {}

export interface SavedCredentials {
  readonly appIdPath: string;
  readonly privateKeyPath: string;
}

export interface CredentialsToSave {
  readonly id: number;
  /** Names the files; without a usable slug they are named after the ID alone. */
  readonly slug: string | undefined;
  readonly privateKey: Secret;
}

/**
 * Checks that the directory can take the files, and creates it for its owner
 * alone if it is missing. Run it before the flow starts: the temporary code
 * works once, so a failure to save afterwards costs the operator the key.
 */
export async function prepareOutputDirectory(dir: string): Promise<void> {
  const existing = await nearestExistingAncestor(dir);
  if (await insideGitWorkTree(existing)) {
    throw new CredentialsError(
      `${dir} is inside a Git work tree, where a private key could be committed by mistake. Choose a directory outside any repository.`,
    );
  }

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // mkdir -p reports a file in the way as EEXIST, or ENOTDIR higher up.
    throw new CredentialsError(
      ["EEXIST", "ENOTDIR"].includes(errorCode(error))
        ? `${dir} is not a directory.`
        : `Could not create ${dir} (${errorCode(error)}).`,
    );
  }
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new CredentialsError(`Cannot write to ${dir}.`);
  }
}

export async function saveCredentials(
  dir: string,
  app: CredentialsToSave,
): Promise<SavedCredentials> {
  const stem = join(dir, `${app.slug ?? "app"}-${app.id}`);
  const appIdPath = `${stem}.app-id`;
  const privateKeyPath = `${stem}.private-key.pem`;

  await createPrivateFile(appIdPath, `${app.id}\n`);
  const key = app.privateKey.reveal();
  await createPrivateFile(
    privateKeyPath,
    key.endsWith("\n") ? key : `${key}\n`,
  );

  return { appIdPath, privateKeyPath };
}

// `wx` fails on an existing file instead of replacing it. The mode is set
// again after opening because the umask can only remove permission bits at
// creation, never grant them, and an explicit chmod makes 0600 independent of
// it.
async function createPrivateFile(
  path: string,
  contents: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    throw new CredentialsError(
      errorCode(error) === "EEXIST"
        ? `${path} already exists and was left untouched.`
        : `Could not create ${path} (${errorCode(error)}).`,
    );
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents);
  } catch (error) {
    await rm(path, { force: true });
    throw new CredentialsError(
      `Could not write ${path} (${errorCode(error)}).`,
    );
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : "unknown error";
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

// A repository root has `.git` as a directory, a linked worktree as a file.
async function insideGitWorkTree(start: string): Promise<boolean> {
  let current = start;
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return true;
    } catch {
      // No .git here; look one level up.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

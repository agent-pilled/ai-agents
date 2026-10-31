import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * The tiny program the operator pushes, and the issue and patches the script
 * reads from this checkout. The patches are not part of the demo repository.
 */

const run = promisify(execFile);

const templateRoot = fileURLToPath(new URL("./template/", import.meta.url));

export interface ProjectFile {
  readonly path: string;
  readonly content: string;
}

export const FIX_PATCH = "01-fix-add.patch";
export const NOTE_PATCH = "02-document-add.patch";

/** The files that belong on the demo repository's default branch. */
export async function projectFiles(): Promise<ProjectFile[]> {
  return readTree(templateRoot, true);
}

export function patchFile(name: string): string {
  return join(templateRoot, "patches", name);
}

/** The issue the operator's token files. The first line is the title. */
export async function demoIssue(): Promise<{ title: string; body: string }> {
  const text = await readFile(join(templateRoot, "ISSUE.md"), "utf8");
  const [title, ...rest] = text.replace(/\n$/, "").split("\n");
  const body = rest.join("\n").replace(/^\n/, "").replace(/\n$/, "");
  if (title === undefined || title.trim() === "" || body.trim() === "") {
    throw new Error("tools/demo/template/ISSUE.md needs a title and a body");
  }
  return { title, body };
}

/** Applies one unified diff and returns the whole tree afterwards. */
export async function applyPatch(
  files: readonly ProjectFile[],
  patch: string,
): Promise<ProjectFile[]> {
  const directory = await mkdtemp(join(tmpdir(), "forgecrew-patch-"));
  try {
    await writeTree(directory, files);
    await run("git", ["apply", "--whitespace=nowarn", patch], {
      cwd: directory,
      env: gitEnv(),
    });
    // Await before `finally` removes the directory. A bare return would let
    // the read race the cleanup.
    return await readTree(directory, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readTree(
  root: string,
  skipDemoMeta: boolean,
): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (skipDemoMeta && (path === "ISSUE.md" || path.startsWith("patches/"))) {
      continue;
    }
    files.push({ path, content: await readFile(absolute, "utf8") });
  }
  return files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

async function writeTree(
  root: string,
  files: readonly ProjectFile[],
): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

// Apply must not pick up a developer's commit signing or hooks.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}

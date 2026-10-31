import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { DemoSide } from "./scenario.ts";

/**
 * The demo's side operations on GitHub. The operator's token files the issue
 * and nothing else. dev-bot pushes, opens the pull request and forges checks.
 * qa-bot reads the tree at the head and runs the repository's tests there.
 * The same client talks to the in-memory simulator in tests.
 */

const run = promisify(execFile);

export interface AppCredentials {
  readonly appId: number | string;
  readonly privateKey: string;
}

export interface GitHubDemoSideOptions {
  readonly repository: string;
  readonly operatorToken: string;
  readonly dev: AppCredentials;
  readonly qa: AppCredentials;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function githubDemoSide(options: GitHubDemoSideOptions): DemoSide {
  const apiUrl = options.apiUrl ?? "https://api.github.com";
  const { owner, repo } = splitRepository(options.repository);
  const request = options.fetch === undefined ? {} : { fetch: options.fetch };

  const installation = (credentials: AppCredentials): Promise<Octokit> => {
    const app = new App({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      Octokit: Octokit.defaults({ baseUrl: apiUrl, request }),
    });
    return (async () => {
      const { data } = await app.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      return app.getInstallationOctokit(data.id);
    })();
  };

  let devClient: Promise<Octokit> | undefined;
  let qaClient: Promise<Octokit> | undefined;
  const dev = () => (devClient ??= installation(options.dev));
  const qa = () => (qaClient ??= installation(options.qa));

  const operator = new Octokit({
    auth: options.operatorToken,
    baseUrl: apiUrl,
    request,
  });

  return {
    repository: options.repository,

    async openIssue(title, body) {
      const { data } = await operator.rest.issues.create({
        owner,
        repo,
        title,
        body,
      });
      return { number: data.number };
    },

    async createBranchWithCommit({ branch, base, message, files }) {
      const octokit = await dev();
      const sha = await commitFiles(octokit, owner, repo, {
        message,
        files,
        parentRef: `heads/${base}`,
      });
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
      return { sha };
    },

    async addCommit({ branch, message, files }) {
      const octokit = await dev();
      const sha = await commitFiles(octokit, owner, repo, {
        message,
        files,
        parentRef: `heads/${branch}`,
      });
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha,
      });
      return { sha };
    },

    async openPullRequest({ title, body, head, base }) {
      const octokit = await dev();
      const { data } = await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body,
        head,
        base,
        draft: false,
      });
      return {
        number: data.number,
        headSha: data.head.sha,
        draft: data.draft ?? false,
        body: data.body ?? "",
      };
    },

    async createCheckRunAsDev(name, headSha) {
      const octokit = await dev();
      await octokit.rest.checks.create({
        owner,
        repo,
        name,
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
        completed_at: timestamp(),
        output: {
          title: "Forged check",
          summary:
            "Created by dev-bot. A ruleset that binds this context to another App must ignore it.",
        },
      });
    },

    async runTests(headSha) {
      const octokit = await qa();
      const directory = await materialize(octokit, owner, repo, headSha);
      try {
        await run(process.execPath, ["--test"], {
          cwd: directory,
          timeout: 30_000,
          encoding: "utf8",
        });
      } catch (error) {
        const stdout = streamOf(error, "stdout");
        const stderr = streamOf(error, "stderr");
        throw new Error(
          `tests failed at ${headSha.slice(0, 7)}:\n${stdout}${stderr}`,
          { cause: error },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async readIssue(number) {
      const octokit = await dev();
      const { data } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: number,
      });
      if (data.state !== "open" && data.state !== "closed") {
        throw new Error(`issue #${number} has state ${data.state}`);
      }
      return { state: data.state };
    },
  };
}

async function commitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  commit: {
    message: string;
    files: readonly { path: string; content: string }[];
    parentRef: string;
  },
): Promise<string> {
  if (commit.files.length === 0) throw new Error("a commit needs a file");
  const { data: parentRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: commit.parentRef,
  });
  const parent = parentRef.object.sha;
  const { data: parentCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: parent,
  });
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: parentCommit.tree.sha,
    tree: commit.files.map((file) => ({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: file.content,
    })),
  });
  const { data: created } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commit.message,
    tree: tree.sha,
    parents: [parent],
  });
  return created.sha;
}

async function materialize(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  const { data: commit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commit.tree.sha,
    recursive: "1",
  });
  if (tree.truncated) throw new Error(`the tree at ${sha} was truncated`);
  const directory = await mkdtemp(join(tmpdir(), "forgecrew-demo-tests-"));
  for (const entry of tree.tree) {
    if (
      entry.type !== "blob" ||
      entry.path === undefined ||
      entry.sha === undefined
    ) {
      continue;
    }
    const { data: blob } = await octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: entry.sha,
    });
    if (blob.encoding !== "base64" || blob.content === undefined) {
      throw new Error(`${entry.path} is not a base64 blob`);
    }
    const target = safePath(directory, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      Buffer.from(blob.content.replaceAll(/\s/g, ""), "base64"),
    );
  }
  return directory;
}

function safePath(root: string, path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`refusing to write ${path}`);
  }
  const target = join(root, path);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to write ${path}`);
  }
  return target;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`"${repository}" is not an owner/name repository path`);
  }
  return { owner, repo };
}

function streamOf(error: unknown, stream: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(stream in error)) {
    return "";
  }
  const value = (error as Record<string, unknown>)[stream];
  return typeof value === "string" ? value : "";
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

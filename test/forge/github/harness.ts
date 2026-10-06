import { generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished, vi } from "vitest";
import { GitHubForge } from "../../../src/adapters/forge/index.ts";
import type {
  Change,
  Identity,
  LineRange,
  PassResult,
} from "../../../src/core/domain/index.ts";
import { git, temporaryDirectory } from "../git.ts";
import type { World } from "../world.ts";
import {
  type CheckRun,
  type Fixture,
  GitHubSimulator,
  type PullRequest,
} from "./simulator.ts";

/** Builds the GitHub adapter on a simulated GitHub that holds the world. */
export async function gitHubForge(
  world: World,
  options: { maxPerPage?: number; gitUrl?: string } = {},
): Promise<{ forge: GitHubForge; simulator: GitHubSimulator }> {
  // Every request goes through the simulator's fetch; this proves it.
  vi.stubGlobal("fetch", () => {
    throw new Error("a test tried to reach the network");
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  const gitRoot = await temporaryDirectory("forgecrew-github-");
  const simulator = new GitHubSimulator({
    app: { ...app, slug: slugOf(world.identity), publicKey: keys.publicKey },
    gitRoot,
    ...(options.maxPerPage === undefined
      ? {}
      : { maxPerPage: options.maxPerPage }),
  });
  seed(simulator, world);
  for (const [repository, source] of Object.entries(world.remotes ?? {})) {
    const bare = join(gitRoot, `${repository}.git`);
    await mkdir(dirname(bare), { recursive: true });
    await git(gitRoot, "clone", "--bare", "--quiet", source, bare);
  }

  const forge = new GitHubForge({
    appId: app.id,
    privateKey: keys.privateKey,
    lanes: world.lanes,
    fetch: simulator.fetch,
    gitUrl: options.gitUrl ?? pathToFileURL(gitRoot).href,
  });
  return { forge, simulator };
}

export const app = { id: 1001, installationId: 2002 };

/** The slug of the App behind a bot account's handle, `<slug>[bot]`. */
export function slugOf(identity: Identity): string {
  if (!identity.endsWith(botSuffix)) {
    throw new Error(`${identity} is not a GitHub App's bot account`);
  }
  return identity.slice(0, -botSuffix.length);
}

const botSuffix = "[bot]";

// Generated per test run, so no key is ever committed.
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// The world in GitHub's terms: a pull request and its files per change, a
// check run per verdict record and one for CI, issue comments for the
// conversation, and review comments for the threads. A handle ending in
// `[bot]` is an App's bot account; any other is a person.
function seed(simulator: GitHubSimulator, world: World): void {
  const apps = new Map<Identity, number>([[world.identity, app.id]]);
  for (const { author } of world.changes.flatMap(({ verdicts }) => verdicts)) {
    if (!apps.has(author)) apps.set(author, app.id + apps.size);
  }
  const user = (identity: Identity) => ({
    login: identity,
    type: identity.endsWith(botSuffix) ? "Bot" : "User",
  });

  for (const change of world.changes) {
    const { repository, number } = change.ref;
    simulator.pullRequest(repository, pullRequest(change, user));
    simulator.pullFiles(
      repository,
      number,
      change.files.map(({ path, lines }) => ({
        filename: path,
        status: "modified",
        ...(lines.length === 0 ? {} : { patch: lines.map(hunk).join("\n") }),
      })),
    );
    const ci = ciRun(change);
    if (ci !== undefined) simulator.checkRun(repository, ci);
    for (const record of change.verdicts) {
      simulator.checkRun(repository, {
        id: Number(record.id),
        name: record.lane,
        head_sha: record.head,
        status: record.result === undefined ? "in_progress" : "completed",
        conclusion:
          record.result === undefined ? null : conclusions[record.result],
        started_at: record.claimedAt,
        completed_at: record.closedAt ?? null,
        output: {
          title: record.result ?? "In progress",
          summary: record.summary,
        },
        app: { id: apps.get(record.author), slug: slugOf(record.author) },
      });
    }
    for (const comment of change.comments) {
      simulator.issueComment(repository, number, {
        id: Number(comment.id),
        user: user(comment.author),
        body: comment.body,
        created_at: comment.createdAt,
      });
    }
    for (const thread of change.threads) {
      // GitHub knows a thread by its first comment.
      if (thread.comments[0]?.id !== thread.id) {
        throw new Error(
          `thread ${thread.id} must share its first comment's id`,
        );
      }
      for (const [index, comment] of thread.comments.entries()) {
        simulator.reviewComment(repository, number, {
          id: Number(comment.id),
          ...(index === 0 ? {} : { in_reply_to_id: Number(thread.id) }),
          path: thread.path,
          subject_type: thread.anchor,
          ...(thread.line === undefined ? {} : { line: thread.line }),
          commit_id: change.head,
          user: user(comment.author),
          body: comment.body,
          created_at: comment.createdAt,
        });
      }
    }
  }
}

function pullRequest(
  change: Change,
  user: (identity: Identity) => Fixture<PullRequest["user"]>,
): Fixture<PullRequest> {
  const { repository, number } = change.ref;
  return {
    number,
    node_id: `PR_node_${number}`,
    url: `${GitHubSimulator.apiUrl}/repos/${repository}/pulls/${number}`,
    state: change.state === "open" ? "open" : "closed",
    merged: change.state === "merged",
    merged_at: change.state === "merged" ? change.updatedAt : null,
    draft: change.draft,
    user: user(change.author),
    updated_at: change.updatedAt,
    head: {
      ref: change.branch,
      sha: change.head,
      repo: {
        full_name: change.fromFork
          ? `a-fork-owner/${repository.split("/")[1]}`
          : repository,
      },
    },
    base: { ref: "main", repo: { full_name: repository } },
    requested_reviewers: change.reviewers.map(user),
  };
}

// A hunk that shows the range on the head's side as alternating context and
// added lines, after one deleted line, as `git diff` would print it.
function hunk({ start, end }: LineRange): string {
  const shown = Array.from({ length: end - start + 1 }, (_, offset) =>
    offset % 2 === 0 ? ` line ${start + offset}` : `+line ${start + offset}`,
  );
  const context = shown.filter((line) => line.startsWith(" ")).length;
  return [
    `@@ -${start},${context + 1} +${start},${shown.length} @@`,
    "-a deleted line",
    ...shown,
  ].join("\n");
}

// CI as one GitHub Actions check run, as a single-job workflow reports it.
function ciRun({ ci, head }: Change): Fixture<CheckRun> | undefined {
  if (ci === "none") return undefined;
  return {
    id: 1,
    name: "Check",
    head_sha: head,
    status: ci === "pending" ? "in_progress" : "completed",
    conclusion: ci === "pending" ? null : ci,
    started_at: "2026-01-01T00:00:00Z",
    app: { id: 15368, slug: "github-actions" },
  };
}

const conclusions = {
  accepted: "success",
  issues: "failure",
  cancelled: "cancelled",
  timed_out: "timed_out",
  action_required: "action_required",
} as const satisfies Record<PassResult, CheckRun["conclusion"]>;

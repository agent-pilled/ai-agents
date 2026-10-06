import { App } from "@octokit/app";
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";
import {
  type Change,
  type ChangedFile,
  type ChangeRef,
  type CiState,
  type Claim,
  type Comment,
  type Finding,
  type Identity,
  type Instant,
  isOnTheDiff,
  type Lane,
  type LineRange,
  type PassResult,
  type Sha,
  type Thread,
  type VerdictRecord,
} from "../../../core/domain/index.ts";
import type {
  ClaimTarget,
  Commits,
  DiscoveredChange,
  Forge,
  Handoff,
  MergeOutcome,
  PublishOutcome,
} from "../../../core/ports/index.ts";
import { push } from "./push.ts";

export interface GitHubForgeOptions {
  /** The GitHub App the role acts as. */
  readonly appId: number | string;
  /** The App's private key, PEM-encoded. */
  readonly privateKey: string;
  /**
   * The instance's lanes. A check run named after a lane is that lane's
   * verdict record; every other check and status on a head counts as CI.
   */
  readonly lanes: readonly Lane[];
  /** The REST API's root, for GitHub Enterprise Server. */
  readonly apiUrl?: string;
  /** The root repositories are pushed to, for GitHub Enterprise Server. */
  readonly gitUrl?: string;
  /** The `fetch` Octokit sends every request through. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The forge port on GitHub. It acts as one GitHub App, through the App's
 * installation on each repository. Verdict records are check runs named after
 * the lane, which a ruleset binds to the lane's App (ADR 0002); the App never
 * submits an approval.
 */
export class GitHubForge implements Forge {
  readonly #app;
  readonly #lanes: readonly Lane[];
  readonly #gitUrl: string;
  readonly #clients = new Map<string, Promise<Client>>();

  constructor({
    appId,
    privateKey,
    lanes,
    apiUrl = "https://api.github.com",
    gitUrl = "https://github.com",
    fetch,
  }: GitHubForgeOptions) {
    this.#app = new App({
      appId,
      privateKey,
      Octokit: Octokit.defaults({
        baseUrl: apiUrl,
        request: fetch === undefined ? {} : { fetch },
      }),
    });
    this.#lanes = lanes;
    this.#gitUrl = gitUrl;
  }

  async discover(
    repository: string,
    since?: Instant,
  ): Promise<DiscoveredChange[]> {
    const { octokit, owner, repo } = await this.#client(repository);
    // The issues endpoint lists pull requests too, and alone filters by update.
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "asc",
      per_page: 100,
      ...(since === undefined ? {} : { since }),
    });
    return issues
      .filter((issue) => issue.pull_request !== undefined)
      .map((issue) => ({
        ref: { repository, number: issue.number },
        updatedAt: issue.updated_at,
      }));
  }

  async readChange(ref: ChangeRef): Promise<Change> {
    const client = await this.#client(ref.repository);
    const { octokit, owner, repo } = client;
    const { data: pull } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: ref.number,
    });
    const head = pull.head.sha;
    const [files, runs, { data: status }, comments, reviewComments] =
      await Promise.all([
        changedFiles(client, ref.number),
        octokit.paginate(octokit.rest.checks.listForRef, {
          owner,
          repo,
          ref: head,
          filter: "all",
          per_page: 100,
        }),
        // Its `state` covers every context, beyond the first page too.
        octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: head }),
        octokit.paginate(octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number: ref.number,
          per_page: 100,
        }),
        octokit.paginate(octokit.rest.pulls.listReviewComments, {
          owner,
          repo,
          pull_number: ref.number,
          per_page: 100,
        }),
      ]);
    const isLane = (run: CheckRun) => this.#lanes.includes(run.name);

    return {
      ref,
      state: pull.merged ? "merged" : pull.state === "open" ? "open" : "closed",
      draft: pull.draft ?? false,
      author: identityOf(pull.user),
      branch: pull.head.ref,
      fromFork: isFork(pull),
      head,
      updatedAt: pull.updated_at,
      files,
      ci: ciState(
        runs.filter((run) => !isLane(run)),
        status,
      ),
      verdicts: byId(runs.filter(isLane)).map((run) => verdictRecord(ref, run)),
      comments: byId(comments).map(comment),
      threads: threads(reviewComments),
      reviewers: (pull.requested_reviewers ?? []).map(identityOf),
    };
  }

  async claim(target: ClaimTarget, summary: string): Promise<Claim> {
    const { octokit, owner, repo } = await this.#client(
      target.change.repository,
    );
    const { data: run } = await octokit.rest.checks.create({
      owner,
      repo,
      name: target.lane,
      head_sha: target.head,
      status: "in_progress",
      started_at: now(),
      output: { title: openTitle, summary },
    });
    return { id: String(run.id), ...target };
  }

  async updateClaim(claim: Claim, summary: string): Promise<void> {
    const { octokit, owner, repo } = await this.#openRun(claim);
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(claim.id),
      output: { title: openTitle, summary },
    });
  }

  async closeClaim(
    claim: Claim,
    result: PassResult,
    summary: string,
  ): Promise<void> {
    const { octokit, owner, repo } = await this.#openRun(claim);
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(claim.id),
      conclusion: conclusions[result],
      completed_at: now(),
      output: { title: closedTitles[result], summary },
    });
  }

  async postFindings(
    ref: ChangeRef,
    head: Sha,
    findings: readonly Finding[],
  ): Promise<void> {
    if (findings.length === 0) return;
    const client = await this.#client(ref.repository);
    const { octokit, owner, repo } = client;
    // GitHub refuses a comment off the diff, so check every finding before
    // posting any.
    const files = await changedFiles(client, ref.number);
    const offTheDiff = findings.find((finding) => !isOnTheDiff(finding, files));
    if (offTheDiff !== undefined) {
      const { path, line } = offTheDiff;
      throw new Error(
        `${line === undefined ? path : `${path}:${line}`} is not on the diff of ${ref.repository}#${ref.number}`,
      );
    }
    // One review comment per finding, in order: a single review holding them
    // all would need review text of its own.
    for (const { path, line, body } of findings) {
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: ref.number,
        commit_id: head,
        path,
        body,
        ...(line === undefined
          ? { subject_type: "file" as const }
          : { line, side: "RIGHT" as const }),
      });
    }
  }

  async publish(ref: ChangeRef, commits: Commits): Promise<PublishOutcome> {
    const { octokit, owner, repo, installationId } = await this.#client(
      ref.repository,
    );
    const { data: pull } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: ref.number,
    });
    if (isFork(pull)) {
      throw new Error(`${ref.repository}#${ref.number} comes from a fork`);
    }
    return push({
      ...commits,
      url: `${this.#gitUrl}/${owner}/${repo}.git`,
      token: await this.#token(installationId),
      branch: pull.head.ref,
    });
  }

  async markReady(ref: ChangeRef, handoff: Handoff): Promise<void> {
    const { octokit, owner, repo } = await this.#client(ref.repository);
    const { data: pull } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: ref.number,
    });
    // The REST API cannot take a pull request out of draft.
    if (pull.draft) {
      await octokit.graphql(
        `mutation ($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            clientMutationId
          }
        }`,
        { id: pull.node_id },
      );
    }
    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: ref.number,
      reviewers: [handoff.reviewer],
    });
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: ref.number,
      body: handoff.comment,
    });
  }

  // Without a merge method GitHub makes a merge commit, so a repository that
  // allows only squash or rebase merges reads as blocked until configuration
  // chooses the method.
  async merge(ref: ChangeRef, head: Sha): Promise<MergeOutcome> {
    const { octokit, owner, repo } = await this.#client(ref.repository);
    const { data: pull } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: ref.number,
    });
    try {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: ref.number,
        sha: head,
      });
    } catch (error) {
      if (statusOf(error) === 405) return "blocked";
      if (statusOf(error) === 409) return "stale-head";
      throw error;
    }
    if (!isFork(pull)) {
      try {
        await octokit.rest.git.deleteRef({
          owner,
          repo,
          ref: `heads/${pull.head.ref}`,
        });
      } catch (error) {
        // Already gone, for example deleted by the repository's own setting.
        if (statusOf(error) !== 422) throw error;
      }
    }
    return "merged";
  }

  // One installation client per repository, looked up on first use.
  #client(repository: string): Promise<Client> {
    let client = this.#clients.get(repository);
    if (client === undefined) {
      client = this.#connect(repository);
      this.#clients.set(repository, client);
      client.catch(() => this.#clients.delete(repository));
    }
    return client;
  }

  async #connect(repository: string): Promise<Client> {
    const [owner, repo, ...rest] = repository.split("/");
    if (!owner || !repo || rest.length > 0) {
      throw new Error(`"${repository}" is not an owner/name repository path`);
    }
    const { data: installation } =
      await this.#app.octokit.rest.apps.getRepoInstallation({ owner, repo });
    return {
      owner,
      repo,
      installationId: installation.id,
      octokit: await this.#app.getInstallationOctokit(installation.id),
    };
  }

  async #token(installationId: number): Promise<string> {
    const auth = await this.#app.octokit.auth({
      type: "installation",
      installationId,
    });
    if (
      typeof auth !== "object" ||
      auth === null ||
      !("token" in auth) ||
      typeof auth.token !== "string"
    ) {
      throw new Error("GitHub returned no installation token");
    }
    return auth.token;
  }

  // GitHub would let the App rewrite a completed check run; a closed verdict
  // record must never change.
  async #openRun(claim: Claim): Promise<Client> {
    const client = await this.#client(claim.change.repository);
    const { octokit, owner, repo } = client;
    const { data: run } = await octokit.rest.checks.get({
      owner,
      repo,
      check_run_id: Number(claim.id),
    });
    if (run.status === "completed") {
      throw new Error(`claim ${claim.id} is already closed`);
    }
    return client;
  }
}

interface Client {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly installationId: number;
}

type PullRequest = RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];
type CheckRun = RestEndpointMethodTypes["checks"]["get"]["response"]["data"];
type CombinedStatus =
  RestEndpointMethodTypes["repos"]["getCombinedStatusForRef"]["response"]["data"];
type DiffEntry =
  RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];
type IssueComment =
  RestEndpointMethodTypes["issues"]["getComment"]["response"]["data"];
type ReviewComment =
  RestEndpointMethodTypes["pulls"]["getReviewComment"]["response"]["data"];
type Conclusion = NonNullable<CheckRun["conclusion"]>;

const conclusions = {
  accepted: "success",
  issues: "failure",
  cancelled: "cancelled",
  timed_out: "timed_out",
  action_required: "action_required",
} as const satisfies Record<PassResult, Conclusion>;

const openTitle = "In progress";
const closedTitles: Record<PassResult, string> = {
  accepted: "Accepted",
  issues: "Issues found",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  action_required: "Needs human action",
};

function verdictRecord(change: ChangeRef, run: CheckRun): VerdictRecord {
  if (run.started_at === null) {
    throw new Error(`GitHub returned check run ${run.id} without a start time`);
  }
  const record = {
    id: String(run.id),
    change,
    lane: run.name,
    head: run.head_sha,
    author: run.app?.slug === undefined ? ghost : `${run.app.slug}${botSuffix}`,
    summary: run.output.summary ?? "",
    claimedAt: run.started_at,
  };
  if (run.status !== "completed") return record;
  return {
    ...record,
    result: passResult(run.conclusion),
    closedAt: run.completed_at ?? run.started_at,
  };
}

// Any other conclusion, such as the `stale` GitHub sets on a run left
// incomplete for 14 days, reads as an operational outcome, never a verdict.
function passResult(conclusion: CheckRun["conclusion"]): PassResult {
  switch (conclusion) {
    case "success":
      return "accepted";
    case "failure":
      return "issues";
    case "timed_out":
      return "timed_out";
    case "action_required":
      return "action_required";
    default:
      return "cancelled";
  }
}

// CI counts the latest run of each check, and the commit statuses combined.
function ciState(runs: CheckRun[], status: CombinedStatus): CiState {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const key = `${run.app?.id ?? ""}/${run.name}`;
    const seen = latest.get(key);
    if (seen === undefined || run.id > seen.id) latest.set(key, run);
  }
  const states = [...latest.values()].map(runState);
  // With no statuses at all, GitHub reports the combined state as pending.
  if (status.total_count > 0) states.push(combinedState(status));
  if (states.length === 0) return "none";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return "success";
}

function runState(run: CheckRun): CiState {
  if (run.status !== "completed") return "pending";
  return ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
    ? "success"
    : "failure";
}

function combinedState({ state }: CombinedStatus): CiState {
  if (state === "pending") return "pending";
  return state === "success" ? "success" : "failure";
}

async function changedFiles(
  { octokit, owner, repo }: Client,
  number: number,
): Promise<ChangedFile[]> {
  const entries = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return entries.map((entry) => ({
    path: entry.filename,
    lines: linesShown(entry),
  }));
}

// Each hunk header names the head's lines the hunk shows: `+start,count`.
// GitHub leaves the patch out for binary and very large files.
function linesShown({ patch }: DiffEntry): LineRange[] {
  const hunks = (patch ?? "").matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
  );
  return [...hunks]
    .map(([, start, count]) => ({
      start: Number(start),
      count: count === undefined ? 1 : Number(count),
    }))
    .filter(({ count }) => count > 0)
    .map(({ start, count }) => ({ start, end: start + count - 1 }));
}

// A thread is a top-level review comment and its replies, which GitHub links
// to the top-level comment.
function threads(reviewComments: ReviewComment[]): Thread[] {
  const byRoot = new Map<number, [ReviewComment, ...ReviewComment[]]>();
  for (const reviewComment of byId(reviewComments)) {
    const root = reviewComment.in_reply_to_id ?? reviewComment.id;
    const thread = byRoot.get(root);
    if (thread === undefined) byRoot.set(root, [reviewComment]);
    else thread.push(reviewComment);
  }
  return [...byRoot].map(([root, [first, ...replies]]) => ({
    id: String(root),
    path: first.path,
    // Both a comment on a file and one on a line that is gone have no line;
    // only `subject_type` tells them apart. On the base side (`LEFT`), `line`
    // numbers the base version, which the head does not share.
    ...(first.subject_type === "file"
      ? { anchor: "file" as const }
      : {
          anchor: "line" as const,
          ...(typeof first.line === "number" && first.side !== "LEFT"
            ? { line: first.line }
            : {}),
        }),
    comments: [first, ...replies].map(comment),
  }));
}

function comment(issueOrReviewComment: IssueComment | ReviewComment): Comment {
  return {
    id: String(issueOrReviewComment.id),
    author: identityOf(issueOrReviewComment.user),
    body: issueOrReviewComment.body ?? "",
    createdAt: issueOrReviewComment.created_at,
  };
}

// GitHub's placeholder for an account that no longer exists.
const ghost = "ghost";

// An App acts through the bot account `<slug>[bot]`. Keeping the suffix keeps
// it apart from a person or organization with the App's name.
const botSuffix = "[bot]";

function identityOf(user: { login: string } | null): Identity {
  return user === null ? ghost : user.login;
}

function isFork(pull: PullRequest): boolean {
  return pull.head.repo?.full_name !== pull.base.repo.full_name;
}

function byId<T extends { id: number }>(items: T[]): T[] {
  return items.toSorted((a, b) => a.id - b.id);
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

// GitHub documents its timestamps without fractions of a second.
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

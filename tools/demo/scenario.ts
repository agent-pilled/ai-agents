import type { Forge, MergeOutcome } from "../../src/core/ports/index.ts";
import {
  applyPatch,
  demoIssue,
  FIX_PATCH,
  NOTE_PATCH,
  type ProjectFile,
  patchFile,
  projectFiles,
} from "./project.ts";

/**
 * One scripted pass of the demo, with no model in it. `roles` are the three
 * forge identities. `side` does the work the forge port does not cover
 * (opening the issue, writing commits, opening the pull request, forging a
 * check, running the tests). Each step throws if the forge's answer is not
 * the one this script expects, so a live run stops at the first surprise.
 *
 * The ruleset is a precondition, applied by the operator. This function does
 * not create one: none of the three Apps has administration permission.
 */

const BASE = "main";
const BRANCH = "forgecrew-fix-add";

const SCRIPTED_REVIEW =
  "Scripted verdict: accepted. No model reviewed this commit.";
const SCRIPTED_QA =
  "Scripted verdict: accepted. The repository tests passed locally. No model ran.";

export interface DemoRoles {
  readonly dev: Forge;
  readonly review: Forge;
  readonly qa: Forge;
}

export interface DemoFile {
  readonly path: string;
  readonly content: string;
}

export interface DemoSide {
  readonly repository: string;
  openIssue(title: string, body: string): Promise<{ number: number }>;
  createBranchWithCommit(commit: {
    branch: string;
    base: string;
    message: string;
    files: readonly DemoFile[];
  }): Promise<{ sha: string }>;
  addCommit(commit: {
    branch: string;
    message: string;
    files: readonly DemoFile[];
  }): Promise<{ sha: string }>;
  openPullRequest(pull: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{
    number: number;
    headSha: string;
    draft: boolean;
    body: string;
  }>;
  /** A completed check run created by dev-bot, which the ruleset must ignore. */
  createCheckRunAsDev(name: string, headSha: string): Promise<void>;
  /** Runs the demo repository's tests at this commit. Rejects when they fail. */
  runTests(headSha: string): Promise<void>;
  readIssue(number: number): Promise<{ state: "open" | "closed" }>;
}

export type ScenarioLog = (line: string) => void | Promise<void>;

export interface ScenarioResult {
  readonly issueNumber: number;
  readonly pullNumber: number;
  /** The head the pull request was opened at, then the head after the follow-up. */
  readonly heads: readonly [string, string];
  readonly outcomes: readonly MergeOutcome[];
}

export async function runScenario(
  roles: DemoRoles,
  side: DemoSide,
  log: ScenarioLog = () => {},
): Promise<ScenarioResult> {
  const repository = side.repository;
  const issueText = await demoIssue();
  const issue = await side.openIssue(issueText.title, issueText.body);
  await log(report("operator", "issue", undefined, `OPENED #${issue.number}`));

  const original = await projectFiles();
  const fixed = await applyPatch(original, patchFile(FIX_PATCH));
  const first = await side.createBranchWithCommit({
    branch: BRANCH,
    base: BASE,
    message: "Fix add() so it adds.\n",
    files: changed(original, fixed),
  });
  const body = `Fixes #${issue.number}`;
  const pull = await side.openPullRequest({
    title: "Fix add() so it adds",
    body,
    head: BRANCH,
    base: BASE,
  });
  if (pull.draft) {
    throw new Error(`pull request #${pull.number} was opened as a draft`);
  }
  if (pull.body !== body) {
    throw new Error(
      `pull request #${pull.number} body is ${JSON.stringify(pull.body)}, expected ${JSON.stringify(body)}`,
    );
  }
  if (pull.headSha !== first.sha) {
    throw new Error(
      `pull request #${pull.number} head is ${pull.headSha}, expected ${first.sha}`,
    );
  }
  await log(
    report(
      "dev-bot",
      "open",
      first.sha,
      `PR #${pull.number} ready (Fixes #${issue.number})`,
    ),
  );

  const outcomes: MergeOutcome[] = [
    await merge(
      roles,
      side,
      pull.number,
      first.sha,
      "blocked",
      "required checks missing",
      log,
    ),
  ];

  await side.createCheckRunAsDev("review", first.sha);
  await side.createCheckRunAsDev("qa", first.sha);
  await log(
    report("dev-bot", "checks", first.sha, "forged review and qa success"),
  );
  outcomes[1] = await merge(
    roles,
    side,
    pull.number,
    first.sha,
    "blocked",
    "forged checks do not count",
    log,
  );

  await accept(
    roles.review,
    repository,
    pull.number,
    "review",
    first.sha,
    SCRIPTED_REVIEW,
  );
  await log(
    report("review-bot", "verdict", first.sha, "ACCEPTED review (scripted)"),
  );

  const noted = await applyPatch(fixed, patchFile(NOTE_PATCH));
  const second = await side.addCommit({
    branch: BRANCH,
    message: "Document add().\n",
    files: changed(fixed, noted),
  });
  await log(report("dev-bot", "push", second.sha, "follow-up commit"));
  outcomes[2] = await merge(
    roles,
    side,
    pull.number,
    second.sha,
    "blocked",
    "new head has no lane verdicts",
    log,
  );

  await accept(
    roles.review,
    repository,
    pull.number,
    "review",
    second.sha,
    SCRIPTED_REVIEW,
  );
  await log(
    report("review-bot", "verdict", second.sha, "ACCEPTED review (scripted)"),
  );
  await accept(
    roles.qa,
    repository,
    pull.number,
    "qa",
    second.sha,
    SCRIPTED_QA,
    async () => {
      await side.runTests(second.sha);
      await log(report("qa-bot", "tests", second.sha, "passed"));
    },
  );
  await log(report("qa-bot", "verdict", second.sha, "ACCEPTED qa (scripted)"));

  outcomes[3] = await merge(
    roles,
    side,
    pull.number,
    second.sha,
    "merged",
    "forge accepted",
    log,
  );

  const merged = await roles.dev.readChange({
    repository,
    number: pull.number,
  });
  if (merged.state !== "merged" || merged.head !== second.sha) {
    throw new Error(
      `pull request #${pull.number} is ${merged.state} at ${merged.head}, expected merged at ${second.sha}`,
    );
  }
  await expectIssueClosed(side, issue.number);

  return {
    issueNumber: issue.number,
    pullNumber: pull.number,
    heads: [first.sha, second.sha],
    outcomes,
  };
}

async function merge(
  roles: DemoRoles,
  side: DemoSide,
  number: number,
  sha: string,
  expected: MergeOutcome,
  reason: string,
  log: ScenarioLog,
): Promise<MergeOutcome> {
  const outcome = await roles.dev.merge(
    { repository: side.repository, number },
    sha,
  );
  if (outcome !== expected) {
    throw new Error(
      `dev-bot merge at ${sha.slice(0, 7)} returned ${outcome}, expected ${expected} (${reason})`,
    );
  }
  const label =
    outcome === "merged"
      ? "MERGED"
      : outcome === "blocked"
        ? `BLOCKED (${reason})`
        : `STALE-HEAD (${reason})`;
  await log(report("dev-bot", "merge", sha, label));
  return outcome;
}

async function accept(
  forge: Forge,
  repository: string,
  number: number,
  lane: string,
  sha: string,
  summary: string,
  beforeClose?: () => Promise<void>,
): Promise<void> {
  const change = { repository, number };
  const claim = await forge.claim({ change, lane, head: sha }, summary);
  if (beforeClose !== undefined) await beforeClose();
  await forge.closeClaim(claim, "accepted", summary);
  const read = await forge.readChange(change);
  const record = read.verdicts.find((verdict) => verdict.id === claim.id);
  if (record?.result !== "accepted" || record.head !== sha) {
    throw new Error(
      `${lane} claim ${claim.id} on ${sha.slice(0, 7)} did not close accepted on that head`,
    );
  }
}

async function expectIssueClosed(
  side: DemoSide,
  number: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const issue = await side.readIssue(number);
    if (issue.state === "closed") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`issue #${number} stayed open after the merge`);
}

function changed(
  before: readonly ProjectFile[],
  after: readonly ProjectFile[],
): ProjectFile[] {
  const prior = new Map(before.map((file) => [file.path, file.content]));
  const updates = after.filter((file) => prior.get(file.path) !== file.content);
  if (updates.length === 0) throw new Error("a patch changed no file");
  return updates;
}

function report(
  actor: string,
  action: string,
  sha: string | undefined,
  outcome: string,
): string {
  const at = sha === undefined ? "" : ` @${sha.slice(0, 7)}`;
  return `${actor.padEnd(10, " ")} ${action}${at}  -> ${outcome}`;
}

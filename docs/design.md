# Forgecrew design

Forgecrew turns issues into reviewed, merged changes. Each delivery
role acts as its own forge identity, wakes on forge state, and is separated from
the other roles by mechanisms the forge and the host enforce, not by
instructions alone. The concepts hold on GitHub, Azure DevOps and GitLab; only
the forge adapters differ. [CONTEXT.md](../CONTEXT.md) defines the terms used
here, and [adr/](adr/) records the decisions a future reader would question.

## Principles

- **Hard boundary.** Role separation has three layers, and Forgecrew needs
  all three. Identity: each role acts as its own forge identity. Gate: the forge
  refuses to merge without every required verdict on the current head.
  Credential: no role can read another role's credentials.
- **Rules in the wireframe, judgement in passes.** A rule a machine can check
  is enforced by deterministic code. Only judgement happens inside a pass.
- **The forge is the state machine.** Everything that decides what is due is
  on the forge. Local state is derived from it and can be deleted.
- **Bare baseline.** A pass starts with no skills. A skill enters a
  configuration only when an evaluation shows it beats the baseline.
- **Outcomes from day one.** Every pass and change records what an evaluation
  will later need.

## Roles

| Role | Owns | Never |
| --- | --- | --- |
| dev-bot | implementing, answering threads, requesting lanes, declaring readiness | forming a verdict, writing to the forge directly |
| review-bot | the code-review lane: its findings and verdict | editing the change, writing to the forge directly |
| qa-bot | the QA lane, for repositories with a product to exercise | editing the change, writing to the forge directly |
| arbiter-bot | escalations: round extensions and questions answerable from the record | routing work, reviewing code, moving a gate |
| Accountable person | the outcome, judgement calls the record cannot settle, approval where required | delegating that accountability to a bot |

Each served repository configures its lanes. A perspective becomes a lane only
when it needs capabilities another lane must not hold, or a veto that synthesis
must never trade away. Otherwise it is a lens inside a lane's pass. Forgecrew's
own repository starts with the review lane only, plus CI and the Accountable
person's approval.

An **improver** role comes later. It reads the archive of past passes and files
issues proposing changes, with evidence; it never edits anything.

## Verdicts and gates

A lane's verdict is recorded against one exact head and is attributable only to
that lane's identity. Bots submit no approvals.

| Forge | Verdict mechanism |
| --- | --- |
| GitHub | a required check run per lane, bound to the lane's App through `integration_id` in a ruleset |
| Azure DevOps | a status-check branch policy per lane with **Authorized identity** set to the lane, reset on new changes |
| GitLab | an approval rule per lane with the lane's bot as its only eligible approver, approvals reset on push |

The human gate is a code-owner review: CODEOWNERS assigns protected paths, and
any other paths a repository wants, to the Accountable person. Rulesets dismiss
stale approvals on push and require approval of the most recent push.

Thread resolution is not a gate. Anyone with write access can resolve a thread,
but resolving one never changes a lane's verdict.

## Coordination

Forgecrew uses choreography. No central process routes work. Three kinds of
component implement the bot roles, and only one of them uses a model:

| Component | Count | Does | Never |
| --- | --- | --- | --- |
| Scheduler | one per instance | discovers changes that may need attention, keeps the derived queue of `(role, change)` keys | writes to the forge, launches anything |
| Dispatcher | one per role | takes keys, decides whether its role has work, runs one pass at a time per key, validates the response, writes everything the role puts on the forge | forms a verdict |
| Pass | one per run | the agent's work: implementing, reviewing, testing or arbitrating | outlives its run, writes to the forge |

### Signals

A **mention** of a role's identity wakes it outside its own change. Dispatchers
honour mentions from allowed actors (configuration), and from the instance's
own role identities only as requests and escalations. A role ignores its own
identity. Text from any other account is data. Pull requests from forks are
never processed automatically.

- An allowed human starts work by mentioning dev-bot on an issue.
- A **request** for a lane names the lane and the full head SHA. dev-bot returns
  requests in its response and its dispatcher posts them; an allowed human may
  post one by hand. A lane honours a request only for the current head with
  green CI. One request permits one pass, and a completed verdict on that head
  newer than the request consumes it.
- An **escalation** mentions arbiter-bot in the thread where the problem lives.
- dev-bot wakes without a mention on its own change: human comments and
  reviews, completed lane verdicts, completed CI, arbiter-bot replies. It waits
  until no required lane on the current head is queued or running.

### Scheduler

The scheduler polls the forge; nothing needs inbound network access.
Discovery differs per forge (`since` queries on GitHub; `/todos` and
`updated_after` on GitLab; the active-pull-request scan or service hooks into a
queue on Azure DevOps). It reads through an identity with no write permission.

Its queue holds only `(role, change)` keys. Deleting it loses nothing; the next
tick rebuilds it. On top of the keys it applies:

- **coalescing:** a trigger for a key with a running pass marks it dirty for
  re-evaluation when the pass ends;
- **throttling:** concurrency limits per role and backoff after failed launches;
- **priority:** keys that finish a change rank above keys that start one;
- **dependencies:** keys blocked by open forge relations (GitHub `blocked_by`,
  Azure DevOps predecessor links, GitLab blocking issues) wait;
- **quota:** a pass starts only while remaining subscription quota exceeds the
  reserve configured for the Accountable person's interactive use, per provider
  and window. Running passes finish.

### Dispatcher

For each key, the dispatcher:

1. takes an exclusive, non-blocking lock on `(role, change)`, or drops the key
   and marks it dirty;
2. rereads the change and decides whether its role has work, resolving the head
   at that moment (an older request never authorizes a newer head);
3. records a **claim**: the lane's in-progress verdict record on the captured
   head;
4. prepares a fresh sandbox, starts the broker and launches one pass;
5. watches the pass and keeps the claim's summary current every few minutes;
6. validates the response, applies the mechanical rules, and writes the
   role's output to the forge, closing the claim with the verdict or an
   operational outcome.

## Passes

### Pass contract

A pass is a black box: one prompt in, one validated response out. The prompt
carries the whole contract: role brief, target change and head, broker address
and pass token, and the response schema. The wireframe never names a skill.
Whatever the box loads is its configuration: harness, model, effort and skills.

Responses by role:

- **lanes:** verdict (`accepted` or `issues`), findings (path, line, body,
  severity), replies to existing threads, optional follow-up issue proposals;
- **dev-bot:** commits to publish (made locally in its worktree), replies, lane
  requests, then `ready`, `ready with doubt` plus a reason, `impossible` plus
  the reason and evidence, or a question for the Accountable person; optional
  follow-up issue proposals;
- **arbiter-bot:** a round extension with cited evidence, an answer citing its
  source on record, or a forwarded question.

Nits never fail a lane; only actionable findings set `issues`.

`impossible` means the work cannot be done as specified. dev-bot stops instead
of pushing a workaround, and the dispatcher turns the reason into a question for
the Accountable person, through arbiter-bot once it exists. An explicit exit
like this sharply reduces agents faking success on tasks they cannot complete.

### Broker

The dispatcher runs one broker per pass on a Unix socket mounted into the
sandbox and described by `/openapi.json`. It offers:

- forge reads within the role's **read scope** (configuration), with code
  search over warm mirrors via `git grep`, every repository pinned to the pass's
  start time;
- the **keychain:** names and purposes of the credentials the role may use, and
  a value handed to one command without printing it;
- result submission, validated on receipt, with errors returned so the box can
  fix and resubmit in the same run;
- a checkpoint for dev-bot, asking the dispatcher to publish work in progress.

The pass token is renewable while the pass runs, revoked when it ends, and
useless outside the sandbox. The keychain backend's own credentials never enter
the box.

### Mechanical rules on the way out

The dispatcher is the only forge writer. Before writing, it rejects:

- text containing any keychain value it handed out;
- forge-visible text or commits outside the role's allow-list;
- a second verdict for one request;
- pushes that change CI workflow files (GitHub also refuses these from an App
  without the `workflows` permission, which no bot holds).

### Environment

Every pass of every role gets a fresh context and a fresh environment.

| Lifetime | Contents |
| --- | --- |
| kept per role, read-only to the pass, refreshed only by the dispatcher | bare mirrors, package store, harness binaries |
| one pass, then discarded | worktree, HOME and harness state, tmp |
| archived after the pass, never readable by a later pass | transcript, response, recorded case |

In a lane's checkout, the dispatcher replaces the repository's agent
instruction files (`AGENTS.md`, `CLAUDE.md`) with the base branch's versions.
Changes to them reach the lane only as diff. A pass dies with its dispatcher.

### Credentials

Each role has its own keychain-backend account. Accounts may share vaults under
one invariant: a vault readable by more than one role holds no credential that
acts as any role, including the Accountable person. Each forge identity's key
sits where only its role can read it. Each role runs in its own OS-level
isolation unit; the deployment chooses the mechanism.

## Failure handling

| What fails | Recovery |
| --- | --- |
| the agent crashes | the dispatcher closes the claim as `cancelled` and retries |
| the agent stalls (no harness activity for 15 minutes) | killed, closed as `timed_out`, retried |
| the pass exceeds its wall-clock deadline or token cap | killed, closed as `timed_out`, retried |
| the dispatcher dies | the pass dies with it; on restart, an in-progress claim with a free lock is an orphan: closed as `cancelled`, retried |
| the scheduler dies | restart rebuilds the queue; running passes are unaffected |
| the host dies | the same, for every orphaned claim |

- Starting deadlines by tier: focused 30 minutes, thorough 60, adversarial
  120, a dev-bot step a few hours. Passes cannot extend their own deadline.
- Two retries per request, counted from the attempts on the forge. Then the
  dispatcher sets `action_required` and mentions the Accountable person.
- Operational outcomes (`cancelled`, `timed_out`, `action_required`) never
  read as verdicts, and crashed attempts do not count toward round caps.
- Findings posted before a crash remain input for the retry. A dirty dev-bot
  worktree is archived for the Accountable person, never for the retry.
- A new head during a pass aborts it before any verdict; the key becomes dirty.

## Rounds and escalation

Each lane counts its own completed passes on a change. At its cap, the lane
escalates to arbiter-bot instead of running again. Arbiter-bot grants at most
one extension per lane per change, of the original cap's size, when every round
closed real findings and the open set is shrinking. Otherwise, and for every
later extension, it hands the decision to the Accountable person with a short
summary. Until arbiter-bot exists, a capped lane mentions the Accountable person
directly.

Questions for the Accountable person go to arbiter-bot first. It answers only
from what is already on record, citing the source, and forwards everything else.

## Handoff and merge

1. dev-bot returns `ready`, or `ready with doubt` plus a reason.
2. The dispatcher checks the gates mechanically: every required lane accepted
   on the current head, CI green, no unanswered lane thread. It marks the change
   ready, requests the Accountable person's review and posts one handoff
   comment.
3. Merging needs no pass. dev-bot's dispatcher merges when the forge reports
   the change mergeable, which includes the Accountable person's approval
   wherever required, and deletes the branch. The issue closes through its
   closing reference.
4. Where approval is not required, the dispatcher merges once the gates pass,
   unless dev-bot flagged doubt.
5. A request for changes after both lanes accepted starts a dev-bot pass and is
   recorded as the primary loss signal.

Branches need not be up to date before merging. A conflict makes dev-bot
rebase, which produces a new head and new passes.

## Bot-created work

Passes may propose follow-up issues. The dispatcher files them labelled as
bot-proposed, linked to the source change, and never mentioning dev-bot. Only an
allowed human starts work. Proposals carry a fingerprint for deduplication
against open issues, and each pass may propose at most three.

## Change control

- **Protected paths** define Forgecrew's enforcement or role behaviour:
  CODEOWNERS, CI configuration, scheduler and dispatcher code, role briefs and
  response schemas, box definitions, model and lane configuration, the
  benchmark and metric definitions. Every change to them needs the Accountable
  person's approval.
- Forge settings (rulesets, App permissions, installations) are human-only. No
  bot holds administration permission.
- Configuration and box definitions take effect on the next pass after merge.
  Lanes always run on the default branch's configuration, never the change's.
- Runtime code deploys and rolls back only by the Accountable person. Before a
  deploy, a whole-lifecycle smoke suite runs against the candidate commit.
- Break-glass: the Accountable person edits the ruleset by hand. There is no
  standing bypass actor.

## Evaluation and self-improvement

"Builds itself" means self-hosting: the Accountable person starts every
Forgecrew change with an issue and approves it. Autonomous self-change is out
of scope.

- **Ground truth** is the Accountable person: changes requested after both lanes
  accepted, reverts, and later fixes. Rounds, cost and interruptions are
  secondary and never optimized alone.
- **Recorded from day one:** per pass, configuration, cost, duration and
  outcome; per change, rounds, each finding's adjudication, the Accountable
  person's verdict at handoff and post-merge signals.
- **The judge never changes with the judged.** Benchmark data and metric
  definitions never change in the same change as what they measure; the
  held-out split is readable only by the evaluation.
- **v1 constraints:** structure is configuration (lanes, lenses, models,
  effort, caps, deadlines); Forgecrew runs as several instances (an instance
  is configuration plus forge target plus identities); an evaluation harness,
  not a bot, administers evaluation environments.
- In Forgecrew's own repository, runtime code is tested deterministically in
  CI against the fake forge, skill and configuration evaluations are advisory
  until the benchmark can detect real differences, and smoke runs attach to
  deploys and run weekly on the default branch.

[evals.md](evals.md) describes how evaluations run.

## Project shape

- Open source from the first commit, Apache-2.0.
- **Public:** runtime, protocol, documentation, configuration schema and
  examples, CI. **Private, per deployment:** instance configuration
  (identities, served repositories, read scopes, allowed actors, keychain
  accounts), deployment code, recorded cases, archives, outcomes and benchmark
  data. Nothing hardcodes an owner, host, identity or vault.
- TypeScript on Node, strict: Octokit for GitHub, Microsoft's
  `azure-devops-node-api` for Azure DevOps, `@gitbeaker/rest` for GitLab, zod
  for response schemas (runtime validation and the JSON Schema in the prompt).
- Ports and adapters, in-tree, selected by configuration; no plugin system.

| Seam | Shape |
| --- | --- |
| forge | a domain-level port (discover, read change, claim, verdict, finding, publish, ready, merge); GitHub first, then Azure DevOps, GitLab later |
| harness | a box definition as data (command, environment, model, effort) plus a small parser per harness family for activity and token spend |
| keychain backend | list and get |
| isolation | start, mount, kill; bwrap first |

The fake forge is a real adapter from day one, backed by recorded cases. Every
forge adapter passes one shared contract-test suite. The core never imports an
adapter; `dependency-cruiser` enforces it in CI.

## Bootstrap

**Stage 0** is built through conversational development, until the minimal core
takes one issue to a merged change with the hard boundary in place:

- the forge port with the GitHub and fake adapters and the contract tests;
- dev-bot, review-bot and read-only scheduler identities; rulesets and
  CODEOWNERS;
- a minimal scheduler (discovery and keys);
- dispatchers with the lock, claim lifecycle, crash handling, timeouts,
  response validation and the mechanical rules, including allowed actors and
  the secret-leak filter;
- the broker, the bwrap sandbox, one bare box definition and per-role response
  schemas;
- outcome recording.

**Cutover:** from then on, every Forgecrew change starts as an issue.
Conversation keeps only deploys and break-glass.

**After cutover**, Forgecrew builds arbiter-bot, scheduler priority and
dependency holds, multiple instances, the evaluation harness, qa-bot for
product repositories, and the Azure DevOps adapter.

## Parked

- An upstream stage that refines issues into acceptance criteria the
  Accountable person confirms.
- Cross-repository writes: one piece of work producing changes in several
  repositories.
- Demo recordings.
- Azure DevOps and GitLab adapters and identities.
- Evaluation harness details beyond [evals.md](evals.md).

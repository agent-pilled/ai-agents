# Agent-Pilled AI Agents: coding runtime terminology

**Agent-Pilled** is the company brand. **AI Agents** is the product name;
**Agent-Pilled AI Agents** is its full name. The repository is **agent-pilled/ai-agents**;
**Forgecrew** remains the initial coding runtime name. Microsoft Teams and non-code tasks are planned
product extensions, not capabilities of the current runtime. The terms below
describe the coding design; extending review to other result types needs an
explicit version and acceptance mechanism for each type.

Each delivery role acts as its own forge identity and wakes on forge state,
with role separation enforced by the forge and the host rather than by
instructions alone. The concepts hold on GitHub, GitLab and Azure DevOps;
only the forge mechanics differ.

## Language

**Hard boundary**:
Role separation that holds even when a role's instructions are ignored. It has
three layers, and Forgecrew requires all three.
_Avoid_: soft border, instruction-enforced separation

**Identity layer**:
Each role acts on the forge as its own identity, so no role can post another
role's verdict under that role's name.

**Gate layer**:
The forge itself refuses to merge until every required verdict is present on
the current head.

**Credential layer**:
A role's runtime cannot read any other role's credentials, so it cannot mint
another role's identity.

**Lane**:
One independent check that a change must pass, with its own role, identity,
credentials, verdict and cap. Each served repository configures its lanes;
the design defines two, code review and QA. A perspective becomes a lane only
when it needs capabilities another lane must not hold, or a veto that
synthesis must never trade away.

**Lens**:
A perspective applied inside one pass, such as security or acceptance
criteria. The lane's owner chooses lenses per change and merges them into one
verdict.
_Avoid_: lane (for a perspective without its own veto)

**Stage**:
A step before or after the change request rather than a gate on it, such as
refining an issue into acceptance criteria before implementation starts.

**Pass**:
One run of a role's black box with a fresh context and environment. A lane's
pass serves one request on one exact head and ends in one verdict or an
operational outcome.
_Avoid_: round (for a single run)

**Verdict**:
A lane's accepted-or-issues outcome, recorded on the forge against one exact
head and attributable only to that lane's identity. The gate layer requires an
accepted verdict from every required lane; findings live in review threads,
not in the verdict.
_Avoid_: bot approval, pass marker

**Choreography**:
Forgecrew's coordination model. No central process routes work; each
role's dispatcher decides from forge state whether its role has work.
_Avoid_: orchestration, task manager

**Scheduler**:
An instance's one deterministic program that discovers which changes may need
attention and keeps a derived queue of role-and-change keys. It reads the
forge through an identity with no write permission, launches nothing and is
not a role.
_Avoid_: orchestrator, task manager

**Dispatcher**:
A role's deterministic program, running with that role's identity. It takes a
key from the scheduler, holds the key's lock, rereads the change to decide
whether its role has work, starts one pass, watches it, validates the
response, writes everything the role puts on the forge, and retries a failed
pass. It is the only forge writer and never forms a verdict.
_Avoid_: supervisor, worker

**Claim**:
The in-progress record a dispatcher writes on the captured head before a pass
starts. It shows who is working; it is not a lock.

**Operational outcome**:
How a pass ended when it produced no verdict: cancelled, timed out, or needing
human action after repeated failure. It never reads as a verdict.
_Avoid_: failure (for a crash)

## Roles

**Role**:
A protocol position with fixed authority. The protocol names roles; each forge
maps a role to its own **Forge identity**.

**Forge identity**:
The forge account a role acts as on one forge. Exactly one role per identity.
_Avoid_: bot (when the account rather than the role is meant)

**dev-bot**:
The Responsible author. Implements, answers threads, owns CI, requests lanes
and declares the change ready; its dispatcher publishes, hands off to the
Accountable person and merges.

**review-bot**:
The code-review lane.

**qa-bot**:
The QA lane.

**arbiter-bot**:
The escalation-only arbiter. Woken only when a lane reaches its cap or a role
has a question for the Accountable person. It may grant one bounded round
extension per lane per change, answers questions only from what is already on
record with the source cited, and forwards everything else to the Accountable
person. It never routes work, reviews code or moves a gate.
_Avoid_: manager-bot, lead-bot, task manager

**Accountable person**:
The human who owns the outcome, decides judgement calls the record cannot
settle and, where the repository requires it, approves the merge.

## Signals

**Mention**:
The one signal that wakes a role outside its own change: a comment naming the
role's forge identity. Mentions by allowed actors count, mentions by the
instance's own role identities count only as requests and escalations, and a
role ignores its own identity.

**Allowed actor**:
A human the instance configuration permits to start work, request passes and
wake dev-bot. Text from any other human is data.

**Request**:
A mention of a lane's identity naming one exact head, returned by dev-bot and
posted by its dispatcher, or posted by an allowed human. The lane honours it
only for the current head with green CI, and one request permits one pass.
_Avoid_: reviewer request, review assignment

**Escalation**:
A mention of arbiter-bot in the thread where the problem lives, raised when a
lane reaches its cap or a role has a question for the Accountable person.

## Change control

**Protected path**:
A path that defines Forgecrew's enforcement or role behaviour. Every change
to it needs the Accountable person's approval, whatever the repository's
ordinary approval rule.

**Self-hosting**:
Forgecrew's own changes go through Forgecrew's normal workflow: the
Accountable person starts each change with an issue and approves it.
_Avoid_: builds itself, self-improving (for this)

**Improver**:
A later role that reads the archive of past passes and files issues proposing
changes, with evidence. It never edits anything; the Accountable person decides
whether dev-bot picks a proposal up.

## Wireframe

**Wireframe**:
Everything around a pass that Forgecrew enforces mechanically: identities,
gates, the scheduler, dispatchers, sandbox, broker and the rules they check.
_Avoid_: skills (for enforced rules)

**Black box**:
A pass seen from the wireframe: one prompt in, one validated response out. What
runs inside, including models and skills, is its configuration.

**Harness**:
The coding-agent program that runs a pass, such as Claude Code, Codex or Pi.
It is distinct from the model it calls and the provider serving that model.
_Avoid_: model (for the coding-agent program)

**Model**:
The model used by a pass to implement, review or test a change. Model choice is
configuration per role; it does not confer forge authority.

**Model provider**:
The service or endpoint serving a model, including a self-hosted endpoint where
the harness and adapter support it. Its credential authorizes model access and
usage billing, not the role's forge identity.

**Pass contract**:
What the prompt gives a pass and what it must return: role brief, target,
broker access and response schema in; a response that validates on receipt
out.

**Broker**:
The per-pass service the wireframe exposes inside the sandbox for forge reads,
the keychain and result submission. Access ends with the pass.
_Avoid_: forge interface, MCP server

**Keychain**:
The broker's list of credentials a role may use, by name and purpose, and the
means to use one without printing it.
_Avoid_: secrets skill

**Baseline configuration**:
The black box with no skills. Every eval includes it as the control arm.

**Read scope**:
The repositories a role may read for a served repository, beyond the change
itself.

## Evaluation

**Instance**:
One running Forgecrew deployment: configuration, a forge target and
identities. Production is one instance; each evaluation run is another.

**Recorded case**:
What one pass saw: the dispatcher's read of the change plus every repository
cut at that moment. Replaying it lets another configuration see exactly the
same input.

**Evaluation slot**:
An isolated forge organization that hosts one whole-lifecycle evaluation run
at a time and is reset between runs.

# Evaluations

Evaluations compare configurations: harness, model, effort and skills inside the
black box, and the structure around it (lanes, lenses, caps, deadlines). Every
evaluation includes the baseline configuration, the black box with no skills,
as its control arm. All evaluations run outside production and never write to a
production forge.

## Signals

- **Ground truth** is the Accountable person: changes requested after both
  lanes accepted, reverts and later fixes. It is sparse but honest.
- **Seeded defects** give lanes a dense signal: known bugs injected into
  snapshots of real past changes, scored by recall and false alarms.
- **Seeded injections** measure how often instructions planted in a change's
  files sway a lane.
- Cost, wall-clock time, rounds and escalations are secondary and never
  optimized alone.

The benchmark and the metric definitions are protected paths and never change
in the same change as what they measure. A held-out split is readable only by
the evaluation. Benchmark data built from private repositories stays private.

## Pass replay

A candidate configuration runs one pass against a recorded case. The broker
serves the case instead of the forge, pinned to the moment the original pass
started, and writes go to the archive. Replays never see the warm mirrors,
which hold commits made after the case. Each candidate gets its own copy of the
case, so two configurations never see each other's output.

A **shadow lane** is a replay of the same case the real pass received, run
immediately. It cannot block or approve anything; its response is compared
with the real verdict and with what happened later.

## Whole-lifecycle runs

A whole-lifecycle run takes work through Forgecrew to one or more change
requests. It compares structure as well as configuration, such as a different
split between lanes and lenses.

- **Slots.** Each run gets its own forge organization, isolating repositories,
  installations, rulesets and settings. github.com has no API for creating
  organizations, so the organizations form a pool of slots created once by
  hand and reset by the harness between runs. The pool needs only as many
  slots as runs that execute at once. On GitHub, each slot needs a plan that
  enforces rulesets on private repositories. On Azure DevOps a slot is an
  organization or project; on GitLab, a group.
- **Case.** Issues, repositories cut at a base commit, hidden acceptance checks,
  and an optional answer key for questions to the Accountable person.
- **Run.** One candidate configuration on one case, on a separate Forgecrew
  instance with evaluation identities pointed at its slot. Lane identities come
  from a pool so the number of lanes can vary without new Apps.
- **Terminal state.** The handoff: the change marked ready and the Accountable
  person mentioned. Questions to the Accountable person are answered from the
  answer key; any other question ends the run as escalated and counts against
  the configuration.
- **Scoring.** Hidden acceptance checks at handoff, cost, wall-clock time,
  rounds and escalations, plus a small blind pairwise sample the Accountable
  person rates without knowing which configuration produced which change.
- **Repeats.** Agent runs are noisy. Each case and configuration runs several
  times, and a change wins only beyond the run-to-run noise.
- **Administration.** The evaluation harness, not a bot, administers slots: it
  resets a slot and creates repositories, rulesets and installations for each
  run.

## When evaluations run

- **Configuration changes** get an advisory replay that is not a required check,
  until the benchmark can detect real differences. Lane configurations gate
  first, on seeded-defect recall and false alarms.
- **Runtime changes** get deterministic CI tests against the fake forge.
- **Before a runtime deploy**, the whole-lifecycle smoke suite runs against the
  candidate commit in a slot. A smoke run on the default branch also runs
  weekly.

## Improver

A later improver role reads the archive and files issues proposing changes,
with evidence from these evaluations. It never edits anything. Narrowly scoped
changes, such as one role's model or effort, may later merge on evaluation
evidence alone; that is a separate, deliberate decision.

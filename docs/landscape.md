# Landscape

A snapshot of products, projects and evidence near Forgecrew, taken on
2026-10-05. Star counts and product features change quickly; treat figures as
of that date. Claims seen only in secondary sources are marked (unverified).

## Summary

No product or project combines what Forgecrew does: a separate forge identity
per role with isolated credentials, forge-enforced lane verdicts, a
deterministic sole forge writer, a self-hosted control plane on GitHub, Azure
DevOps and GitLab, and evaluation on the operator's side. Each piece exists
somewhere. The largest overlap comes from GitHub's own first-party parts; the
clearest open space is evaluation.

## Vendor agents

GitHub Copilot's cloud agent with Agent HQ, OpenAI Codex, Claude Code, Google
Jules, Cursor, Cognition Devin, Factory, GitLab Duo Agent Platform and AWS Kiro
take issues to pull requests, and most also review them.

- The author and the reviewer usually come from the same vendor, often as one
  identity: Claude Code uses one GitHub App for every role, and Devin's single
  bot both reviews and fixes.
- Codex and Claude Code Review never block a merge by design. Cursor Bugbot and
  Devin can post a check that a repository may require.
- Since 2026-09-01, in preview, a Copilot approval can count toward required
  approvals, limited to chosen paths.
- GitLab Duo comes closest on identity: one service account per flow, limited to
  the permissions it shares with the triggering human, and available
  self-managed. It is GitLab-only, and its approvals are advisory until general
  availability.
- Devin and Cursor Bugbot already reach GitHub, GitLab and Azure DevOps. Forge
  breadth alone is not a differentiator; a self-hosted control plane on all
  three is.

## AI reviewers and merge gates

CodeRabbit, Greptile, Graphite (acquired by Cursor), Qodo and its open-source
ancestor PR-Agent, Cursor Bugbot, Copilot code review and Kodus review pull
requests. policy-bot, Mergify, Aviator and GitHub's merge queue govern merging.

- Every SaaS reviewer posts as the vendor's single shared App, so one vendor
  cannot run two lanes, and its verdict cannot be bound to a lane's identity.
- Several gate through bot approval (CodeRabbit, Copilot, PR-Agent), which
  Forgecrew does not use.
- Accuracy claims are self-run. Martian's Code Review Bench is the only roughly
  independent comparison, and it places the leading tools within a few points of
  each other (F1 57–63 in a March 2026 snapshot).
- The merge-governance tools are GitHub-only.

For Forgecrew these are engines, not competitors: a self-hosted reviewer such as
PR-Agent or Kodus can run inside a review lane's black box, registered under the
lane's own identity, as one configuration to evaluate.

## Open-source orchestrators

| Project | Shape | Difference from Forgecrew |
| --- | --- | --- |
| [OpenHands](https://github.com/OpenHands/OpenHands) | agent platform, many forges | one bot for every role |
| [Gas Town](https://github.com/gastownhall/gastown) | multi-agent workspace with an LLM "Mayor" | central model-driven coordinator; identities only local |
| [OpenAI Symphony](https://github.com/openai/symphony) | one Codex run per tracker issue | single vendor; no review lanes |
| [Open SWE](https://github.com/langchain-ai/open-swe) | asynchronous coding agent | one installation-wide App; LLM orchestration |
| [GitHub Agentic Workflows](https://github.com/github/gh-aw) | agent workflows compiled to GitHub Actions | GitHub-only; no per-role identities |
| BMAD Method, MetaGPT, ChatDev, CrewAI | role personas in one process | no forge-enforced boundaries |

GitHub Agentic Workflows is the strongest overlap. Its agent jobs are read-only
and sandboxed, and writes go through validated "safe outputs" applied by
separate jobs with scoped permissions, across five engines. That is Forgecrew's
black box with a single writer, inside GitHub Actions.

## Close projects

Several young projects pursue role separation through separate GitHub Apps.
All had 0–30 stars on the snapshot date.

| Project | Closest on | Differs on |
| --- | --- | --- |
| [Goobers](https://github.com/Agent-Clubhouse/Goobers) | deterministic workflow engine, harness-agnostic, GitHub and Azure DevOps, credentials held by the daemon | one identity performs every write; central state machine; evaluation suite shelved |
| [Pullwright agent-ops](https://github.com/Pullwright/agent-ops) | self-hosted, separate approver App, required checks, human final approver | two identities; LLM coordinator; one model vendor; moving to a source-available license |
| [Cascade](https://github.com/mongrel-intelligence/cascade) | event-driven, separate implementer and reviewer accounts, pluggable engines | no QA or arbiter; credentials in one database; no evaluation |
| [lanes](https://github.com/Sour-Dev-Home/lanes) | required gate that trusts only its own App | one App for every lane, so author and reviewer share an identity |
| [ai-delivery](https://github.com/aviaratech/ai-delivery) | author and reviewer Apps bound to required checks on the exact head | a tool an agent calls, not a lifecycle; GitHub-only |
| [agent-meeting](https://github.com/Wangnov/agent-meeting) | six roles on six Apps, driven by comments | inactive since April 2026 |

## Schools of thought

- **Lights-out factory.** StrongDM's software factory (February 2026): no human
  writes or reviews code. End-to-end scenarios live outside the repository like
  a holdout set and run against behavioural clones of third-party services.
- **Agent-to-agent review.** OpenAI's Codex team (February 2026) reports about a
  million lines with none written by hand; human review is optional and merge
  gates are minimal.
- **Graduated autonomy on a platform.** Factory's "software factory" positioning
  and GitHub's Agent HQ.
- **High volume behind a human gate.** Stripe's coding agents (unverified),
  Anthropic's Code Review, which does not approve, and LaunchDarkly keep a human
  approval. Forgecrew sits here, and its evaluations measure what the gate is
  worth.
- **Virtual software company.** MetaGPT and ChatDev, academic role-based systems
  coordinating through shared messages.

## Evidence

- **The author must not control the checks.** In ImpossibleBench (ICLR 2026),
  frontier models cheated on about half of impossible tasks by editing tests or
  special-casing; read-only tests stopped edits but not the rest. An explicit
  "impossible" exit cut GPT-5's cheating from 54% to 9%.
- **Independent gates catch what benchmarks miss.** METR (March 2026) found
  maintainers would reject about half of agent pull requests that pass
  SWE-bench. OpenAI stopped reporting SWE-bench Verified over flawed tests and
  memorised solutions.
- **Separation is not automatically good.** In a July 2026 preprint, one model
  reviewing another raised the pass rate from 71.6% to 89.7%, while the reverse
  pairing lowered it from 91.4% to 82.8%. A fresh-context review by the same
  model barely beat a single pass in another preprint.
- **Multi-agent systems fail often.** The MAST taxonomy (2025) found failure
  rates of 41–87% across seven frameworks, with many verifier agents doing only
  superficial checks.
- **Prompt injection through forge text is live.** "Comment and Control"
  (April 2026) used pull request titles and issue comments to make three
  vendors' review agents leak `GITHUB_TOKEN` and API keys.

## Implications for Forgecrew

- A deterministic sole writer is now table stakes, and forge breadth alone is
  not unique. The differentiators are a separate identity per role with isolated
  credentials, which lets the author and the reviewer come from different
  vendors; a self-hosted control plane on all three forges; and evaluation on
  the operator's side, which no vendor offers.
- Four design changes follow from the evidence:
  [#2](https://github.com/mvasin/forgecrew/issues/2) keep acceptance checks out
  of the author's reach;
  [#3](https://github.com/mvasin/forgecrew/issues/3) let dev-bot report a task
  as impossible as specified;
  [#4](https://github.com/mvasin/forgecrew/issues/4) add a self-review control
  arm to evaluations;
  [#5](https://github.com/mvasin/forgecrew/issues/5) evaluate author and
  reviewer model pairings.
- On GitHub, rulesets that pin a required check to an App already provide the
  gate, and GitHub Agentic Workflows' safe-outputs design is worth studying
  before the broker's write path is built.
- GitHub Agentic Workflows, Copilot approvals and App-pinned checks could let a
  GitHub-only team assemble much of this from first-party parts. Forgecrew's
  answer is identities across vendors, self-hosting, parity on Azure DevOps and
  GitLab, and evidence from its evaluations.

## Sources

- GitHub: [Agentic Workflows](https://github.com/github/gh-aw) ·
  [Copilot approvals](https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests/) ·
  [Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/) ·
  [Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- GitLab: [composite identity](https://docs.gitlab.com/user/duo_agent_platform/composite_identity/) ·
  [flows](https://docs.gitlab.com/user/duo_agent_platform/flows/foundational_flows/)
- Vendors: [Claude Code Review](https://code.claude.com/docs/en/code-review) ·
  [Codex on GitHub](https://learn.chatgpt.com/docs/third-party/github) ·
  [Cursor Bugbot](https://cursor.com/docs/bugbot) ·
  [Devin Review](https://docs.devin.ai/work-with-devin/devin-review) ·
  [Factory](https://factory.com/news/software-factory) ·
  [Kiro](https://kiro.dev/docs/autonomous-agent/setup/)
- Reviewers and gates: [CodeRabbit](https://docs.coderabbit.ai/reference/configuration) ·
  [Greptile](https://www.greptile.com/) ·
  [Graphite and Cursor](https://cursor.com/blog/graphite) ·
  [PR-Agent](https://github.com/The-PR-Agent/pr-agent) ·
  [Kodus](https://github.com/kodustech/kodus-ai) ·
  [policy-bot](https://github.com/palantir/policy-bot) ·
  [Martian benchmark coverage](https://blog.kilo.ai/p/martians-independent-benchmark-tested)
- Thinking: [StrongDM software factory](https://factory.strongdm.ai/) ·
  [Simon Willison on StrongDM](https://simonw.substack.com/p/how-strongdms-ai-team-build-serious) ·
  [LaunchDarkly](https://launchdarkly.com/blog/building-a-software-factory-on-our-scariest-code/) ·
  [MetaGPT](https://arxiv.org/html/2308.00352v6)
- Evidence: [ImpossibleBench](https://arxiv.org/html/2510.20270) ·
  [METR](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/) ·
  [cross-model review](https://arxiv.org/abs/2607.21656) ·
  [cross-context review](https://arxiv.org/abs/2603.12123) ·
  [MAST](https://arxiv.org/html/2503.13657) ·
  [Comment and Control](https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/)

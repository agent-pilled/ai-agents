# Landscape

A snapshot of products, projects and evidence near Forgecrew, taken on
2026-10-05, with agent runtimes added on 2026-10-06. Star counts and product
features change quickly; treat figures as of those dates. Claims seen only in
secondary sources are marked (unverified).

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

## Agent runtimes and sandboxes

Managed agent runtimes and sandbox services are infrastructure that could sit
under Forgecrew, not competitors to it. None replaces the protocol, identities,
scheduler, dispatchers or evaluations. They fall into three groups.

**Vendor-run agent loops.** Claude Managed Agents, the OpenAI Agents API,
Bedrock Managed Agents and Google's Managed Agents API run the vendor's own
agent loop; their self-hosted modes only execute tool calls on the operator's
machine. At most one could serve as a box configuration to evaluate. Each is
locked to one model family, billed through API keys and sends tool traffic to
the vendor.

**Hosted sandboxes for an unmodified harness.** DigitalOcean Managed Agents
(public preview since 2026-09-22) is the closest match to a pass: one
Firecracker microVM per session, Claude Code and Codex adapters, and checkpoint
and fork. AWS AgentCore Runtime, Azure Foundry hosted agents, Google Agent
Runtime, E2B, Modal, Vercel Sandbox, Fly Sprites, Northflank and Cloudflare
Sandboxes also run unmodified CLIs. They are candidates for remote adapters of
the isolation port, with frictions:

- A remote sandbox cannot reach a broker on a Unix socket
  ([#8](https://github.com/agent-pilled/ai-agents/issues/8)).
- The worktree and credentials leave the operator's infrastructure.
  DigitalOcean puts secrets in the sandbox as environment variables.
- Idle limits clash with long passes: DigitalOcean suspends after 15 minutes
  without model or tool calls, AgentCore defaults to an 8-hour session with a
  15-minute idle timeout, and Cloudflare allows at most 6 hours of inactivity
  and replaces instances during rollouts.
- Compute costs about $0.05–0.25 an hour, small next to tokens.

E2B's infrastructure (Apache-2.0), GKE Agent Sandbox and microsandbox are
open-source options that fit self-hosting. Daytona moved to closed source in
2026.

**Platform patterns worth borrowing.**

- Credentials injected at egress, so the value never enters the sandbox
  (Vercel Sandbox, Cloudflare Outbound Workers, Claude Managed Agents vaults,
  the OpenAI Agents API proxy) ([#7](https://github.com/agent-pilled/ai-agents/issues/7)).
- One lock object per key, as with a Cloudflare Durable Object per
  `(role, change)`, if a role ever spans hosts.
- Checkpoint and fork as fixed starting states for replays.
- Per-agent workload identities (AgentCore Identity, Entra agent IDs, SPIFFE)
  as per-role identities for cloud resources.

**Billing terms.** Anthropic permits signing in to the unmodified Claude Code
binary with one's own subscription, including on hosted platforms. Products
built on the Agent SDK must use API keys, credentials may not be collected,
stored or intermediated, and Pro and Max limits assume ordinary, individual
usage. A Claude box therefore drives the CLI, and API-key billing needs to be a
first-class option ([#9](https://github.com/agent-pilled/ai-agents/issues/9)).

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
  pairing lowered it from 91.4% to 82.8%. In another preprint (revised October
  2026), Claude Opus 4.6 reviewed its own 30 artifacts, which held 150 injected
  errors. A fresh-session review scored an F1 of 28.6%, a single same-session
  review 27.1% (two of three runs, since one run's records could not be
  verified) and a second same-session review 21.7%. Averaged across runs, only
  the lead over the second review was statistically significant. The paper says
  it has not established whether a fresh session beats a single self-review.
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
  [#2](https://github.com/agent-pilled/ai-agents/issues/2) keep acceptance checks out
  of the author's reach;
  [#3](https://github.com/agent-pilled/ai-agents/issues/3) let dev-bot report a task
  as impossible as specified;
  [#4](https://github.com/agent-pilled/ai-agents/issues/4) add a self-review control
  arm to evaluations;
  [#5](https://github.com/agent-pilled/ai-agents/issues/5) evaluate author and
  reviewer model pairings.
- Agent runtimes suggest three more changes:
  [#7](https://github.com/agent-pilled/ai-agents/issues/7) inject keychain
  credentials at egress;
  [#8](https://github.com/agent-pilled/ai-agents/issues/8) keep the broker's
  transport independent of the Unix socket;
  [#9](https://github.com/agent-pilled/ai-agents/issues/9) ship an API-key path for
  Claude boxes and document subscription use.
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
- Runtimes: [DigitalOcean Managed Agents](https://www.digitalocean.com/blog/managed-agents-public-preview) ·
  [DigitalOcean limits](https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/) ·
  [Cloudflare Agents](https://developers.cloudflare.com/agents/) ·
  [Cloudflare coding agents](https://developers.cloudflare.com/sandbox/coding-agents/) ·
  [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) ·
  [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) ·
  [AgentCore for coding agents](https://aws.amazon.com/blogs/machine-learning/its-safe-to-close-your-laptop-now-hosting-coding-agents-on-amazon-bedrock-agentcore/) ·
  [Azure Foundry hosted agents](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents) ·
  [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) ·
  [E2B infrastructure](https://github.com/e2b-dev/infra) ·
  [GKE Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox) ·
  [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
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

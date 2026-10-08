# Agent-Pilled AI Agents

Open-source AI agents that complete tasks through independent review, with your
choice of tools, models and providers. The planned interaction starts with a
mention in Microsoft Teams and returns a reviewed result to the conversation.
Coding is the first workflow; reports, documents and other work are planned.

**In development, not usable end to end.** Teams integration and non-code
workflows have not shipped. The repository is **agent-pilled/ai-agents**; the initial coding runtime
keeps the name **Forgecrew**. Its current technical design takes GitHub issues through
implementation, independent review and merge, with separate forge identities,
fresh sandboxes and required verdicts on the exact commit. The forge and host
enforce role separation. Azure DevOps and GitLab remain future adapters.

[docs/design.md](docs/design.md) records the product direction and the coding
runtime design; [CONTEXT.md](CONTEXT.md) defines the runtime terms.

The product site is [agents.agent-pilled.com](https://agents.agent-pilled.com/),
with source in `site/`. [Agent-Pilled](https://agent-pilled.com/) is the company
brand, with room for multiple products. Engineering Analytics is a future
product direction, not an available product.

## Harness, model and provider choice

These are separate choices, configured per role:

- **Harness:** the coding-agent program that runs the pass. Claude Code is the
  first target; Codex and [Pi](https://pi.dev) adapters are planned.
- **Model:** the model used to implement or review a change, such as Claude or
  an open-weight model.
- **Provider:** the service or endpoint serving that model. The planned Pi
  adapter is the path to multiple providers and self-hosted models through
  supported custom endpoints.

An illustrative planned pairing is a Claude Code author using Claude and a Pi
reviewer using an open-weight model. That is a configuration to evaluate, not a
proven quality claim. Supported combinations depend on the harness, adapter,
provider and sign-in path; arbitrary combinations and equal performance are not
promised. Provider credentials remain distinct from each role's forge
credentials. [The design](docs/design.md#harness-model-and-provider-choice)
describes the boundaries and sign-in paths.

## Free core and enterprise plans

The Apache-2.0 core stays free, including role isolation and the exact-head
review and merge gates. Paid enterprise capabilities are planned for
organization administration, audit and reporting, policy deployment and
support; they have not shipped. Model usage and hosting are separate costs.

Teams interested in a pilot can [open an issue](https://github.com/agent-pilled/ai-agents/issues/new)
with their workflow and deployment requirements.

## Development

Forgecrew is TypeScript on Node 24 (see [.nvmrc](.nvmrc)), managed with
[pnpm](https://pnpm.io). A recent pnpm switches to the version pinned in
`package.json` by itself.

```sh
pnpm install
pnpm check      # everything CI runs
```

| Command          | Does                                              |
| ---------------- | ------------------------------------------------- |
| `pnpm test`      | runs the tests with Vitest                        |
| `pnpm lint`      | checks lint rules, formatting and import order    |
| `pnpm fix`       | applies the formatting and safe lint fixes        |
| `pnpm typecheck` | type-checks the code in strict mode               |
| `pnpm deps`      | checks the core's import rules (below)            |

## Layout

- `src/core` holds the domain and the ports. It never imports an adapter or a
  forge SDK such as Octokit, directly or through another module.
- `src/adapters` holds one directory per seam: `forge`, `harness`, `keychain`
  and `isolation`. Configuration will select the adapter for each seam.
- `tools` holds operator tooling that is not runtime code, such as the helper
  that registers the GitHub Apps ([docs/github-apps.md](docs/github-apps.md)).
- `site` holds the AI Agents landing page, plain HTML and CSS. Every push to
  `main` that touches it deploys it to GitHub Pages at `agents.agent-pilled.com`.
  The company homepage has a separate repository and Pages deployment.
- `test` holds the tests, outside `src` so that a test can wire the core to an
  adapter, such as the fake forge. `test/forge/contract.test.ts` specifies the
  forge port, and every forge adapter must pass it.

`dependency-cruiser` enforces the first rule, locally with `pnpm deps` and in
CI. Relative imports spell out the `.ts` extension, so Node can run the source
as it is.

## License

[Apache-2.0](LICENSE)

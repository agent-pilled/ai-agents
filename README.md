# Forgecrew

Forgecrew turns issues into reviewed, merged changes. Each delivery role, from
the author to the code reviewer and QA, acts as its own forge identity and runs
in its own sandbox. The forge and the host enforce the separation between
roles, not instructions alone. GitHub comes first; Azure DevOps and GitLab
follow.

The project is in development and not usable yet.
[docs/design.md](docs/design.md) describes the design and
[CONTEXT.md](CONTEXT.md) defines its terms.

The site at [mvasin.github.io/forgecrew](https://mvasin.github.io/forgecrew/)
says what Forgecrew will do for you and where it stands; its source is in
`site/`.

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
- `site` holds the project's landing page, plain HTML and CSS. Every push to
  `main` that touches it deploys it to GitHub Pages.
- `test` holds the tests, outside `src` so that a test can wire the core to an
  adapter, such as the fake forge. `test/forge/contract.test.ts` specifies the
  forge port, and every forge adapter must pass it.

`dependency-cruiser` enforces the first rule, locally with `pnpm deps` and in
CI. Relative imports spell out the `.ts` extension, so Node can run the source
as it is.

## License

[Apache-2.0](LICENSE)

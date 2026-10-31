# The forge says no

Step one is scripted. No model writes or reviews code yet; this shows the forge enforcement, not agent quality.

dev-bot opens a pull request, calls merge, and GitHub refuses. dev-bot then
posts check runs named `review` and `qa` with a success conclusion, and GitHub
refuses again: the ruleset binds each context to that lane's App through
`integration_id`. review-bot accepts the exact head, dev-bot pushes one more
commit, and the old acceptance does not carry over. review-bot accepts the new
head, qa-bot runs the repository's tests locally and accepts that same head,
and only then does GitHub let dev-bot merge. The pull request body is
`Fixes #n`, so the issue closes with the merge.

The verdict text on each check run says it is scripted. Steps after this one,
Claude Code as review-bot through the bwrap kit and then as dev-bot, are out
of scope here.

A person does every step below. Nothing in this repository creates a GitHub
App, a repository, a ruleset or a token by itself.

## What you need

- Node 24 (see [.nvmrc](../.nvmrc)).
- A GitHub user who can create Apps and a public repository.
- `GH_TOKEN`, a token that can create issues and rulesets on the demo
  repository. The run uses it only to file the issue. The ruleset command uses
  it only when you pass `--apply`.
- [asciinema](https://asciinema.org/) and [agg](https://github.com/asciinema/agg)
  if you want a recording.

## 1. Create the demo repository

Create a new empty public repository whose default branch is `main`. From
[tools/demo/template](../tools/demo/template), push the program and leave out
`ISSUE.md` and `patches/`. Those stay in this checkout: the script reads them
here, and the demo repository starts with the bug.

`add` subtracts. `node --test` in the template fails until the script's first
patch.

## 2. Register the three Apps

Register dev-bot, review-bot and qa-bot with the helper in
[docs/github-apps.md](github-apps.md). Install each on the demo repository
only. dev-bot has `checks: write` on purpose, so the run can post a check the
ruleset must ignore. review-bot still has no `contents: write`, so it cannot
merge.

Put each App id and private key where the next command can read them. The key
files should not sit inside a Git work tree.

## 3. Apply the ruleset

Print the ruleset, which does not call GitHub:

```sh
node tools/demo/ruleset.ts --repo owner/name --review-app-id REVIEW_APP_ID --qa-app-id QA_APP_ID
```

The body has no bypass actors. It blocks deletion and non-fast-forward pushes.
A pull request needs no approving review. `review` is required from the
review-bot App id, and `qa` from the qa-bot App id. The strict status policy
is off, so the branch need not be up to date.

Apply it, or update the ruleset named `forgecrew-demo` if you run this again:

```sh
GH_TOKEN=... node tools/demo/ruleset.ts --repo owner/name \
  --review-app-id REVIEW_APP_ID --qa-app-id QA_APP_ID --apply
```

## 4. Run the script

```sh
export FORGECREW_DEV_APP_ID=...
export FORGECREW_DEV_KEY_FILE=...
export FORGECREW_REVIEW_APP_ID=...
export FORGECREW_REVIEW_KEY_FILE=...
export FORGECREW_QA_APP_ID=...
export FORGECREW_QA_KEY_FILE=...
export GH_TOKEN=...

node tools/demo/run.ts --repo owner/name
```

The script exits non-zero if GitHub's answer is not the one the scenario
expects. It prints the pull request URL at the end.

## 5. Record

```sh
asciinema rec -c "node tools/demo/run.ts --repo owner/name --pause 1500" demo.cast
agg demo.cast demo.gif
```

`--pause` waits between the printed steps. The cast and the gif stay out of
this repository unless you decide otherwise.

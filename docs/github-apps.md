# Creating the GitHub Apps

On GitHub, each forge identity is a GitHub App, and a person has to click to
create one. M1 needs two: the **review-bot** App, which is the code-review
lane's identity, and the **scheduler** App, which has no write permission at
all. The registration helper in [tools/github-apps](../tools/github-apps)
reduces each App to one prefilled GitHub page and one click. Nothing here
creates an App by itself, and no bot may change an App's permissions or
installations ([Change control](design.md#change-control)).

Both Apps poll and receive no webhooks ([ADR 0004](adr/0004-polling-with-a-derived-scheduler.md)),
and both are private, so each installs only on the account that owns it.

## Before you start

- Node 24 (see [.nvmrc](../.nvmrc)). The helper uses nothing but Node, so it
  needs no `pnpm install`.
- A browser signed in to GitHub as a user who may create Apps for the owner:
  the owner's own account, or an owner or App manager of the organization.
  Run the command on the machine with that browser, because GitHub redirects
  the browser to a port on `127.0.0.1`.
- A name for each App. Names are unique across GitHub, at most 34 characters,
  and chosen by the instance; the repository never names them.
- The **owner**: create each App under the account or organization that owns
  the repositories the instance serves, because a private App installs only
  there.
- An output directory outside any Git repository. The helper refuses a
  directory inside a work tree, since the key would sit one `git add` away
  from publication.

## Create an App

```sh
node tools/github-apps/register.ts --app review-bot --name "<App name>" --out <directory>
node tools/github-apps/register.ts --app scheduler  --name "<App name>" --out <directory>
```

Add `--org <organization>` when an organization owns the repositories; without
it the App belongs to your personal account. `--help` lists the other options.

For each App:

1. Run the command. It prints the address of a local page; open it.
2. Click **Continue to GitHub**. GitHub shows its registration form, filled in
   from the manifest. Check that the name is the one you chose, that
   **Webhook > Active** is unticked, that the permissions match the tables
   below, and that the App can be installed **Only on this account**.
3. Click **Create GitHub App**. GitHub redirects back to the local page, and
   the command saves two files in the output directory, readable by you only:
   `<slug>-<id>.app-id` and `<slug>-<id>.private-key.pem`, or `app-<id>` in
   place of `<slug>-<id>` when GitHub's slug is not safe in a file name. It
   never prints the key.
4. Move the private key into the role's keychain account, then delete the
   file. Put the App ID in the instance's private configuration. Each role's
   key stays where only that role can read it
   ([Credentials](design.md#credentials)).
5. Install the App with the link the command printed: choose the owner's
   account, then **Only select repositories**, and pick the repositories the
   instance serves. Install both Apps on the same repositories.

The helper does not keep the App's client secret or webhook secret, because
Forgecrew uses neither. The App's settings page lets you delete the unused
client secret if you want no unused secret to exist.

The helper waits up to one hour for GitHub's redirect, which is GitHub's limit
for the whole flow, and the temporary code works once. If the connection to
GitHub drops during the exchange, or GitHub answers with a server error or a
rate limit, the page says so; reload it to try again.

Once you have clicked **Create GitHub App**, the App exists and its name is
taken, so a failure after that cannot be fixed by running the command again
with the same name. The message names the page to open: generate a private key
on the App's settings page, then move it into the keychain and delete the
downloaded file, or delete the App and start again.

## Permissions

Each permission is the least that its role needs, and each cites the sections
of [the design](design.md) that call for it. Every permission is repository
scoped.

### review-bot

| Permission | Access | Why | Design |
| --- | --- | --- | --- |
| `checks` | write | Create and update the lane's check run: the claim on the captured head, then the verdict the ruleset requires. | Verdicts and gates, Dispatcher |
| `contents` | read | Fetch the change into the warm mirrors and read the base branch's agent instruction files; never write, so it cannot merge. | Broker, Environment |
| `issues` | read | Read the linked issue and its comments within the role's read scope. | Broker |
| `metadata` | read | Repository metadata, which GitHub adds read-only to any App with repository permissions; listed so the manifest shows the whole set. | Dispatcher |
| `pull_requests` | write | Post findings and replies in review threads and comment on the change to escalate; never submit an approval. | Pass contract, Rounds and escalation |
| `statuses` | read | Read commit statuses to tell whether CI is green on the head; check runs come with the checks permission. | Signals |

GitHub has no permission that allows review comments but not approvals, so
that line is held by the wireframe: the dispatcher is the only forge writer
and never submits an approval ([ADR 0002](adr/0002-lane-verdicts-are-identity-bound-checks.md),
[Mechanical rules on the way out](design.md#mechanical-rules-on-the-way-out)).
Merging a pull request needs `contents: write`, which neither App holds.

### scheduler

| Permission | Access | Why | Design |
| --- | --- | --- | --- |
| `checks` | read | See completed CI, completed lane verdicts and in-progress claims that no dispatcher holds. | Scheduler, Signals, Failure handling |
| `issues` | read | Find mentions on issues and read issue relations such as blocked_by. | Scheduler, Signals |
| `metadata` | read | Repository metadata, which GitHub adds read-only to any App with repository permissions; listed so the manifest shows the whole set. | Dispatcher |
| `pull_requests` | read | List changes with their heads, comments and reviews updated since the last poll. | Scheduler |
| `statuses` | read | See completed commit statuses, which count as CI beside check runs. | Signals |

Neither App has `administration` or `workflows`. To change an App's
permissions later, edit the App by hand; the owner of each installation then
accepts the new request.

## What the M1 ruleset references

The ruleset that M1 adds by hand requires the review lane's check run. It is a
**Require status checks to pass before merging** rule that lists the check
by name and sets its source to the review-bot App. In the API, that is an entry
in `required_status_checks` with `context` set to the check run's name and
`integration_id` set to the App's ID, the number in `<slug>-<id>.app-id`. The
review dispatcher chooses the check run's name in M1. With a source set, only
that App can satisfy the check, so no other identity can post the verdict
([ADR 0002](adr/0002-lane-verdicts-are-identity-bound-checks.md)). The policy
is loose, since branches need not be up to date
([Handoff and merge](design.md#handoff-and-merge)). The scheduler App appears
in no ruleset.

## Sources

- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
  for the manifest parameters, the redirect with `code` and `state`, and the
  one-hour limit.
- [Create a GitHub App from a manifest](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest)
  for the conversion and its response.
- [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
  for what each permission allows, and
  [Create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
  for the permission names.
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
  for the name rules, and
  [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
  for where a private App can be installed.
- [Create a repository ruleset](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset)
  for `integration_id` on a required status check.

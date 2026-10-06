# Spike: Claude Code headless in bwrap

This spike retires the first technical risk of M0 ([design](../../docs/design.md#bootstrap)):
can Claude Code run headless inside bwrap with a fresh HOME, a token from
`claude setup-token`, and network limited to the model API and the broker?
It records what works, what leaks and what the harness writes to HOME.

**Status: run on 2026-10-06, with a placeholder token and with a real one.**
The harness answered inside the sandbox, its network held to the model API,
and one leak is open. See [Results](#results).

## How it works

`--unshare-net` leaves the sandbox with a loopback interface and nothing else,
so allowed traffic comes in through a proxy bridged over a Unix socket:

```text
host                                         sandbox (bwrap, every namespace unshared)

egress proxy  <== proxy.sock  ============== bridge on 127.0.0.1:3128 <-- HTTPS_PROXY -- claude --print
  allowlist, JSON log                                                                      |
broker stub   <== broker.sock ============== /run/forgecrew/broker.sock <-- probes          |
token file --> run.sh --> descriptor 3 ----> sandbox-entry.sh --> CLAUDE_CODE_OAUTH_TOKEN --+
```

1. `run.sh` checks the prerequisites, creates a run directory with a fresh
   HOME, tmp and workspace, and starts the egress proxy and the stub broker
   on two Unix sockets.
2. It starts bwrap through `env -i`, so bwrap receives an empty environment,
   with every namespace unshared, `--as-pid-1`, `--die-with-parent`,
   `--new-session`, `--clearenv`, a read-only root that holds only `/usr` and
   a few files from `/etc`, and writable binds for HOME, `/tmp`, `/workspace`
   and the output channel `/out`. The two sockets are mounted at
   `/run/forgecrew/`.
3. The token travels on descriptor 3, a pipe that bwrap hands to the sandboxed
   process. It never appears in an argument, a file the kit writes or the
   environment of any process but the harness.
4. Inside, `sandbox-entry.sh` reads and closes descriptor 3, starts the bridge,
   runs the leak probes, then runs
   `claude --print --output-format stream-json --verbose` with a one-word
   prompt. The token and the proxy settings are exported only to the harness.
   A SessionStart hook ([`hook-probe.sh`](hook-probe.sh)) shows what a
   subprocess of the harness can see.
5. After the run, `run.sh` lists what was written to HOME, `/tmp` and the
   workspace, scans every output for the token, and prints a summary.

The egress proxy, the bridge, the broker stub, the probes and the summary are
TypeScript on Node built-ins only ([`cli.ts`](cli.ts) is their entry point).
Claude Code's own sandbox relies on bwrap and `socat` for the same job
([sandboxing](https://code.claude.com/docs/en/sandboxing)); a Node bridge
needs no extra package and logs JSON.

## Prerequisites

- A Linux host with unprivileged user namespaces. On Ubuntu 24.04 and later,
  AppArmor blocks them for bwrap until a profile allows it; Claude Code's
  [sandboxing guide](https://code.claude.com/docs/en/sandboxing) shows the
  profile. `run.sh` tests this and prints the relevant settings if it fails.
- bubblewrap 0.5.0 or later (for `--clearenv`), bash 4.4 or later, and GNU
  coreutils and findutils (`timeout`, `find -printf`, `sort -V`).
- Node.js 24 or later. No `pnpm install` is needed.
- The native Claude Code binary, from the native installer or npm. A script
  launcher cannot run alone in the sandbox.
- A token from `claude setup-token`, in a file only you can read.
- Outbound HTTPS from the host to `api.anthropic.com`.

## Run it

```sh
# On any machine where you can sign in; it prints the token.
claude setup-token

# On the Linux host: save the token without echoing it or passing it as an argument.
bash -c 'umask 077 && read -rsp "token: " t && printf "%s\n" "$t" > ~/.forgecrew-spike-token'

spikes/bwrap-claude/run.sh --token-file ~/.forgecrew-spike-token
```

`run.sh --dry-run --token-file FILE` prints the bwrap command without
starting anything. `run.sh --help` lists the options: extra `--allow
HOST:PORT` entries for the proxy, another `--prompt`, explicit `--claude` and
`--node` binaries, a `--timeout`, and `--no-scrub`, which leaves
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` unset to compare runs with and without it.

The run directory holds the sandbox HOME, which may hold credentials. Delete
it when done; `run.sh` prints the command.

## What a run produces

| Path in the run directory | Holds |
| --- | --- |
| `summary.txt` | the summary `run.sh` prints at the end; an expected probe that reported nothing counts as a failure, and non-empty kit logs are shown. It quotes the harness's text and the kit's logs only when the outputs scan in `host/probes.jsonl` passed, reads only regular files, never through a symbolic link, and prints no control characters |
| `probes.jsonl` | every probe result, one JSON line each: `probe`, `result` (`pass`, `fail` or `info`), `detail` |
| `sandbox-out/stream.jsonl` | the harness's `stream-json` output |
| `sandbox-out/harness-stderr.log`, `harness-exit-code` | the harness's stderr and exit status |
| `sandbox-out/harness-started-at` | when the harness started, which splits the proxy log into the probes' attempts and the harness's |
| `sandbox-out/bridge.jsonl` | connections through the bridge |
| `host/proxy.jsonl` | every egress attempt, allowed or denied, with bytes per tunnel; host and port only, never a path |
| `host/broker.jsonl` | requests to the stub broker |
| `host/home-files.tsv`, `tmp-files.tsv`, `workspace-files.tsv` | type, mode, size and path of everything the harness wrote, never contents |
| `host/bwrap-command.txt`, `bwrap-version.txt`, `bwrap.log`, `bwrap-exit-code` | the exact bwrap command, its version, the sandbox's own messages and its exit status (124 means the timeout hit) |
| `home/`, `tmp/`, `workspace/` | the sandbox's HOME, `/tmp` and working directory, kept for inspection |

## Probes

A probe passes when the sandbox holds and fails when something leaks. `info`
records an observation with no pass condition.

The probes inside the sandbox report from inside it, so a harness that controls
the sandbox could forge their lines in `/out`. The token probes that `run.sh`
runs on the host write to `host/probes.jsonl`, which nothing inside can write,
and the summary takes its decision to quote file content from that file only.

| Probe | Checks |
| --- | --- |
| `net-interfaces` | only loopback interfaces exist |
| `net-direct-tcp-ipv4`, `net-direct-tcp-ipv6` | a direct connection to a public address fails |
| `net-dns-system`, `net-dns-direct` | name resolution fails, through the system resolver and against a public DNS server |
| `net-abstract-sockets` | no abstract Unix socket, such as a host X11 or D-Bus socket, is visible |
| `proxy-allows-model-api` | CONNECT to the first allowed target answers 200 through the bridge |
| `proxy-denies-other` | CONNECT to `example.com:443` answers 403 |
| `broker-reachable` | the broker serves `/openapi.json` on its socket |
| `fs-host-home-absent` | the host's HOME path does not exist |
| `fs-ssh-material-absent` | no `~/.ssh`, `/root/.ssh`, `/etc/ssh` or `/run/user/UID` (agent sockets) |
| `fs-other-users-absent` | `/etc/passwd` and `/home` hold only the sandbox user; no `/root` or `/etc/shadow` |
| `fs-writes-refused` | writes fail on `/`, `/usr`, `/etc`, `/opt/forgecrew/*` and `/run/forgecrew/*` |
| `fs-writes-accepted` | writes work in HOME, `/tmp`, `/workspace` and `/out` |
| `env-host-absent` | the environment holds only the variables the kit sets |
| `proc-host-processes-invisible` | only the sandbox's own processes are visible, each named by its `argv[0]` |
| `proc-launcher-env-absent` | no environment readable inside holds the canary variable `run.sh` exports in its own environment, so the launcher's environment stays out |
| `proc-launcher-argv-absent` | no process inside exposes bwrap's own command line and its host paths |
| `proc-no-capabilities` | the effective capability set is empty |
| `proc-entry-fds-clean` | the entry script holds no descriptor beyond stdio and its script, so descriptor 3 is closed |
| `token-absent-from-sandbox-argv` | no process argument in the sandbox held the token while the harness ran |
| `token-in-harness-environ` | info: whether the harness's environment holds the token |
| `hook-env-names` | info: the variable names a harness subprocess receives |
| `hook-env-token-absent` | a harness subprocess does not receive `CLAUDE_CODE_OAUTH_TOKEN` |
| `hook-harness-environ-unreadable` | a harness subprocess cannot read the token from any `/proc/PID/environ` it can see, ancestor or not |
| `token-absent-from-host-argv` | no process argument on the host held the token while the sandbox ran |
| `token-absent-from-outputs` | no output file holds the token |
| `token-absent-from-home` | the harness did not write the token into HOME, `/tmp` or the workspace |

The token checks compare inside bash with `[[ ]]`, or with
`grep -F -f <(printf ...)`, so the token never becomes an argument itself.

## Choices and their sources

- **No `--bare`.** Bare mode skips the host's hooks, plugins and CLAUDE.md,
  but it does not read `CLAUDE_CODE_OAUTH_TOKEN`
  ([authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)).
  The fresh HOME gives the same isolation from host configuration.
- **The token as the harness's environment.** `CLAUDE_CODE_OAUTH_TOKEN` is the
  documented way to use a `claude setup-token` token
  ([authentication](https://code.claude.com/docs/en/authentication#authentication-precedence));
  no file-descriptor variant is documented. The design accepts this until
  credentials are injected at egress
  ([#7](https://github.com/mvasin/forgecrew/issues/7)).
- **Proxy.** Claude Code reads `HTTPS_PROXY` and does not support SOCKS
  ([network configuration](https://code.claude.com/docs/en/network-config#proxy-configuration)).
  The default allowlist holds only `api.anthropic.com:443`, which serves model
  requests. The same page lists the other hosts Claude Code may contact; any
  attempt to reach them shows as denied in the proxy log, and `--allow` adds
  one for a second run.
- **Quiet harness.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off
  auto-updates, telemetry, error reporting and feature-flag fetching;
  `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING` are
  set too for clarity, and `ENABLE_CLAUDEAI_MCP_SERVERS=false` stops fetching
  claude.ai connectors
  ([environment variables](https://code.claude.com/docs/en/env-vars),
  [data usage](https://code.claude.com/docs/en/data-usage#telemetry-services)).
- **Subprocess scrub.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials
  from the environments of Bash commands, hooks and MCP servers, and on Linux
  runs Bash commands in their own PID namespace
  ([environment variables](https://code.claude.com/docs/en/env-vars#what-the-subprocess-environment-scrub-removes)).
  The hook probes measure what remains.
- **SessionStart hook.** Hooks from `--settings` run in `-p` mode
  ([hooks](https://code.claude.com/docs/en/hooks#sessionstart)), which makes
  the subprocess probes independent of what the model decides to do.
- **Descriptor 3.** bwrap passes inherited descriptors on to the sandboxed
  process; only its own helper processes close them
  ([bubblewrap source](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c)).
  The entry script closes descriptor 3 before it starts anything else.
- **An empty launch environment and `--as-pid-1`.** Without `--as-pid-1`,
  bwrap leaves a reaper as PID 1 inside the sandbox. That reaper keeps the
  environment and the arguments bwrap was started with in `/proc/1/environ`
  and `/proc/1/cmdline`, whatever `--clearenv` gives the sandboxed command;
  [Results](#results) shows it. `env -i` keeps the launcher's
  environment out of bwrap altogether. `--as-pid-1` keeps every bwrap process
  out of the sandbox's PID namespace and makes the entry script PID 1. Bash
  reaps its children, and when it exits the kernel ends every process left in
  the namespace.
- **The host never follows a link the sandbox wrote.** The sandbox writes
  `sandbox-out/`, HOME, `/tmp` and the workspace, and a harness that controls it
  can plant a symbolic link there to a host file it cannot read itself, or a
  FIFO that blocks a reader. The token scan skips links (`grep -r`), and the
  listings record them without following them (`find`). The summary opens
  files with `O_NOFOLLOW` and reads only regular files, and the runner merges
  only regular files. The summary also replaces control characters, because
  file names and probe details partly come from the sandbox and go to the
  operator's terminal. M1's dispatcher reads what passes write, so it needs
  the same rule.

## What this spike does not cover

- No seccomp filter, and nested user namespaces stay possible inside the
  sandbox.
- `/dev` and `/dev/shm` are bwrap's private tmpfs and may accept writes; they
  vanish with the sandbox.
- The proxy matches exact `host:port` pairs after resolving names on the host.
  It does not pin addresses, so it does not defend against DNS rebinding.
- The prompt asks for one word, so the harness uses no tools. Tool behaviour is
  measured only through the SessionStart hook.
- The proxy sees `CONNECT host:port` and byte counts, never the TLS content.
- A connection that bypasses `HTTPS_PROXY` fails in the empty network namespace
  and leaves no trace in the kit's logs. The proxy log shows only what went
  through the proxy.
- Root on the host can read everything in the sandbox; the boundary holds
  between unprivileged users only.
- The sandbox can learn the host's layout. `/proc/self/mountinfo` shows the
  host source path of every bind mount, the run directory included, and the
  probe configuration names the host user's HOME.

## Tests

`pnpm test` covers the proxy's allow and deny decisions and its log, the
bridge's forwarding, the broker stub, the summary and the CLI, all over real
TCP and Unix sockets on macOS and Linux. Every probe that can pass or fail is
tested against a staged leak as well as a clean case. For the TypeScript
probes that runs everywhere. The eight probes in the shell scripts need Linux
and bash 4.4 or later, so CI runs them: a token in a file, in a file grep
cannot read, in another process's arguments and in another process's
environment. The clean case of `hook-harness-environ-unreadable` runs only in
CI, where no process holds `CLAUDE_CODE_OAUTH_TOKEN`.

It also checks `run.sh`'s arguments, its token validation, its refusal to run
outside Linux and the bwrap command `--dry-run` prints, parses every script
with `bash -n`, and runs shellcheck where it is installed and always in CI.
A real run needs Linux and bwrap, so no test performs one.

## Results

All runs took place on 2026-10-06 on an Ubuntu 26.04.1 LTS VM with kernel
7.0.0, unprivileged user namespaces enabled, bubblewrap 0.11.1, bash 5.3.9,
Node.js 24.21.0 and the native Claude Code 2.1.291 binary.

| Run | Token | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Harness |
| --- | --- | --- | --- |
| 1 | random 60-character placeholder | on | `401 Invalid bearer token` after two retries, exit 1 |
| 2 | the same placeholder | off (`--no-scrub`) | the same |
| 3 | a real token from `claude setup-token` | on | answered `pong` in one turn, 1148 ms, exit 0 |

The real token reached a mode-600 file without passing through an argument or
the terminal, and was deleted after the run. The real-token run was not repeated without
the scrub: runs 1 and 2 already isolate the scrub's effects, and every run
spends the subscription.

### What worked

- bwrap accepted the whole layout: every namespace unshared, the read-only
  root, the two sockets bind-mounted as files, and descriptor 3 passed into the
  sandbox, read and closed by the entry script. bwrap logged nothing and
  exited 0 in every run.
- Claude Code honoured `HTTPS_PROXY` through the bridge and signed in with
  `CLAUDE_CODE_OAUTH_TOKEN` from a fresh HOME without `--bare`. With the real
  token, the stream held an `init` event (credential source `none`, meaning no
  API key, so the OAuth token was in use; 22 tools; no MCP servers), the
  SessionStart hook, one assistant message, one `rate_limit_event` and a
  `success` result. The harness wrote nothing to stderr. A whole run took
  about 3 seconds.
- No copy of the token appeared in any process argument on the host or in the
  sandbox, in any output file, or in HOME, `/tmp` or the workspace.

### Hosts contacted

`api.anthropic.com:443` only, in every run. The proxy denied nothing while the
harness ran, so a session signed in with a `claude setup-token` token needed
no other host: no OAuth refresh on `platform.claude.com`, no telemetry, no
update check. With the real token the harness opened three tunnels: two short
exchanges of about 2 KB up and 5 KB down each, then the model request with
52 KB up and 6.5 KB down. The probes add one CONNECT to the same host and one
denied CONNECT to `example.com:443` before the harness starts.

### Probes

Every probe had the same outcome in all three runs.

| Probe | Outcome | Detail |
| --- | --- | --- |
| `net-interfaces` | pass | only `lo` |
| `net-direct-tcp-ipv4` | pass | `ENETUNREACH` |
| `net-direct-tcp-ipv6` | pass | `ENETUNREACH` |
| `net-dns-system` | pass | `EAI_AGAIN` |
| `net-dns-direct` | pass | `ECONNREFUSED` |
| `net-abstract-sockets` | pass | none visible |
| `proxy-allows-model-api` | pass | 200 for `api.anthropic.com:443` |
| `proxy-denies-other` | pass | 403 for `example.com:443` |
| `broker-reachable` | pass | OpenAPI 3.1.0 |
| `fs-host-home-absent` | pass | the host user's HOME is absent |
| `fs-ssh-material-absent` | pass | no `~/.ssh`, `/root/.ssh`, `/etc/ssh` or `/run/user/UID` |
| `fs-other-users-absent` | pass | only the sandbox user; no `/root` or `/etc/shadow` |
| `fs-writes-refused` | pass | `/`, `/usr`, `/etc`, `/opt/forgecrew/*` and `/run/forgecrew/*` refuse writes |
| `fs-writes-accepted` | pass | HOME, `/tmp`, `/workspace` and `/out` accept writes |
| `env-host-absent` | pass | `HOME`, `LANG`, `LOGNAME`, `PATH`, `PWD`, `SHELL`, `SHLVL`, `TMPDIR`, `USER`, `_` |
| `proc-host-processes-invisible` | pass | `bwrap` (PID 1), the entry `bash`, two `node` |
| `proc-no-capabilities` | pass | `CapEff` all zero |
| `proc-entry-fds-clean` | pass | descriptors 0, 1, 2 and 255 (bash's script) |
| `token-absent-from-sandbox-argv` | pass | 9 to 13 samples per run |
| `token-in-harness-environ` | info | present |
| `hook-env-names` | info | see finding 3 |
| `hook-env-token-absent` | pass | `CLAUDE_CODE_OAUTH_TOKEN` is not in the hook's environment |
| `hook-harness-environ-unreadable` | **fail** | the hook read the token in `/proc/PID/environ` of `claude` |
| `token-absent-from-host-argv` | pass | 11 to 14 samples of every host process per run |
| `token-absent-from-outputs` | pass | no output file holds the token |
| `token-absent-from-home` | pass | HOME, `/tmp` and the workspace hold no copy |

### What a signed-in session writes

HOME after the real-token run, with the scrub on: 17 files, 16 directories,
93,793 bytes.

| Path | Size in bytes |
| --- | --- |
| `.claude.json` | 777 |
| `.claude/backups/.claude.json.backup.<timestamp>` | 84 |
| `.claude/policy-limits.json` | 214 |
| `.claude/policy-limits.json.stamp.json` | 225 |
| `.claude/remote-settings.json` | 2 |
| `.claude/projects/-workspace/<session>.jsonl` | 92,491 (the session transcript) |
| `.claude/projects/-workspace/memory/`, `.claude/session-env/<session>/`, `.claude/sessions/` | empty directories |
| `.bash_aliases`, `.bash_profile`, `.bashrc`, `.bunfig.toml`, `.gitconfig`, `.netrc`, `.npmrc`, `.profile`, `.yarnrc`, `.yarnrc.yml`, `.zshrc` | 0 each, from the scrub |
| `.claude/seed-admin/`, `.config/anthropic/`, `.config/gh/`, `.config/git/`, `.config/glab-cli/`, `.config/pip/`, `.pip/` | empty directories, from the scrub |

The two `policy-limits` files and `remote-settings.json` appear only when the
session is signed in. Without a valid sign-in and without the scrub, HOME held
only `.claude.json` (719 bytes), its backup and the transcript. The
transcript is written even when the run fails to authenticate.

`/tmp` received the directories `cc-socks/` and `claude-<uid>/`, and with the
scrub also `claude-<uid>/bash-edit-diff/`, a per-session `tasks/` directory and
an empty `inline-comments-buffer.jsonl`. The workspace is covered in finding 2.

### Leaks and findings

1. **A subprocess of the harness can read the model credential.** The
   SessionStart hook read `CLAUDE_CODE_OAUTH_TOKEN` from the harness's
   `/proc/PID/environ` in every run, the real-token run included, with and
   without `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. Claude Code never puts the
   token in the hook's own environment, even without the scrub, but the
   parent's environment stays readable to any process of the same user in the
   same PID namespace. A Bash tool command could likely do the same; the docs
   say the scrub runs those in their own PID namespace, which these one-word
   runs did not exercise. Until credentials are injected at egress
   ([#7](https://github.com/mvasin/forgecrew/issues/7)), assume that anything
   the harness runs can read the token.
2. **The scrub leaves empty placeholder files behind.** With
   `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, Claude Code created 17 empty files and
   5 directories in the empty workspace: `.env`, `.env.development`,
   `.env.development.local`, `.env.local`, `.env.production`,
   `.env.production.local`, `.env.test`, `.env.test.local`, `.gitmodules`,
   `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `package-lock.json`,
   `package.json`, `pnpm-lock.yaml`, `yarn.lock`, `.claude/agents/`,
   `.claude/commands/` and `node_modules/.bin/`. It left them after it
   exited, signed in or not. Without the scrub the workspace stayed empty. In
   dev-bot's worktree they would show up as untracked files that could be
   committed, so the dispatcher has to remove them, or the box must run
   without the scrub.
3. **Subprocesses see Claude Code's messaging channel.** Without the scrub, the
   hook's environment also held `CLAUDE_CODE_MESSAGING_TOKEN`; the scrub
   removed it. With the scrub the hook received `AI_AGENT`, `CLAUDECODE`,
   `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
   `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`,
   `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`,
   `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_ENV_FILE`, `CLAUDE_PID`,
   `CLAUDE_PROJECT_DIR`, `COREPACK_ENABLE_AUTO_PIN`, `DISABLE_AUTOUPDATER`,
   `DISABLE_ERROR_REPORTING`, `DISABLE_TELEMETRY`,
   `ENABLE_CLAUDEAI_MCP_SERVERS`, `HOME`, `HTTPS_PROXY`, `HTTP_PROXY`, `LANG`,
   `LOGNAME`, `NoDefaultCurrentDirectoryInExePath`, `PATH`, `PWD`, `SHELL`,
   `SHLVL`, `TMPDIR` and `USER`.

### What the runs changed in the kit

`proc-host-processes-invisible` failed at first on the kit's own Node
processes: Node 24 names its main thread `MainThread`, and the kernel reports
that as the process name. The probe now names each process by its `argv[0]`.
The summary now also lists the workspace, where the scrub's placeholder files
appeared. The real-token run exposed no further defect.

### Verdict

bwrap with a Unix socket bridge is good enough for the M1 sandbox. It runs the
unmodified Claude Code binary headless with a `claude setup-token` sign-in and
a fresh HOME. It confines the harness's network to the proxy's allowlist,
which needs only `api.anthropic.com:443`, and it keeps the token off every
command line and out of every file. Two findings carry into M1: the token
stays readable through `/proc` until egress injection
([#7](https://github.com/mvasin/forgecrew/issues/7)), and the scrub's
placeholder files must be cleaned or the scrub dropped.

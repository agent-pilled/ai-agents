# Spike: Claude Code headless in bwrap

This spike retires the first technical risk of M0 ([design](../../docs/design.md#bootstrap)):
can Claude Code run headless inside bwrap with a fresh HOME, a token from
`claude setup-token`, and network limited to the model API and the broker?
It records what works, what leaks and what the harness writes to HOME.

**Status: not run yet.** The kit is ready to run; [Results](#results) is empty.

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

Not run yet. A run fills in:

- date, distribution and kernel, bwrap version, Claude Code version;
- whether the harness answered, and every host it tried to reach;
- every failing probe, with its detail;
- what the harness wrote to HOME (`host/home-files.tsv`);
- a verdict: whether bwrap with a Unix socket bridge is good enough for the
  M1 sandbox.

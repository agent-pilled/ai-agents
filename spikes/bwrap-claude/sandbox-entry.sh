#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# The sandbox's first process, started by run.sh through bwrap. It takes the
# token from descriptor 3, starts the bridge, runs the leak probes, then runs
# the harness with the token in its environment while it watches every
# process's arguments for the token.
#
# usage, inside the sandbox: sandbox-entry.sh BRIDGE_PORT SCRUB PROMPT

set -euo pipefail

# The script's directory, /opt/forgecrew/spike in the sandbox. A parameter
# expansion, because no process may start before take_token has read and
# closed descriptor 3.
spike=${BASH_SOURCE[0]%/*}
[[ $spike != "${BASH_SOURCE[0]}" ]] || spike=.
readonly spike
readonly out=/out
readonly proxy_socket=/run/forgecrew/proxy.sock
readonly probe_config=/run/forgecrew/config/probe-config.json
readonly claude=/opt/forgecrew/bin/claude
# shellcheck source=lib.sh
source "$spike/lib.sh"

token=''
bridge_pid=''

main() {
  local bridge_port=$1 scrub=$2 prompt=$3
  take_token
  start_bridge "$bridge_port"
  node "$spike/cli.ts" probes --config "$probe_config" \
    > "$out/probes.jsonl" 2> "$out/probes.stderr" ||
    log "the probes exited with status $?"
  run_harness "$bridge_port" "$scrub" "$prompt"
}

# Reads the token from descriptor 3 and closes it before starting anything,
# so no other process inherits the descriptor.
take_token() {
  if ! IFS= read -r token <&3 && [[ -z $token ]]; then
    fail "no token on descriptor 3"
  fi
  exec 3<&-
}

start_bridge() {
  node "$spike/cli.ts" bridge --socket "$proxy_socket" --port "$1" \
    > "$out/bridge.jsonl" 2> "$out/bridge.stderr" &
  bridge_pid=$!
  local attempt
  for attempt in {1..100}; do
    if grep -q '"event":"listening"' "$out/bridge.jsonl" 2> /dev/null; then
      return 0
    fi
    kill -0 "$bridge_pid" 2> /dev/null || fail "the bridge exited; see bridge.stderr"
    sleep 0.1
  done
  fail "the bridge did not start within $((attempt / 10)) seconds"
}

# Runs the harness headless. The token and the proxy settings are exported in
# a subshell that becomes the harness, so they reach no other process.
run_harness() {
  local port=$1 scrub=$2 prompt=$3 status=0 harness_pid watcher_pid
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ > "$out/harness-started-at"
  (
    export CLAUDE_CODE_OAUTH_TOKEN=$token
    export HTTPS_PROXY=http://127.0.0.1:$port HTTP_PROXY=http://127.0.0.1:$port
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    export DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
    export ENABLE_CLAUDEAI_MCP_SERVERS=false
    if [[ $scrub == 1 ]]; then
      export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
    fi
    exec "$claude" --print --output-format stream-json --verbose \
      --settings "$spike/claude-settings.json" "$prompt"
  ) < /dev/null > "$out/stream.jsonl" 2> "$out/harness-stderr.log" &
  harness_pid=$!
  watch_harness "$harness_pid" "$claude" >> "$out/probes.jsonl" &
  watcher_pid=$!
  wait "$harness_pid" || status=$?
  wait "$watcher_pid" || true
  printf '%s\n' "$status" > "$out/harness-exit-code"
  kill "$bridge_pid" 2> /dev/null || true
  wait "$bridge_pid" 2> /dev/null || true
}

# Samples every process's arguments while the harness runs, and checks once
# whether the harness's own environment holds the token. Compares in the
# shell only, so the token never becomes an argument of a command.
#   watch_harness PID EXECUTABLE
watch_harness() {
  local pid=$1 executable=$2 samples=0 environ=unknown file arg
  local -a args hits=()
  while kill -0 "$pid" 2> /dev/null; do
    for file in /proc/[0-9]*/cmdline; do
      mapfile -d '' -t args 2> /dev/null < "$file" || continue
      for arg in "${args[@]}"; do
        if [[ $arg == *"$token"* ]]; then
          if [[ " ${hits[*]} " != *" ${file%/cmdline} "* ]]; then
            hits+=("${file%/cmdline}")
          fi
          break
        fi
      done
    done
    # Before exec the process is still this shell's subshell, whose
    # environment says nothing about the harness.
    if [[ $environ == unknown && $(readlink "/proc/$pid/exe" 2> /dev/null) == "$executable" ]] &&
      mapfile -d '' -t args 2> /dev/null < "/proc/$pid/environ"; then
      environ=absent
      for arg in "${args[@]}"; do
        if [[ $arg == "CLAUDE_CODE_OAUTH_TOKEN=$token" ]]; then
          environ=present
          break
        fi
      done
    fi
    samples=$((samples + 1))
    sleep 0.2
  done

  if ((${#hits[@]} == 0)); then
    probe_line token-absent-from-sandbox-argv pass "no process argument held the token in $samples samples"
  else
    probe_line token-absent-from-sandbox-argv fail "the token appeared in the arguments of ${hits[*]}"
  fi
  case $environ in
    present) probe_line token-in-harness-environ info "present, as designed until credentials are injected at egress" ;;
    absent) probe_line token-in-harness-environ info "absent from the harness environment at its start" ;;
    *) probe_line token-in-harness-environ info "not observed; the harness exited before a sample" ;;
  esac
}

log() {
  printf 'sandbox-entry: %s\n' "$1" >&2
}

fail() {
  log "$1"
  exit 1
}

# Run only when executed, so that tests can source the functions.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi

#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# A SessionStart hook, registered in claude-settings.json. Claude Code runs it
# as a subprocess, so it sees what any subprocess of the harness would see,
# such as a Bash tool command: its own environment and, through /proc, the
# environments of other processes. It never reads the token's value.
#
# usage: hook-probe.sh [OUTPUT]   (default /out/hook-probes.jsonl)

set -uo pipefail # no -e: a failing hook must not change the session

readonly out=${1:-/out/hook-probes.jsonl}
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

main() {
  cat > /dev/null # the hook input on stdin is not needed
  {
    probe_line hook-env-names info "$(compgen -e | LC_ALL=C sort | paste -sd, -)"
    if [[ -n ${CLAUDE_CODE_OAUTH_TOKEN+set} ]]; then
      probe_line hook-env-token-absent fail "CLAUDE_CODE_OAUTH_TOKEN is set in the hook's environment"
    else
      probe_line hook-env-token-absent pass "CLAUDE_CODE_OAUTH_TOKEN is not set in the hook's environment"
    fi
    environments_holding_token
  } >> "$out"
}

# Reads every process environment the hook can see, not only its ancestors:
# a subprocess in its own PID namespace, or one that was reparented, has no
# ancestor chain to the harness, while /proc may still show the harness. It
# reports each process whose environment holds CLAUDE_CODE_OAUTH_TOKEN, by
# variable name, and how many environments it could read.
environments_holding_token() {
  local file pid entry harness
  local -a entries readable=() holding=()
  for file in /proc/[0-9]*/environ; do
    pid=${file#/proc/}
    pid=${pid%/environ}
    [[ $pid == "$$" ]] && continue # this hook; hook-env-token-absent covers it
    mapfile -d '' -t entries 2> /dev/null < "$file" || continue
    readable+=("$pid")
    for entry in "${entries[@]}"; do
      if [[ $entry == CLAUDE_CODE_OAUTH_TOKEN=* ]]; then
        holding+=("$pid ($(process_name "$pid"))")
        break
      fi
    done
  done

  if [[ -z ${CLAUDE_PID:-} ]]; then
    harness="CLAUDE_PID is not set"
  elif [[ -e /proc/$CLAUDE_PID ]]; then
    harness="the harness, PID $CLAUDE_PID, is visible"
  else
    harness="the harness, PID $CLAUDE_PID, is not visible"
  fi
  if ((${#holding[@]} > 0)); then
    probe_line hook-harness-environ-unreadable fail "the token is readable in /proc/PID/environ of ${holding[*]}; ${#readable[@]} environments readable; $harness"
  elif ((${#readable[@]} == 0)); then
    probe_line hook-harness-environ-unreadable pass "no other process environment is readable; $harness"
  else
    probe_line hook-harness-environ-unreadable pass "none of the ${#readable[@]} readable environments holds the token; $harness"
  fi
}

process_name() {
  local name
  IFS= read -r name 2> /dev/null < "/proc/$1/comm" || name='?'
  printf '%s' "$name"
}

main

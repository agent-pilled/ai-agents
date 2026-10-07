# shellcheck shell=bash
# Shared by run.sh, sandbox-entry.sh and hook-probe.sh. Sourced, not run.
# Keep it compatible with bash 3.2, which run.sh --dry-run supports.

# Prints its argument as a JSON string.
json_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}

# Prints one probe result as a JSON line: probe_line NAME pass|fail|info DETAIL
probe_line() {
  printf '{"probe":%s,"result":%s,"detail":%s}\n' \
    "$(json_string "$1")" "$(json_string "$2")" "$(json_string "$3")"
}

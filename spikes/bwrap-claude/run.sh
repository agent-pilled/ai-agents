#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Runs Claude Code headless inside bwrap with a fresh HOME, a token from
# `claude setup-token`, and network limited to the model API and a stub
# broker, then records what worked, what leaked and what the harness wrote to
# HOME. README.md explains the outputs.
#
# A real run needs Linux, bwrap and bash 4.4 or later. --help and --dry-run
# also work elsewhere, down to bash 3.2.

set -euo pipefail

# The token is read into this shell, so tracing would print it.
case $- in
  *x*)
    echo "run.sh: refusing to run with xtrace on, because it would print the token" >&2
    exit 2
    ;;
esac

spike_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly spike_dir
# shellcheck source=lib.sh
source "$spike_dir/lib.sh"

readonly sandbox_home=/home/sandbox
readonly sandbox_user=sandbox
readonly bridge_port=3128
readonly default_allow=api.anthropic.com:443
readonly probe_denied_target=example.com:443
readonly default_prompt='Reply with exactly one word: pong'
# Exported by a real run; the probes fail if any process inside holds it.
readonly launch_canary=FORGECREW_LAUNCH_CANARY

usage() {
  cat <<'EOF'
usage: run.sh --token-file PATH [options]

Runs Claude Code headless inside bwrap and records what works and what leaks.

  --token-file PATH  file holding the token from `claude setup-token`, one line
  --out DIR          run directory to create (default: a new one under $TMPDIR)
  --allow HOST:PORT  egress the proxy allows; repeat to add more
                     (default: api.anthropic.com:443)
  --prompt TEXT      prompt for the harness (default: a one-word reply)
  --claude PATH      Claude Code binary (default: claude on PATH)
  --node PATH        Node.js 24 or later (default: node on PATH)
  --timeout SECONDS  stop the sandbox after this long (default: 300)
  --no-scrub         leave CLAUDE_CODE_SUBPROCESS_ENV_SCRUB unset
  --dry-run          print the bwrap command and exit; starts nothing
  -h, --help         show this help
EOF
}

main() {
  parse_args "$@"
  if ((!dry_run)); then
    check_platform
  fi
  read_token
  resolve_binaries
  if ((!dry_run)); then
    check_prerequisites
  fi
  plan_run_dir
  build_bwrap_args
  build_launch_command
  if ((dry_run)); then
    print_command
    return
  fi

  trap cleanup EXIT
  trap 'exit 130' INT TERM
  umask 077
  export "$launch_canary=set-by-run.sh"
  prepare_run_dir
  start_host_services
  run_sandbox
  stop_host_services
  collect_results
  "$node_real" "$spike_dir/cli.ts" summarize "$run_dir" | tee "$run_dir/summary.txt"
  printf '\nThe run directory holds the sandbox HOME, which may hold credentials.\n'
  printf 'Delete it when done: rm -rf %q\n' "$run_dir"
}

parse_args() {
  token_file='' out_dir='' prompt=$default_prompt claude_bin='' node_bin=''
  timeout_s=300 scrub=1 dry_run=0
  allow=()
  while (($# > 0)); do
    case $1 in
      --token-file | --out | --allow | --prompt | --claude | --node | --timeout)
        (($# >= 2)) || usage_error "$1 needs a value"
        case $1 in
          --token-file) token_file=$2 ;;
          --out) out_dir=$2 ;;
          --allow) allow+=("$2") ;;
          --prompt) prompt=$2 ;;
          --claude) claude_bin=$2 ;;
          --node) node_bin=$2 ;;
          --timeout) timeout_s=$2 ;;
        esac
        shift 2
        ;;
      --no-scrub) scrub=0 && shift ;;
      --dry-run) dry_run=1 && shift ;;
      -h | --help) usage && exit 0 ;;
      *) usage_error "unknown option $1" ;;
    esac
  done
  [[ -n $token_file ]] || usage_error "--token-file is required"
  [[ $timeout_s =~ ^[1-9][0-9]*$ ]] || usage_error "--timeout needs a whole number of seconds"
  if ((${#allow[@]} == 0)); then
    allow=("$default_allow")
  fi
}

check_platform() {
  [[ $(uname -s) == Linux ]] || fail "a real run needs Linux, with bwrap and unprivileged user namespaces; use --dry-run to see the command"
  ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4))) ||
    fail "a real run needs bash 4.4 or later"
}

# Reads the token into this shell only. It never becomes an argument, an
# environment variable of this shell or a file the runner writes.
read_token() {
  [[ -f $token_file && -r $token_file ]] || input_error "cannot read the token file $token_file"
  token=$(<"$token_file")
  # A variable named token that the caller exported, or allexport, would
  # otherwise hand the token to every process this script starts.
  export -n token
  [[ -n $token ]] || input_error "the token file $token_file is empty"
  if [[ $token =~ [[:space:]] ]]; then
    input_error "the token file must hold the token on one line and nothing else"
  fi
  if [[ -n $(find "$token_file" \( -perm -040 -o -perm -004 \) -print) ]]; then
    warn "the token file is readable by other users; chmod 600 it"
  fi
}

resolve_binaries() {
  claude_bin=${claude_bin:-$(command -v claude || true)}
  [[ -n $claude_bin ]] || fail "claude is not on PATH; install Claude Code or pass --claude"
  claude_real=$(readlink -f "$claude_bin")
  [[ -f $claude_real && -x $claude_real ]] || fail "$claude_bin is not an executable file"

  node_bin=${node_bin:-$(command -v node || true)}
  [[ -n $node_bin ]] || fail "node is not on PATH; install Node.js 24 or pass --node"
  node_real=$(readlink -f "$node_bin")
  [[ -f $node_real && -x $node_real ]] || fail "$node_bin is not an executable file"
}

check_prerequisites() {
  bwrap_bin=$(command -v bwrap) || fail "bwrap is not installed (package: bubblewrap)"
  local version
  version=$(bwrap --version | awk '{print $2}')
  version_at_least "$version" 0.5.0 || fail "bwrap $version is too old; --clearenv needs 0.5.0"

  local userns_error
  if ! userns_error=$(bwrap --unshare-all --unshare-user --die-with-parent \
    --ro-bind /usr /usr "${usr_links[@]}" --proc /proc --dev /dev true 2>&1); then
    printf 'run.sh: bwrap cannot create a sandbox here: %s\n' "$userns_error" >&2
    explain_userns >&2
    exit 1
  fi

  [[ $(head -c 4 "$claude_real") == $'\x7fELF' ]] ||
    fail "$claude_real is not the native Claude Code binary; a script launcher cannot run alone in the sandbox"
  version=$("$node_real" -p 'process.versions.node')
  version_at_least "$version" 24.0.0 || fail "node $version is too old; the spike needs 24 or later"
  timeout_bin=$(command -v timeout) || fail "timeout (coreutils) is not installed"
}

explain_userns() {
  echo "Unprivileged user namespaces may be off. Check:"
  local key
  for key in kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone user.max_user_namespaces; do
    printf '  %s = %s\n' "$key" "$(cat "/proc/sys/${key//.//}" 2> /dev/null || echo 'not present')"
  done
  echo "On Ubuntu 24.04 and later, AppArmor restricts them; an AppArmor profile for bwrap lifts that."
}

plan_run_dir() {
  local tmp_root=${TMPDIR:-/tmp}
  tmp_root=${tmp_root%/}
  if [[ -n $out_dir ]]; then
    run_dir=$out_dir
  elif ((dry_run)); then
    run_dir=$tmp_root/forgecrew-spike.XXXXXX
  else
    run_dir=$(mktemp -d "$tmp_root/forgecrew-spike.XXXXXX")
  fi
  run_dir=${run_dir%/}
  home_dir=$run_dir/home
  tmp_dir=$run_dir/tmp
  workspace_dir=$run_dir/workspace
  sandbox_out=$run_dir/sandbox-out
  host_dir=$run_dir/host
  config_dir=$run_dir/config
  etc_dir=$run_dir/etc
  # Unix socket paths must stay short, so the sockets live apart from the run.
  if ((dry_run)); then
    sock_dir=/tmp/forgecrew-sock.XXXXXX
  else
    sock_dir=$(mktemp -d /tmp/forgecrew-sock.XXXXXX)
  fi
}

# Builds the bwrap arguments: every namespace unshared, an empty environment,
# a read-only root holding only /usr and a few files from /etc, and writable
# binds for the fresh HOME, tmp, workspace and the output channel.
build_bwrap_args() {
  bwrap_args=(
    --unshare-all --unshare-user
    --as-pid-1 --die-with-parent --new-session
    --clearenv
    --hostname forgecrew-sandbox
    --ro-bind /usr /usr
  )
  bwrap_args+=("${usr_links[@]}")
  local path
  for path in /etc/ld.so.cache /etc/alternatives /etc/ssl /etc/pki /etc/ca-certificates /etc/crypto-policies; do
    bwrap_args+=(--ro-bind-try "$path" "$path")
  done
  bwrap_args+=(
    --ro-bind "$etc_dir/passwd" /etc/passwd
    --ro-bind "$etc_dir/group" /etc/group
    --ro-bind "$etc_dir/hosts" /etc/hosts
    --proc /proc
    --dev /dev
    --bind "$home_dir" "$sandbox_home"
    --bind "$tmp_dir" /tmp
    --bind "$workspace_dir" /workspace
    --bind "$sandbox_out" /out
    --ro-bind "$spike_dir" /opt/forgecrew/spike
    --ro-bind "$claude_real" /opt/forgecrew/bin/claude
    --ro-bind "$node_real" /opt/forgecrew/bin/node
    --ro-bind "$config_dir" /run/forgecrew/config
    --ro-bind "$sock_dir/proxy.sock" /run/forgecrew/proxy.sock
    --ro-bind "$sock_dir/broker.sock" /run/forgecrew/broker.sock
    --remount-ro /
    --chdir /workspace
    --setenv HOME "$sandbox_home"
    --setenv USER "$sandbox_user"
    --setenv LOGNAME "$sandbox_user"
    --setenv PATH /opt/forgecrew/bin:/usr/bin:/bin
    --setenv SHELL /bin/bash
    --setenv LANG C.UTF-8
    --setenv TMPDIR /tmp
    /bin/bash /opt/forgecrew/spike/sandbox-entry.sh "$bridge_port" "$scrub" "$prompt"
  )
}

# The launch: an empty environment, so nothing of this shell's environment
# reaches bwrap, and a time limit. --as-pid-1 then keeps every bwrap process
# out of the sandbox's PID namespace, so neither bwrap's environment nor its
# arguments are visible inside.
build_launch_command() {
  launch=(env -i "${timeout_bin:-timeout}" --kill-after=10 "$timeout_s" "${bwrap_bin:-bwrap}")
}

# Prints the launch and the bwrap arguments, one option and its values per line.
print_command() {
  local index=0 count=${#bwrap_args[@]} take word
  printf '%s' "${launch[0]}"
  printf ' %q' "${launch[@]:1}"
  while ((index < count)); do
    case ${bwrap_args[index]} in
      --ro-bind | --ro-bind-try | --bind | --symlink | --setenv) take=3 ;;
      --hostname | --proc | --dev | --remount-ro | --chdir) take=2 ;;
      --*) take=1 ;;
      *) take=$((count - index)) ;; # the command run inside the sandbox
    esac
    printf ' \\\n '
    for ((word = index; word < index + take; word++)); do
      printf ' %q' "${bwrap_args[word]}"
    done
    index=$((index + take))
  done
  printf '\n'
}

prepare_run_dir() {
  if [[ -e $run_dir && -n $(ls -A "$run_dir") ]]; then
    fail "the run directory $run_dir is not empty"
  fi
  mkdir -p "$home_dir" "$tmp_dir" "$workspace_dir" "$sandbox_out" "$host_dir" "$config_dir" "$etc_dir"
  print_command > "$host_dir/bwrap-command.txt"
  bwrap --version > "$host_dir/bwrap-version.txt"

  local uid gid
  uid=$(id -u)
  gid=$(id -g)
  printf '%s:x:%s:%s:Forgecrew sandbox:%s:/bin/bash\n' "$sandbox_user" "$uid" "$gid" "$sandbox_home" > "$etc_dir/passwd"
  printf '%s:x:%s:\n' "$sandbox_user" "$gid" > "$etc_dir/group"
  printf '127.0.0.1 localhost\n::1 localhost\n' > "$etc_dir/hosts"
  write_probe_config "$uid" > "$config_dir/probe-config.json"
}

write_probe_config() {
  cat <<EOF
{
  "hostHome": $(json_string "${HOME:?}"),
  "hostUid": $1,
  "sandboxHome": $(json_string "$sandbox_home"),
  "sandboxUser": $(json_string "$sandbox_user"),
  "bridgePort": $bridge_port,
  "brokerSocket": "/run/forgecrew/broker.sock",
  "allowedTarget": $(json_string "${allow[0]}"),
  "deniedTarget": $(json_string "$probe_denied_target"),
  "allowedEnv": $(json_list HOME LANG LOGNAME OLDPWD PATH PWD SHELL SHLVL TMPDIR USER _),
  "writable": $(json_list "$sandbox_home" /tmp /workspace /out),
  "readOnly": $(json_list / /usr /etc /opt/forgecrew/spike /opt/forgecrew/bin /run/forgecrew /run/forgecrew/config),
  "allowedProcesses": $(json_list bash node),
  "launcherCanary": $(json_string "$launch_canary")
}
EOF
}

start_host_services() {
  local allow_args=() entry
  for entry in "${allow[@]}"; do
    allow_args+=(--allow "$entry")
  done
  "$node_real" "$spike_dir/cli.ts" broker --socket "$sock_dir/broker.sock" \
    > "$host_dir/broker.jsonl" 2> "$host_dir/broker.stderr" &
  broker_pid=$!
  "$node_real" "$spike_dir/cli.ts" proxy --socket "$sock_dir/proxy.sock" "${allow_args[@]}" \
    > "$host_dir/proxy.jsonl" 2> "$host_dir/proxy.stderr" &
  proxy_pid=$!
  wait_for_socket "$sock_dir/broker.sock" "$broker_pid" broker
  wait_for_socket "$sock_dir/proxy.sock" "$proxy_pid" proxy
}

run_sandbox() {
  local status=0
  # The token reaches the sandbox only through descriptor 3: a pipe that bwrap
  # hands to the sandboxed process, which reads it and closes it.
  exec 3< <(printf '%s' "$token")
  "${launch[@]}" "${bwrap_args[@]}" \
    < /dev/null > "$host_dir/bwrap.log" 2>&1 &
  sandbox_pid=$!
  exec 3<&-
  sample_host_argv "$sandbox_pid" > "$host_dir/probes.jsonl" &
  sampler_pid=$!
  wait "$sandbox_pid" || status=$?
  sandbox_pid=''
  wait "$sampler_pid" || true
  sampler_pid=''
  printf '%s\n' "$status" > "$host_dir/bwrap-exit-code"
}

# Samples every process's arguments on the host while the sandbox runs and
# reports whether any of them held the token. Compares in the shell only.
sample_host_argv() {
  local watched=$1 samples=0 file arg
  local -a args hits=()
  while kill -0 "$watched" 2> /dev/null; do
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
    samples=$((samples + 1))
    sleep 0.2
  done
  if ((${#hits[@]} == 0)); then
    probe_line token-absent-from-host-argv pass "no process argument held the token in $samples samples of every host process"
  else
    probe_line token-absent-from-host-argv fail "the token appeared in the arguments of ${hits[*]}"
  fi
}

stop_host_services() {
  stop_process "${proxy_pid:-}"
  proxy_pid=''
  stop_process "${broker_pid:-}"
  broker_pid=''
}

collect_results() {
  list_files "$home_dir" > "$host_dir/home-files.tsv"
  list_files "$tmp_dir" > "$host_dir/tmp-files.tsv"
  list_files "$workspace_dir" > "$host_dir/workspace-files.tsv"
  {
    scan_for_token token-absent-from-outputs "$sandbox_out" "$host_dir"
    scan_for_token token-absent-from-home "$home_dir" "$tmp_dir" "$workspace_dir"
  } >> "$host_dir/probes.jsonl"
  merge_probe_results
}

# Merges the probe results into one file. The sandbox could have planted a
# link in sandbox-out to a host file, so only regular files are read, never
# through a symbolic link. The sandbox has ended, so nothing changes them now.
merge_probe_results() {
  local file
  for file in "$sandbox_out/probes.jsonl" "$sandbox_out/hook-probes.jsonl" "$host_dir/probes.jsonl"; do
    if [[ -L $file || (-e $file && ! -f $file) ]]; then
      warn "skipped ${file#"$run_dir/"}: not a regular file"
    elif [[ -f $file ]]; then
      cat -- "$file"
    fi
  done > "$run_dir/probes.jsonl"
}

# Lists type, mode, size and path of everything under a directory, never contents.
list_files() {
  printf 'type\tmode\tsize\tpath\n'
  (cd "$1" && find . -mindepth 1 -printf '%y\t%m\t%s\t%P\n' | LC_ALL=C sort -t $'\t' -k4)
}

# Reports which files under the given directories hold the token, by name only.
# A file grep cannot read fails the probe, because it could hold the token.
scan_for_token() {
  local probe=$1 prefix="$run_dir/" found errors error_file status=0
  shift
  error_file=$(mktemp "${TMPDIR:-/tmp}/forgecrew-scan.XXXXXX")
  found=$(grep -rlF -f <(printf '%s\n' "$token") -- "$@" 2> "$error_file") || status=$?
  errors=$(head -n 5 "$error_file")
  rm -f -- "$error_file"
  found=${found//"$prefix"/}
  errors=${errors//"$prefix"/}
  if ((status > 1)); then
    probe_line "$probe" fail "scan incomplete: ${errors//$'\n'/; }${found:+; files holding the token: ${found//$'\n'/, }}"
  elif [[ -n $found ]]; then
    probe_line "$probe" fail "files holding the token: ${found//$'\n'/, }"
  else
    probe_line "$probe" pass "no file holds the token"
  fi
}

wait_for_socket() {
  local socket=$1 pid=$2 name=$3 attempt
  for attempt in $(seq 1 100); do
    [[ -S $socket ]] && return 0
    kill -0 "$pid" 2> /dev/null || fail "the $name exited; see $host_dir/$name.stderr"
    sleep 0.1
  done
  fail "the $name did not start within $((attempt / 10)) seconds"
}

stop_process() {
  [[ -n $1 ]] || return 0
  kill "$1" 2> /dev/null || true
  wait "$1" 2> /dev/null || true
}

cleanup() {
  stop_process "${sampler_pid:-}"
  stop_process "${sandbox_pid:-}"
  stop_process "${proxy_pid:-}"
  stop_process "${broker_pid:-}"
  if [[ -n ${sock_dir:-} && -d $sock_dir ]]; then
    rm -rf -- "$sock_dir"
  fi
}

# Prints the bwrap arguments that recreate the host's top-level links into
# /usr (merged /usr), or bind the directories where they are real.
host_usr_links() {
  local dir
  for dir in bin sbin lib lib32 lib64 libx32; do
    if [[ -L /$dir ]]; then
      printf '%s\n' --symlink "$(readlink "/$dir")" "/$dir"
    elif [[ -d /$dir ]]; then
      printf '%s\n' --ro-bind "/$dir" "/$dir"
    fi
  done
}

json_list() {
  local first=1 item
  printf '['
  for item in "$@"; do
    ((first)) || printf ', '
    first=0
    json_string "$item"
  done
  printf ']'
}

version_at_least() {
  [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1) == "$2" ]]
}

usage_error() {
  printf 'run.sh: %s\n' "$1" >&2
  printf 'Try: run.sh --help\n' >&2
  exit 2
}

input_error() {
  printf 'run.sh: %s\n' "$1" >&2
  exit 2
}

fail() {
  printf 'run.sh: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'run.sh: warning: %s\n' "$1" >&2
}

usr_links=()
while IFS= read -r line; do
  usr_links+=("$line")
done < <(host_usr_links)

# Run only when executed, so that tests can source the functions.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi

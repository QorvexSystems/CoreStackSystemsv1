#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly host_script="$repo/deploy/admin/cleanup-rivnu-activation-host-20261104.sh"
readonly remote_script='/home/luismel/cleanup-rivnu-activation-host-20261104.sh'

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "$(hostname)" == 'VM2-APP' ]] || fail RUN_ON_VM2
[[ -f "$host_script" && ! -L "$host_script" ]] || fail HOST_CLEANUP_SCRIPT_MISSING
bash -n "$host_script"

cleanup_remote() {
  local label=$1
  local address=$2
  printf '\n=== %s (%s) ===\n' "$label" "$address"
  scp -q -- "$host_script" "luismel@${address}:${remote_script}"
  ssh -t "luismel@${address}" \
    "chmod 700 '$remote_script' && sudo '$remote_script'; status=\$?; rm -f -- '$remote_script'; exit \$status"
}

cleanup_remote VM1-GATEWAY 10.0.0.2
cleanup_remote VM3-SQLDB 10.0.0.4
cleanup_remote VM4-BILLING 10.0.0.1

printf '\n=== VM2-APP (local) ===\n'
sudo "$host_script"

printf '\nRIVNU_ACTIVATION_CLEANUP_ALL_VMS_COMPLETE\n'


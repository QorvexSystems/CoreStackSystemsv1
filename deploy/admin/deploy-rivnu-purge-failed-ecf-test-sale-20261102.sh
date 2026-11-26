#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly script='deploy/admin/purge-vm3-rivnu-failed-ecf-test-sale-20261102.sh'
readonly remote='luismel@10.0.0.4'
readonly remote_path='/home/luismel/purge-vm3-rivnu-failed-ecf-test-sale-20261102.sh'

[[ "$(hostname)" == 'VM2-APP' && "$PWD" == "$repo" ]] || {
  printf '%s\n' RUN_FROM_REPOSITORY_ON_VM2 >&2
  exit 1
}

sha256sum "$script"
scp "$script" "$remote:$remote_path"
ssh -tt "$remote" "
  set -Eeuo pipefail
  sha256sum '$remote_path'
  chmod 700 '$remote_path'
  sudo '$remote_path'
"

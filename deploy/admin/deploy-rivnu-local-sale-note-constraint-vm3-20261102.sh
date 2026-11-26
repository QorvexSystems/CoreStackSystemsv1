#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly archive='/home/luismel/rivnu-local-sale-note-constraint-20261102.tar.gz'
readonly remote_archive='/home/luismel/rivnu-local-sale-note-constraint-20261102.tar.gz'
readonly remote_root='/home/luismel/rivnu-local-sale-note-constraint-20261102'
readonly remote='luismel@10.0.0.4'

[[ "$(hostname)" == 'VM2-APP' && "$PWD" == "$repo" ]] || {
  printf '%s\n' RUN_FROM_REPOSITORY_ON_VM2 >&2
  exit 1
}

tar -czf "$archive" \
  deploy/admin/migrate-vm3-rivnu-local-sale-note-constraint-20261102.sh \
  packages/database/prisma/migrations/20261102143500_allow_local_sale_note_in_cashier/migration.sql
chmod 0600 "$archive"
sha256sum "$archive"

scp "$archive" "$remote:$remote_archive"
ssh -tt "$remote" "
  set -Eeuo pipefail
  test ! -e '$remote_root'
  mkdir -m 700 '$remote_root'
  tar -xzf '$remote_archive' -C '$remote_root'
  chmod 700 '$remote_root/deploy/admin/migrate-vm3-rivnu-local-sale-note-constraint-20261102.sh'
  sudo '$remote_root/deploy/admin/migrate-vm3-rivnu-local-sale-note-constraint-20261102.sh'
"

chmod 700 "$repo/deploy/admin/activate-vm2-rivnu-order-fiscal-family-fix-20261102.sh"
sudo "$repo/deploy/admin/activate-vm2-rivnu-order-fiscal-family-fix-20261102.sh"

printf '%s\n' RIVNU_LOCAL_SALE_NOTE_VM3_VM2_DEPLOY_COMPLETE

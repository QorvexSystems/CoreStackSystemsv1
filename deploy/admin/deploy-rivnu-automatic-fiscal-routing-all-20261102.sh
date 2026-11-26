#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly vm3='luismel@10.0.0.4'
readonly deployment_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly remote_dir="/home/luismel/rivnu-automatic-fiscal-routing-$deployment_id"
readonly control_root="/tmp/rivnu-routing-deploy-$$"
readonly bundle="/tmp/rivnu-automatic-fiscal-routing-$deployment_id.tar.gz"
readonly remote_bundle="/home/luismel/$(basename "$bundle")"

fail() { printf '%s\n' "$1" >&2; exit 1; }
cleanup() {
  ssh -S "$control_root/vm3" -O exit "$vm3" >/dev/null 2>&1 || true
  rm -f -- "$bundle"
  rmdir "$control_root" 2>/dev/null || true
}
trap cleanup EXIT

[[ "$(hostname)" == VM2-APP && "$PWD" == "$repo" ]] || fail RUN_FROM_RIVNU_REPOSITORY_ON_VM2
for file in \
  deploy/admin/migrate-vm3-rivnu-local-sale-sequence-20261102.sh \
  deploy/admin/activate-vm2-rivnu-automatic-fiscal-routing-20261102.sh \
  packages/database/prisma/migrations/20261102100000_rivnu_local_sale_sequence/migration.sql; do
  [[ -f "$file" && ! -L "$file" ]] || fail "DEPLOYMENT_SOURCE_INVALID_$file"
done

tar -czf "$bundle" \
  deploy/admin/migrate-vm3-rivnu-local-sale-sequence-20261102.sh \
  packages/database/prisma/migrations/20261102100000_rivnu_local_sale_sequence/migration.sql
readonly bundle_hash="$(sha256sum "$bundle" | cut -d' ' -f1)"
mkdir -m 0700 "$control_root"

printf '%s\n' 'Conectando VM3 una sola vez para aplicar la migración de mínimo privilegio...'
ssh -MNf -o ControlMaster=yes -o ControlPersist=15m -o ControlPath="$control_root/vm3" "$vm3"
scp -o ControlPath="$control_root/vm3" "$bundle" "$vm3:/home/luismel/"
ssh -tt -o ControlPath="$control_root/vm3" "$vm3" \
  "set -e; test \"\$(sha256sum '$remote_bundle' | cut -d' ' -f1)\" = '$bundle_hash'; test ! -e '$remote_dir'; mkdir -m 700 '$remote_dir'; tar -xzf '$remote_bundle' -C '$remote_dir'; chmod 700 '$remote_dir/deploy/admin/migrate-vm3-rivnu-local-sale-sequence-20261102.sh'; sudo '$remote_dir/deploy/admin/migrate-vm3-rivnu-local-sale-sequence-20261102.sh'"

chmod 700 "$repo/deploy/admin/activate-vm2-rivnu-automatic-fiscal-routing-20261102.sh"
sudo "$repo/deploy/admin/activate-vm2-rivnu-automatic-fiscal-routing-20261102.sh"

printf '%s\n' 'RIVNU_AUTOMATIC_FISCAL_ROUTING_ALL_HOSTS_DEPLOYED'
printf '%s\n' 'No test invoice, local reference, e-NCF reservation, payment or DGII request was created.'

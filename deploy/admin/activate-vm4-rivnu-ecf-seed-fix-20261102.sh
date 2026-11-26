#!/usr/bin/env bash
# Atomically replace only the production fiscal worker, then authenticate a
# seed against DGII production. No e-CF is registered, reserved or submitted.
set -Eeuo pipefail
set +x
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }

readonly source_root=${1:-}
readonly audit="$source_root/deploy/admin/audit-vm4-rivnu-ecf-production-auth-20261102.sh"
readonly audit_source="$source_root/packages/fiscal/test/production-auth-audit.ts"
readonly compose='/opt/corestack/fe/production/compose.yml'
readonly container='corestack-fiscal-production-fiscal-production-1'
readonly old_image='corestack/fiscal-production:rivnu-20261102-health-fix'
readonly old_id='sha256:d544d27ec745b1212e6e33d98e66759f525a998eda35fdc49afeec343f1609c4'
readonly new_image='corestack/fiscal-production:rivnu-20261102-seed-fix'
readonly new_id='sha256:733e9920ade6d74b8f631350b29d4f93c50064c1bb4999477fb6892f71de0a3a'
readonly compose_hash='f85d5bf1074095c20bea9b51fa4425edb2f245028260db25bdc6b6e0bb5cb091'
readonly production_config_hash='6c0b021caea710ebd66318b9c2daae33afee1587aa07324060f32fd6cb6eac21'
readonly activation_hash='b2c77a975732e163da4d91c62cea1ab6572c2427c88192f62d1e6e959b14692a'
readonly backup="/opt/corestack/backups/rivnu-ecf-seed-fix-$(date -u +%Y%m%dT%H%M%SZ)"

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# == 1 && -d "$source_root" && ! -L "$source_root" ]] || fail 'SUPPLY_REVIEWED_DEPLOY_DIRECTORY'
[[ -f "$audit" && ! -L "$audit" && -x "$audit" ]] || fail 'AUTH_AUDITOR_INVALID'
[[ -f "$audit_source" && ! -L "$audit_source" && -s "$audit_source" ]] || fail 'AUTH_AUDIT_SOURCE_INVALID'
[[ -f "$compose" && ! -L "$compose" && "$(hash_file "$compose")" == "$compose_hash" ]] || fail 'PRODUCTION_COMPOSE_INVALID'
[[ "$(hash_file /opt/corestack/fe/config/fiscal-production.json)" == "$production_config_hash" ]] || fail 'PRODUCTION_CONFIG_CHANGED'
[[ "$(hash_file /opt/corestack/fe/config/fiscal-production-activation.json)" == "$activation_hash" ]] || fail 'PRODUCTION_ACTIVATION_CHANGED'
[[ "$(docker image inspect "$new_image" --format '{{.Id}}' 2>/dev/null)" == "$new_id" ]] || fail 'SEED_FIX_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "$new_image" --format '{{.Config.User}}')" == '10004:4101' ]] || fail 'SEED_FIX_IMAGE_USER_INVALID'

current_state=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}')
current_image=$(docker inspect "$container" --format '{{.Config.Image}}')
current_id=$(docker inspect "$container" --format '{{.Image}}')
[[ "$current_state" == 'running|healthy' ]] || fail "CURRENT_FISCAL_PRODUCTION_NOT_HEALTHY state=$current_state"

if [[ "$current_image" == "$new_image" && "$current_id" == "$new_id" ]]; then
  "$audit" "$source_root"
  printf '%s\n' 'RIVNU_ECF_SEED_FIX_ALREADY_ACTIVE_AND_AUTHENTICATED'
  exit 0
fi
[[ "$current_image" == "$old_image" && "$current_id" == "$old_id" ]] || fail "UNREVIEWED_CURRENT_FISCAL_IMAGE image=$current_image id=$current_id"

install -d -o root -g root -m 0700 "$backup"
docker inspect "$container" >"$backup/production-container.before.json"
cp --preserve=mode,ownership,timestamps "$compose" "$backup/compose.yml"

activated=false
rollback() {
  local status=$?
  if [[ "$activated" == true ]]; then
    docker inspect "$container" >"$backup/production-container.failed.json" 2>/dev/null || true
    docker logs --tail 200 "$container" >"$backup/production-container.failed.log" 2>&1 || true
    FISCAL_PRODUCTION_IMAGE="$old_image" docker compose -f "$compose" up -d \
      --no-deps --force-recreate --no-build --pull never fiscal-production >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_ECF_SEED_FIX_ACTIVATION_FAILED_ROLLED_BACK status=%s backup=%s\n' "$status" "$backup" >&2
  exit "$status"
}
trap rollback ERR

activated=true
FISCAL_PRODUCTION_IMAGE="$new_image" docker compose -f "$compose" config --quiet
FISCAL_PRODUCTION_IMAGE="$new_image" docker compose -f "$compose" up -d \
  --no-deps --force-recreate --no-build --pull never fiscal-production

for _ in $(seq 1 90); do
  state=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  [[ "$state" == 'running|healthy' ]] && break
  [[ "$state" == *'|unhealthy' ]] && false
  sleep 1
done
[[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
[[ "$(docker inspect "$container" --format '{{.Image}}')" == "$new_id" ]]

"$audit" "$source_root"
trap - ERR

printf 'RIVNU_ECF_SEED_FIX_ACTIVATED_AND_DGII_AUTHENTICATED backup=%s\n' "$backup"
printf 'PIPELINE=%s\n' "$new_id"
printf '%s\n' 'No e-NCF, invoice, reservation, signing job, delivery job or DGII fiscal submission was created.'

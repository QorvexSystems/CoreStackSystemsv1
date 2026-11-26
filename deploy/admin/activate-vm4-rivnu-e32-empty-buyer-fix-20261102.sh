#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly image='corestack/fiscal-production:rivnu-e32-empty-buyer-fix-20261102'
readonly image_id='sha256:156c64134e46e0749d893ed36ec3dcbe4db733acdf710d3a045e3b7b6906c09f'
readonly compose='/opt/corestack/fe/production/compose.yml'
readonly container='corestack-fiscal-production-fiscal-production-1'
readonly backup="/opt/corestack/backups/rivnu-e32-empty-buyer-fix-$(date -u +%Y%m%dT%H%M%SZ)"
fail(){ printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail RUN_WITH_SUDO_ON_VM4
[[ -f "$compose" && ! -L "$compose" ]] || fail PRODUCTION_COMPOSE_INVALID
[[ "$(docker image inspect "$image" --format '{{.Id}}')" == "$image_id" ]] || fail PRODUCTION_IMAGE_INVALID
[[ "$(docker image inspect "$image" --format '{{.Config.User}}')" == '10004:4101' ]] || fail PRODUCTION_USER_INVALID
[[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]] || fail CURRENT_CONTAINER_UNHEALTHY

install -d -o root -g root -m 0700 "$backup"
docker inspect "$container" >"$backup/production.before.json"
old_image=$(docker inspect "$container" --format '{{.Config.Image}}')
activated=false
rollback(){
  local status=$?
  if [[ "$activated" == true ]]; then
    FISCAL_PRODUCTION_IMAGE="$old_image" docker compose -f "$compose" up -d --no-deps --force-recreate --no-build --pull never fiscal-production >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_E32_EMPTY_BUYER_FIX_VM4_FAILED_ROLLED_BACK status=%s backup=%s\n' "$status" "$backup" >&2
}
trap rollback ERR
activated=true
FISCAL_PRODUCTION_IMAGE="$image" docker compose -f "$compose" up -d --no-deps --force-recreate --no-build --pull never fiscal-production
for _ in $(seq 1 90); do
  state=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  [[ "$state" == 'running|healthy' ]] && break
  [[ "$state" == *'|unhealthy' ]] && false
  sleep 1
done
[[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
[[ "$(docker inspect "$container" --format '{{.Image}}')" == "$image_id" ]]
trap - ERR
printf 'RIVNU_E32_EMPTY_BUYER_FIX_VM4_ACTIVATED backup=%s\n' "$backup"
printf 'PIPELINE=%s\n' "$image_id"
printf '%s\n' 'No e-NCF, invoice, reservation or DGII request was created during activation.'

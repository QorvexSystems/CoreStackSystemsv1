#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly production_image='corestack/fiscal-production:rivnu-printed-representation-20261102'
readonly range_image='corestack/fiscal-range-registration:rivnu-printed-representation-20261102'
readonly production_id='sha256:80cf3a2fc1497e2370fffe900a48bcf03de2485756445dab5affc09fccedccd5'
readonly range_id='sha256:e8a909fe33968903b18ecc5bad595417dd488d7b6629149044ef7d5699ecbfec'
readonly production_compose='/opt/corestack/fe/production/compose.yml'
readonly range_compose='/opt/corestack/fe/range-registration/compose.yml'
readonly production_container='corestack-fiscal-production-fiscal-production-1'
readonly range_container='corestack-fiscal-range-registration-fiscal-range-registration-1'
readonly backup="/opt/corestack/backups/rivnu-printed-representation-$(date -u +%Y%m%dT%H%M%SZ)"
fail(){ printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail RUN_WITH_SUDO_ON_VM4
for file in "$production_compose" "$range_compose"; do
  [[ -f "$file" && ! -L "$file" ]] || fail "COMPOSE_INVALID_$file"
done
[[ "$(docker image inspect "$production_image" --format '{{.Id}}')" == "$production_id" ]] || fail PRODUCTION_IMAGE_INVALID
[[ "$(docker image inspect "$range_image" --format '{{.Id}}')" == "$range_id" ]] || fail RANGE_IMAGE_INVALID
[[ "$(docker image inspect "$production_image" --format '{{.Config.User}}')" == '10004:4101' ]] || fail PRODUCTION_USER_INVALID
[[ "$(docker image inspect "$range_image" --format '{{.Config.User}}')" == '10003:4101' ]] || fail RANGE_USER_INVALID
for container in "$production_container" "$range_container"; do
  [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]] || fail "CURRENT_CONTAINER_UNHEALTHY_$container"
done

install -d -o root -g root -m 0700 "$backup"
docker inspect "$production_container" >"$backup/production.before.json"
docker inspect "$range_container" >"$backup/range.before.json"
old_production=$(docker inspect "$production_container" --format '{{.Config.Image}}')
old_range=$(docker inspect "$range_container" --format '{{.Config.Image}}')
activated=false
rollback(){
  local status=$?
  if [[ "$activated" == true ]]; then
    FISCAL_PRODUCTION_IMAGE="$old_production" docker compose -f "$production_compose" up -d --no-deps --force-recreate --no-build --pull never fiscal-production >/dev/null 2>&1 || true
    FISCAL_RANGE_REGISTRATION_IMAGE="$old_range" docker compose -f "$range_compose" up -d --no-deps --force-recreate --no-build --pull never fiscal-range-registration >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_PRINTED_REPRESENTATION_VM4_FAILED_ROLLED_BACK status=%s backup=%s\n' "$status" "$backup" >&2
}
trap rollback ERR
activated=true
FISCAL_PRODUCTION_IMAGE="$production_image" docker compose -f "$production_compose" up -d --no-deps --force-recreate --no-build --pull never fiscal-production
FISCAL_RANGE_REGISTRATION_IMAGE="$range_image" docker compose -f "$range_compose" up -d --no-deps --force-recreate --no-build --pull never fiscal-range-registration
for container in "$production_container" "$range_container"; do
  for _ in $(seq 1 90); do
    state=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
    [[ "$state" == 'running|healthy' ]] && break
    [[ "$state" == *'|unhealthy' ]] && false
    sleep 1
  done
  [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
done
[[ "$(docker inspect "$production_container" --format '{{.Image}}')" == "$production_id" ]]
[[ "$(docker inspect "$range_container" --format '{{.Image}}')" == "$range_id" ]]
curl --fail --silent --show-error --noproxy '*' --max-time 5 \
 --cacert /opt/corestack/fe/config/internal-root-2026.crt \
 --resolve rivnu-range-registration.internal:4083:10.0.0.1 \
 https://rivnu-range-registration.internal:4083/health/live >/dev/null
trap - ERR
printf 'RIVNU_PRINTED_REPRESENTATION_VM4_ACTIVATED backup=%s\n' "$backup"
printf 'PIPELINE=%s\nRANGE=%s\n' "$production_id" "$range_id"
printf '%s\n' 'No e-NCF, invoice, reservation or DGII request was created.'


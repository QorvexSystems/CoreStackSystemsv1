#!/usr/bin/env bash
# Replace only the reviewed fixed scope config and recreate the range service with rollback.
set -Eeuo pipefail
set +x
umask 077

readonly source=${1:-}
readonly expected_source_hash='bbe12cec64e42afc441909baaa8bd0bc7c6d2314e06855ce314462887ecf22ea'
readonly target='/opt/corestack/fe/config/fiscal-range-registration.json'
readonly compose='/opt/corestack/fe/range-registration/compose.yml'
readonly image='corestack/fiscal-range-registration:production-rivnu-20261101'
readonly container='corestack-fiscal-range-registration-fiscal-range-registration-1'
readonly backup="/opt/corestack/backups/rivnu-range-tenant-config-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# == 1 && -f "$source" && ! -L "$source" && "$(hash_file "$source")" == "$expected_source_hash" ]] || fail 'CORRECTED_RANGE_CONFIG_INVALID'
[[ -f "$target" && ! -L "$target" && -f "$compose" && ! -L "$compose" ]] || fail 'ACTIVE_RANGE_DEPLOYMENT_INVALID'
[[ "$(docker inspect "$container" --format '{{.Config.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$image|running|healthy" ]] || fail 'ACTIVE_RANGE_CONTAINER_NOT_HEALTHY'
grep -q '"tenantId": "cmqn0r66a0002lit0vxbzq5l4"' "$source" || fail 'CORRECTED_TENANT_MISSING'
grep -q '"issuerRnc": "40220429126"' "$source" || fail 'CORRECTED_RNC_MISSING'
grep -q '"tenantId": "cmt397emm0002nm0ogb50l2q6"' "$target" || fail 'CURRENT_TENANT_SCOPE_UNEXPECTED'

install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$target" "$backup/fiscal-range-registration.json"
temporary=$(mktemp /opt/corestack/fe/config/.fiscal-range-registration.XXXXXX)
install -o root -g root -m 0444 "$source" "$temporary"
mv -T "$temporary" "$target"

activated='true'
rollback() {
  if [[ "$activated" == 'true' ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/fiscal-range-registration.json" "$target" || true
    FISCAL_RANGE_REGISTRATION_IMAGE="$image" docker compose -f "$compose" up -d --force-recreate --no-build --pull never >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_RANGE_TENANT_CONFIG_FAILED_ROLLED_BACK backup=%s\n' "$backup" >&2
}
trap rollback ERR
FISCAL_RANGE_REGISTRATION_IMAGE="$image" docker compose -f "$compose" up -d --force-recreate --no-build --pull never
for _ in $(seq 1 45); do
  health=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  [[ "$health" == 'running|healthy' ]] && break
  [[ "$health" == *'|unhealthy' ]] && false
  sleep 1
done
[[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
grep -q '"tenantId": "cmqn0r66a0002lit0vxbzq5l4"' "$target"
trap - ERR

printf 'RIVNU_FISCAL_RANGE_VM4_PRODUCTION_TENANT_UPDATED_HEALTHY backup=%s\n' "$backup"
printf '%s\n' 'No range, sequence, invoice, credential or DGII request was created.'

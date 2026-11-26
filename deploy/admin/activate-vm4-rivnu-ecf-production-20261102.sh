#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly source_dir=${1:-}
readonly source_range_compose="$source_dir/deploy/docker/compose.fiscal-range-registration.yml"
readonly source_production_compose="$source_dir/deploy/docker/compose.fiscal-production.yml"
readonly source_range_config="$source_dir/deploy/env/fiscal-range-registration.rivnu-production.json"
readonly source_production_config="$source_dir/deploy/env/fiscal-production.rivnu.json"
readonly source_activation="$source_dir/deploy/env/fiscal-production-activation.rivnu.json"
readonly range_compose_hash='6c1310a109322bebefeb82aea15da8b2071b4db3a7a52ed7856788f61fe8de9a'
readonly production_compose_hash='f85d5bf1074095c20bea9b51fa4425edb2f245028260db25bdc6b6e0bb5cb091'
readonly range_config_hash='bbe12cec64e42afc441909baaa8bd0bc7c6d2314e06855ce314462887ecf22ea'
readonly production_config_hash='6c0b021caea710ebd66318b9c2daae33afee1587aa07324060f32fd6cb6eac21'
readonly activation_hash='b2c77a975732e163da4d91c62cea1ab6572c2427c88192f62d1e6e959b14692a'
readonly range_image='corestack/fiscal-range-registration:production-rivnu-issuance-20261102'
readonly production_image='corestack/fiscal-production:rivnu-20261102-health-fix'
readonly range_id='sha256:fe9ec0619a1d055a81673c42ed0e9ad47c65be833614e24b3fb8968c5240725c'
readonly production_id='sha256:d544d27ec745b1212e6e33d98e66759f525a998eda35fdc49afeec343f1609c4'
readonly range_destination='/opt/corestack/fe/range-registration'
readonly production_destination='/opt/corestack/fe/production'
readonly range_compose="$range_destination/compose.yml"
readonly production_compose="$production_destination/compose.yml"
readonly range_config='/opt/corestack/fe/config/fiscal-range-registration.json'
readonly production_config='/opt/corestack/fe/config/fiscal-production.json'
readonly activation='/opt/corestack/fe/config/fiscal-production-activation.json'
readonly range_container='corestack-fiscal-range-registration-fiscal-range-registration-1'
readonly production_container='corestack-fiscal-production-fiscal-production-1'
readonly backup="/opt/corestack/backups/rivnu-ecf-production-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# == 1 && -d "$source_dir" && ! -L "$source_dir" ]] || fail 'SUPPLY_REVIEWED_DEPLOY_DIRECTORY'
declare -A expected=(
  ["$source_range_compose"]="$range_compose_hash"
  ["$source_production_compose"]="$production_compose_hash"
  ["$source_range_config"]="$range_config_hash"
  ["$source_production_config"]="$production_config_hash"
  ["$source_activation"]="$activation_hash"
)
for file in "${!expected[@]}"; do
  [[ -f "$file" && ! -L "$file" && "$(hash_file "$file")" == "${expected[$file]}" ]] || fail "SOURCE_INVALID_$file"
done
[[ "$(docker image inspect "$range_image" --format '{{.Id}}' 2>/dev/null)" == "$range_id" ]] || fail 'RANGE_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "$production_image" --format '{{.Id}}' 2>/dev/null)" == "$production_id" ]] || fail 'PRODUCTION_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "$range_image" --format '{{.Config.User}}')" == '10003:4101' ]] || fail 'RANGE_IMAGE_USER_INVALID'
[[ "$(docker image inspect "$production_image" --format '{{.Config.User}}')" == '10004:4101' ]] || fail 'PRODUCTION_IMAGE_USER_INVALID'
docker network inspect fiscal-network >/dev/null 2>&1 || fail 'FISCAL_NETWORK_MISSING'

for file in \
  /opt/corestack/fe/config/internal-root-2026.crt \
  /opt/corestack/fe/config/rivnu-range-registration.crt \
  /opt/corestack/secrets/rivnu-range-registration/postgresql.password \
  /opt/corestack/secrets/rivnu-range-registration/service.token \
  /opt/corestack/secrets/rivnu-range-registration/tls.key \
  /opt/corestack/secrets/rivnu-fiscal-production/postgresql.password \
  /opt/corestack/secrets/rivnu-signer-runtime/certificate.p12 \
  /opt/corestack/secrets/rivnu-signer-runtime/certificate.password \
  /opt/corestack/secrets/rivnu-signer-runtime/root.crt \
  /opt/corestack/secrets/rivnu-signer-runtime/subordinate.crt \
  /opt/corestack/secrets/rivnu-signer-runtime/subordinate.crl.pem; do
  [[ -f "$file" && ! -L "$file" && -s "$file" ]] || fail "REQUIRED_SECRET_OR_TRUST_MISSING_$file"
done
[[ "$(docker inspect "$range_container" --format '{{.State.Status}}|{{.State.Health.Status}}' 2>/dev/null)" == 'running|healthy' ]] || fail 'CURRENT_RANGE_SERVICE_NOT_HEALTHY'

install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$range_compose" "$backup/range-compose.yml"
cp --preserve=mode,ownership,timestamps "$range_config" "$backup/fiscal-range-registration.json"
docker inspect "$range_container" >"$backup/range-container.before.json"
install -d -o root -g root -m 0755 "$production_destination"
install -o root -g root -m 0444 "$source_range_compose" "$range_compose"
install -o root -g root -m 0444 "$source_production_compose" "$production_compose"
install -o root -g root -m 0444 "$source_range_config" "$range_config"
install -o root -g 4101 -m 0440 "$source_production_config" "$production_config"
install -o root -g 4101 -m 0440 "$source_activation" "$activation"

activated=false
rollback() {
  local result=$?
  if [[ "$activated" == true ]]; then
    docker inspect "$production_container" >"$backup/production-container.failed.json" 2>/dev/null || true
    docker logs --tail 200 "$production_container" >"$backup/production-container.failed.log" 2>&1 || true
    FISCAL_PRODUCTION_IMAGE="$production_image" docker compose -f "$production_compose" down >/dev/null 2>&1 || true
    cp --preserve=mode,ownership,timestamps "$backup/range-compose.yml" "$range_compose" || true
    cp --preserve=mode,ownership,timestamps "$backup/fiscal-range-registration.json" "$range_config" || true
    old_image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["Config"]["Image"])' "$backup/range-container.before.json" 2>/dev/null || true)
    [[ -n "$old_image" ]] && FISCAL_RANGE_REGISTRATION_IMAGE="$old_image" docker compose -f "$range_compose" up -d --no-build >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_ECF_VM4_ACTIVATION_FAILED_ROLLED_BACK status=%s backup=%s\n' "$result" "$backup" >&2
}
trap rollback ERR
activated=true
FISCAL_RANGE_REGISTRATION_IMAGE="$range_image" docker compose -f "$range_compose" config --quiet
FISCAL_PRODUCTION_IMAGE="$production_image" docker compose -f "$production_compose" config --quiet
FISCAL_RANGE_REGISTRATION_IMAGE="$range_image" docker compose -f "$range_compose" up -d --no-build --pull never
FISCAL_PRODUCTION_IMAGE="$production_image" docker compose -f "$production_compose" up -d --no-build --pull never

for container in "$range_container" "$production_container"; do
  for _ in $(seq 1 90); do
    health=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
    [[ "$health" == 'running|healthy' ]] && break
    [[ "$health" == *'|unhealthy' ]] && false
    sleep 1
  done
  [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
done
[[ "$(docker inspect "$range_container" --format '{{.Image}}')" == "$range_id" ]]
[[ "$(docker inspect "$production_container" --format '{{.Image}}')" == "$production_id" ]]
curl --fail --silent --show-error --noproxy '*' --max-time 5 \
  --cacert /opt/corestack/fe/config/internal-root-2026.crt \
  --resolve rivnu-range-registration.internal:4083:10.0.0.1 \
  https://rivnu-range-registration.internal:4083/health/live >/dev/null
trap - ERR

printf 'RIVNU_ECF_VM4_CORE_ACTIVATED_HEALTHY backup=%s\n' "$backup"
printf 'RANGE=%s\nPIPELINE=%s\n' "$range_id" "$production_id"
printf '%s\n' 'No e-NCF or invoice was created. DGII authentication health may occur; no e-CF was submitted.'

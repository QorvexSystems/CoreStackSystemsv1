#!/usr/bin/env bash
# Deploy only the RIVNU authorized-range registry after all trust checks pass.
set -Eeuo pipefail
set +x
umask 077

readonly image='corestack/fiscal-range-registration:production-rivnu-20261101'
readonly image_id='sha256:dc412ed5acda915a7577a800ae12e2d89345d3534841633faa1e104ffe6083fc'
readonly source_dir=${1:-}
readonly source_compose="$source_dir/deploy/docker/compose.fiscal-range-registration.yml"
readonly source_config="$source_dir/deploy/env/fiscal-range-registration.rivnu-production.json"
readonly compose_hash='ff0a30dc269c0d5714ebf9c2eb4058a11cf8f15f71e20dc3c49dc18c18dc9889'
readonly config_hash='d62eb54becf74494e7d637129db8399d0780769a983d962bc83579bc7e4a356d'
readonly ca_fingerprint='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly destination='/opt/corestack/fe/range-registration'
readonly compose="$destination/compose.yml"
readonly config='/opt/corestack/fe/config/fiscal-range-registration.json'
readonly secret_dir='/opt/corestack/secrets/rivnu-range-registration'
readonly certificate='/opt/corestack/fe/config/rivnu-range-registration.crt'
readonly ca='/opt/corestack/fe/config/internal-root-2026.crt'
readonly container='corestack-fiscal-range-registration-fiscal-range-registration-1'

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# == 1 && -d "$source_dir" && ! -L "$source_dir" ]] || fail 'SUPPLY_REVIEWED_DEPLOY_DIRECTORY'
[[ -f "$source_compose" && ! -L "$source_compose" && "$(hash_file "$source_compose")" == "$compose_hash" ]] || fail 'RANGE_COMPOSE_HASH_MISMATCH'
[[ -f "$source_config" && ! -L "$source_config" && "$(hash_file "$source_config")" == "$config_hash" ]] || fail 'RANGE_CONFIG_HASH_MISMATCH'
[[ "$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" == "$image_id" ]] || fail 'RANGE_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "$image" --format '{{.Config.User}}')" == '10003:4101' ]] || fail 'RANGE_IMAGE_USER_INVALID'
docker network inspect fiscal-network >/dev/null 2>&1 || fail 'FISCAL_NETWORK_MISSING'
[[ ! -e "$destination" && ! -L "$destination" && ! -e "$config" && ! -L "$config" ]] || fail 'RANGE_DEPLOYMENT_EXISTS_REVIEW_REQUIRED'
[[ -z "$(docker ps -aq --filter name="^/${container}$")" ]] || fail 'RANGE_CONTAINER_EXISTS_REVIEW_REQUIRED'
[[ -z "$(ss -H -lnt 'sport = :4083')" ]] || fail 'RANGE_PORT_ALREADY_BOUND'

[[ -d "$secret_dir" && ! -L "$secret_dir" && "$(stat -c '%u:%g:%a' "$secret_dir")" == '0:4101:750' ]] || fail 'RANGE_SECRET_DIRECTORY_INVALID'
for file in postgresql.password service.token tls.key; do
  [[ -f "$secret_dir/$file" && ! -L "$secret_dir/$file" && -s "$secret_dir/$file" && "$(stat -c '%u:%g:%a' "$secret_dir/$file")" == '0:4101:440' ]] || fail "RANGE_SECRET_INVALID_$file"
done
token=$(<"$secret_dir/service.token")
[[ "$token" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail 'RANGE_SERVICE_TOKEN_FORMAT_INVALID'
unset token
[[ -f "$ca" && ! -L "$ca" && "$(openssl x509 -in "$ca" -noout -fingerprint -sha256 | cut -d= -f2)" == "$ca_fingerprint" ]] || fail 'INTERNAL_CA_PIN_MISMATCH'
[[ -f "$certificate" && ! -L "$certificate" && "$(stat -c '%u:%g:%a' "$certificate")" == '0:0:444' ]] || fail 'RANGE_TLS_CERTIFICATE_INVALID'
openssl verify -CAfile "$ca" -purpose sslserver -verify_ip 10.0.0.1 "$certificate" >/dev/null
openssl verify -CAfile "$ca" -purpose sslserver -verify_hostname rivnu-range-registration.internal "$certificate" >/dev/null
work=$(mktemp -d /opt/corestack/secrets/.rivnu-range-deploy.XXXXXX)
cleanup() {
  rm -f -- "$work/cert-public.pem" "$work/key-public.pem"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
openssl x509 -in "$certificate" -pubkey -noout >"$work/cert-public.pem"
openssl pkey -in "$secret_dir/tls.key" -pubout >"$work/key-public.pem"
cmp -s "$work/cert-public.pem" "$work/key-public.pem" || fail 'RANGE_TLS_CERTIFICATE_KEY_MISMATCH'

install -d -o root -g root -m 0755 "$destination"
install -o root -g root -m 0444 "$source_compose" "$compose"
install -o root -g root -m 0444 "$source_config" "$config"

activated='false'
rollback() {
  if [[ "$activated" == 'true' ]]; then
    FISCAL_RANGE_REGISTRATION_IMAGE="$image" docker compose -f "$compose" down >/dev/null 2>&1 || true
  fi
  printf '%s\n' 'RIVNU_FISCAL_RANGE_DEPLOYMENT_FAILED_CONTAINER_ROLLED_BACK' >&2
}
deploy_fail() {
  local message=$1
  rollback
  activated='false'
  fail "$message"
}
trap rollback ERR
FISCAL_RANGE_REGISTRATION_IMAGE="$image" docker compose -f "$compose" up -d --no-build --pull never
activated='true'

for _ in $(seq 1 45); do
  health=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' 2>/dev/null || true)
  [[ "$health" == 'healthy' ]] && break
  [[ "$health" == 'unhealthy' ]] && deploy_fail 'RANGE_CONTAINER_UNHEALTHY'
  sleep 1
done
[[ "$(docker inspect "$container" --format '{{.Image}}')" == "$image_id" ]] || deploy_fail 'RUNNING_RANGE_IMAGE_MISMATCH'
[[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]] || deploy_fail 'RANGE_CONTAINER_NOT_HEALTHY'
curl --fail --silent --show-error --noproxy '*' --max-time 5 \
  --cacert "$ca" --resolve rivnu-range-registration.internal:4083:10.0.0.1 \
  https://rivnu-range-registration.internal:4083/health/live >/dev/null

trap - ERR
printf '%s\n' 'RIVNU_FISCAL_RANGE_REGISTRATION_DEPLOYED_HEALTHY_NOT_CONNECTED_TO_ERP'
printf 'Image=%s\n' "$image_id"
printf '%s\n' 'No range, sequence, invoice, signing job, delivery job or DGII request was created.'

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly source=/home/luismel/rivnu-fiscal-receiver-approval-scope-fix-20261020
readonly source_config="$source/fiscal-receiver.rivnu-certification.json"
readonly compose=/opt/corestack/fe/compose/compose.fiscal-receiver.yml
readonly env_file=/opt/corestack/fe/compose/fiscal-receiver.env
readonly config=/opt/corestack/fe/config/fiscal-receiver.json
readonly tls_cert=/opt/corestack/fe/config/fiscal-receiver-tls.crt
readonly trust=/opt/corestack/fe/config/trust/dgii/communication-root.pem
readonly service=corestack-fiscal-receiver-fiscal-receiver-1
readonly image=corestack/fiscal-receiver:certification-20261020
readonly expected_image_id=sha256:9d872e74f6be954cfd1cc1ddad2983a017c426a9723e0b7a16562865e446aed7
readonly expected_config_sha256=7a3bbf007b4b5cbe2d07165485344ca9af086fbfcf6998a50b304ee22edb6adc
readonly expected_trust_sha256=b9dde49a4667fc682074f166bfeada5d704fff4c7a8a6c38e5908814cccf5a66
readonly expected_pin=3d0be20c8bd2917f0e2d5a8d4dac056b50993fa8ef5c9884798c58f940c59cbb

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail RUN_WITH_SUDO_ON_VM4
ip -4 addr show | grep -q '10\.0\.0\.1/' || fail VM4_PRIVATE_IP_NOT_PRESENT
for path in "$source_config" "$compose" "$env_file" "$config" "$tls_cert" "$trust"; do
  [[ -f "$path" && ! -L "$path" ]] || fail "REQUIRED_REGULAR_FILE_MISSING_$path"
done
[[ "$(hash_of "$source_config")" == "$expected_config_sha256" ]] || fail RECEIVER_CONFIG_SOURCE_HASH_MISMATCH
[[ "$(hash_of "$trust")" == "$expected_trust_sha256" ]] || fail DGII_TRUST_HASH_MISMATCH
grep -Fqx "  \"expectedIncomingCertificateSha256\": \"$expected_pin\"," "$source_config" ||
  fail RECEIVER_CERTIFICATE_PIN_MISMATCH

readonly loaded_image_id="$(docker image inspect "$image" --format '{{.Id}}')"
[[ "$loaded_image_id" == "$expected_image_id" ]] || fail RECEIVER_IMAGE_ID_MISMATCH
readonly previous_image_id="$(docker inspect "$service" --format '{{.Image}}')"
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup=/opt/corestack/backups/fiscal-receiver-pin-$timestamp
install -d -o root -g root -m 0700 "$backup"
install -o root -g root -m 0600 "$config" "$backup/fiscal-receiver.json"
printf '%s\n' "$previous_image_id" > "$backup/previous-image-id"

rollback() {
  code=$?
  trap - ERR
  install -o root -g 4101 -m 0440 "$backup/fiscal-receiver.json" "$config" || true
  docker tag "$previous_image_id" "$image" >/dev/null 2>&1 || true
  docker compose --env-file "$env_file" -f "$compose" up -d --force-recreate >/dev/null 2>&1 || true
  printf 'RIVNU_FISCAL_RECEIVER_PIN_UPDATE_ROLLED_BACK backup=%s\n' "$backup" >&2
  exit "$code"
}
trap rollback ERR

readonly config_temp="$(mktemp /opt/corestack/fe/config/fiscal-receiver.json.XXXXXX)"
install -o root -g 4101 -m 0440 "$source_config" "$config_temp"
mv -f -- "$config_temp" "$config"
docker compose --env-file "$env_file" -f "$compose" up -d --force-recreate

state=unknown
for _ in $(seq 1 40); do
  state="$(docker inspect "$service" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy || "$state" == exited ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || { docker logs --tail 30 "$service" >&2; fail RECEIVER_NOT_HEALTHY; }
[[ "$(docker inspect "$service" --format '{{.Image}}')" == "$loaded_image_id" ]] || fail RECEIVER_IMAGE_NOT_UPDATED
[[ "$(docker inspect "$service" --format '{{.Config.User}}')" == 10001:4101 ]] || fail RECEIVER_RUNTIME_IDENTITY_INVALID
[[ "$(docker inspect "$service" --format '{{.HostConfig.NetworkMode}}')" == host ]] || fail RECEIVER_NETWORK_MODE_INVALID
[[ "$(docker exec "$service" sha256sum /run/config/fiscal-receiver.json | cut -d ' ' -f 1)" == "$expected_config_sha256" ]] ||
  fail RECEIVER_RUNNING_CONFIG_HASH_MISMATCH
curl --silent --show-error --fail --connect-timeout 5 \
  --cacert "$tls_cert" \
  --resolve rivnu-fiscal-receiver.internal:8444:10.0.0.1 \
  https://rivnu-fiscal-receiver.internal:8444/health/live >/dev/null

trap - ERR
printf 'RIVNU_FISCAL_RECEIVER_DGII_TEST_CERTIFICATE_PIN_ACTIVE image=%s backup=%s\n' "$loaded_image_id" "$backup"
printf 'Production remains disabled; VM1 routes, firewall, keys, database and evidence were unchanged.\n'

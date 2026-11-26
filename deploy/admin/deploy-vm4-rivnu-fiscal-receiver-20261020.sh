#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly source=/home/luismel/rivnu-fiscal-receiver-deploy-20261020
readonly compose=/opt/corestack/fe/compose/compose.fiscal-receiver.yml
readonly env_file=/opt/corestack/fe/compose/fiscal-receiver.env
readonly config=/opt/corestack/fe/config/fiscal-receiver.json
readonly tls_cert=/opt/corestack/fe/config/fiscal-receiver-tls.crt
readonly tls_key=/opt/corestack/secrets/fiscal-receiver-tls.key
readonly dgii_trust=/opt/corestack/fe/config/trust/dgii/communication-root.pem
readonly evidence=/opt/corestack/fe/evidence/receiver
readonly image=corestack/fiscal-receiver:certification-20261020
fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail RUN_WITH_SUDO_ON_VM4
ip -4 addr show | grep -q '10\.0\.0\.1/' || fail VM4_PRIVATE_IP_NOT_PRESENT
for file in compose.fiscal-receiver.yml fiscal-receiver.env fiscal-receiver.rivnu-certification.json; do
  [[ -f "$source/$file" && ! -L "$source/$file" ]] || fail "SOURCE_MISSING_$file"
done
docker image inspect "$image" >/dev/null || fail RECEIVER_IMAGE_NOT_LOADED
for path in "$compose" "$env_file" "$config" "$tls_cert" "$tls_key" "$dgii_trust" "$evidence"; do
  [[ ! -e "$path" && ! -L "$path" ]] || fail RECEIVER_DEPLOYMENT_ALREADY_EXISTS_REVIEW_REQUIRED
done
for path in \
  /opt/corestack/secrets/rivnu-signer-runtime/certificate.p12 \
  /opt/corestack/secrets/rivnu-signer-runtime/certificate.password \
  /opt/corestack/secrets/rivnu-signer-runtime/root.crt \
  /opt/corestack/secrets/rivnu-signer-runtime/subordinate.crt \
  /opt/corestack/secrets/rivnu-signer-runtime/subordinate.crl.pem; do
  [[ -f "$path" && ! -L "$path" ]] || fail SIGNER_RUNTIME_PREREQUISITE_MISSING
done
ss -H -ltn 'sport = :8444' | grep -q . && fail PORT_8444_ALREADY_IN_USE

readonly work="$(mktemp -d /opt/corestack/secrets/fiscal-receiver-setup.XXXXXX)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT

openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 397 \
  -subj '/CN=rivnu-fiscal-receiver.internal' \
  -addext 'subjectAltName=DNS:rivnu-fiscal-receiver.internal,IP:10.0.0.1' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth' \
  -keyout "$work/server.key" -out "$work/server.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 7 \
  -subj '/CN=CORESTACK QUARANTINE TRUST - REPLACE WITH DGII ROOT' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$work/quarantine.key" -out "$work/quarantine.crt" >/dev/null 2>&1
rm -f "$work/quarantine.key"

install -d -o root -g root -m 0750 /opt/corestack/fe/compose /opt/corestack/fe/config
install -d -o root -g 4101 -m 0750 /opt/corestack/fe/config/trust/dgii
install -d -o 10001 -g 4101 -m 0700 "$evidence"
install -o root -g root -m 0444 "$source/compose.fiscal-receiver.yml" "$compose"
install -o root -g root -m 0400 "$source/fiscal-receiver.env" "$env_file"
install -o root -g 4101 -m 0440 "$source/fiscal-receiver.rivnu-certification.json" "$config"
install -o root -g 4101 -m 0440 "$work/server.key" "$tls_key"
install -o root -g root -m 0444 "$work/server.crt" "$tls_cert"
install -o root -g 4101 -m 0440 "$work/quarantine.crt" "$dgii_trust"

started=false
rollback() {
  code=$?
  trap - ERR EXIT
  if [[ "$started" == true ]]; then docker compose --env-file "$env_file" -f "$compose" down >/dev/null 2>&1 || true; fi
  if (( code != 0 )); then printf 'RECEIVER_DEPLOYMENT_FAILED_REVIEW_NEW_FILES\n' >&2; fi
  cleanup
  exit "$code"
}
trap rollback ERR EXIT
docker compose --env-file "$env_file" -f "$compose" up -d
started=true
for _ in $(seq 1 40); do
  state="$(docker inspect corestack-fiscal-receiver-fiscal-receiver-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy || "$state" == exited ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || { docker logs --tail 30 corestack-fiscal-receiver-fiscal-receiver-1 >&2; fail RECEIVER_NOT_HEALTHY; }
[[ "$(docker inspect corestack-fiscal-receiver-fiscal-receiver-1 --format '{{.Config.User}}')" == 10001:4101 ]] || fail RECEIVER_RUNTIME_IDENTITY_INVALID
[[ "$(docker inspect corestack-fiscal-receiver-fiscal-receiver-1 --format '{{.HostConfig.NetworkMode}}')" == host ]] || fail RECEIVER_NETWORK_MODE_INVALID
curl --silent --show-error --fail --cacert "$tls_cert" --resolve rivnu-fiscal-receiver.internal:8444:10.0.0.1 \
  https://rivnu-fiscal-receiver.internal:8444/health/live >/dev/null
started=false
trap - ERR EXIT
cleanup
printf 'RIVNU_FISCAL_RECEIVER_DEPLOYED_QUARANTINED\n'
printf 'Incoming XML remains fail-closed until the DGII communication root from portal step 8 is installed.\n'
printf 'Copy this PUBLIC TLS certificate to VM1: %s\n' "$tls_cert"


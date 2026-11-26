#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly source=${1:-/home/luismel/dgii-communication-root.pem}
readonly expected=${2:-}
readonly target=/opt/corestack/fe/config/trust/dgii/communication-root.pem
readonly compose=/opt/corestack/fe/compose/compose.fiscal-receiver.yml
readonly env_file=/opt/corestack/fe/compose/fiscal-receiver.env
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail RUN_WITH_SUDO_ON_VM4
[[ -f "$source" && ! -L "$source" && -f "$target" ]] || fail DGII_TRUST_FILE_MISSING
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || fail EXPECTED_SHA256_ARGUMENT_REQUIRED
[[ "$(sha256sum "$source" | cut -d' ' -f1)" == "$expected" ]] || fail DGII_TRUST_HASH_MISMATCH
grep -q -- 'BEGIN CERTIFICATE' "$source" || fail DGII_TRUST_NOT_PEM_CERTIFICATE
! grep -q -- 'PRIVATE KEY' "$source" || fail PRIVATE_KEY_FORBIDDEN
[[ "$(grep -c -- 'BEGIN CERTIFICATE' "$source")" -ge 1 && "$(grep -c -- 'BEGIN CERTIFICATE' "$source")" -le 8 ]] || fail DGII_TRUST_CERTIFICATE_COUNT_INVALID
openssl crl2pkcs7 -nocrl -certfile "$source" | openssl pkcs7 -print_certs -noout >/dev/null 2>&1 || fail DGII_TRUST_CERTIFICATE_INVALID
backup="${target}.quarantine-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$target" "$backup"
temp="$(mktemp /opt/corestack/fe/config/trust/dgii/.communication-root.XXXXXX)"
trap 'rm -f -- "$temp"' EXIT
install -o root -g 4101 -m 0440 "$source" "$temp"
mv -f -- "$temp" "$target"
docker compose --env-file "$env_file" -f "$compose" restart fiscal-receiver >/dev/null
for _ in $(seq 1 30); do
  state="$(docker inspect corestack-fiscal-receiver-fiscal-receiver-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == healthy ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || fail RECEIVER_NOT_HEALTHY_AFTER_DGII_TRUST_INSTALL
trap - EXIT
printf 'DGII_COMMUNICATION_TRUST_INSTALLED sha256=%s backup=%s\n' "$expected" "$backup"


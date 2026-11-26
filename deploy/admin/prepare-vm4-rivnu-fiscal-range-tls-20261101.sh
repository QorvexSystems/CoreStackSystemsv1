#!/usr/bin/env bash
# Generate the dedicated VM4 private key and public CSR. No service activation.
set -Eeuo pipefail
set +x
umask 077

readonly secret_root='/opt/corestack/secrets'
readonly secret_dir="$secret_root/rivnu-range-registration"
readonly key="$secret_dir/tls.key"
readonly csr='/opt/corestack/fe/config/rivnu-range-registration.csr.pem'
readonly service_gid='4101'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -d "$secret_root" && ! -L "$secret_root" && "$(stat -c '%u:%g:%a' "$secret_root")" == '0:0:700' ]] || fail 'SECRETS_ROOT_INVALID'
[[ -d "$secret_dir" && ! -L "$secret_dir" && "$(stat -c '%u:%g:%a' "$secret_dir")" == "0:$service_gid:750" ]] || fail 'RANGE_SECRET_DIRECTORY_INVALID'
[[ -f "$secret_dir/postgresql.password" && ! -L "$secret_dir/postgresql.password" && "$(stat -c '%u:%g:%a' "$secret_dir/postgresql.password")" == "0:$service_gid:440" ]] || fail 'RANGE_DATABASE_SECRET_INVALID'
[[ -d /opt/corestack/fe/config && ! -L /opt/corestack/fe/config ]] || fail 'FISCAL_CONFIG_DIRECTORY_INVALID'
[[ ! -e "$key" && ! -L "$key" && ! -e "$csr" && ! -L "$csr" ]] || fail 'RANGE_TLS_MATERIAL_EXISTS_REVIEW_REQUIRED'

work=$(mktemp -d "$secret_root/.rivnu-range-tls.XXXXXX")
cleanup() {
  rm -f -- "$work/tls.key" "$work/request.pem" "$work/key-public.pem" "$work/csr-public.pem"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT

openssl req -new -newkey rsa:3072 -nodes -sha256 \
  -subj '/CN=CoreStack Fiscal Range Registration RIVNU' \
  -addext 'subjectAltName=IP:10.0.0.1,DNS:rivnu-range-registration.internal' \
  -keyout "$work/tls.key" -out "$work/request.pem" 2>/dev/null
openssl req -in "$work/request.pem" -verify -noout >/dev/null
[[ "$(openssl req -in "$work/request.pem" -noout -subject -nameopt RFC2253)" == 'subject=CN=CoreStack Fiscal Range Registration RIVNU' ]] || fail 'RANGE_TLS_CSR_SUBJECT_INVALID'
openssl req -in "$work/request.pem" -noout -text | grep -q 'IP Address:10.0.0.1' || fail 'RANGE_TLS_CSR_IP_INVALID'
openssl req -in "$work/request.pem" -noout -text | grep -q 'DNS:rivnu-range-registration.internal' || fail 'RANGE_TLS_CSR_DNS_INVALID'
openssl pkey -in "$work/tls.key" -pubout >"$work/key-public.pem"
openssl req -in "$work/request.pem" -pubkey -noout >"$work/csr-public.pem"
cmp -s "$work/key-public.pem" "$work/csr-public.pem" || fail 'RANGE_TLS_KEY_CSR_MISMATCH'

install -o root -g "$service_gid" -m 0440 "$work/tls.key" "$key"
install -o root -g root -m 0444 "$work/request.pem" "$csr"
[[ "$(stat -c '%u:%g:%a' "$key")" == "0:$service_gid:440" ]] || fail 'RANGE_TLS_KEY_PERMISSIONS_INVALID'
[[ "$(stat -c '%u:%g:%a' "$csr")" == '0:0:444' ]] || fail 'RANGE_TLS_CSR_PERMISSIONS_INVALID'

printf '%s\n' 'RIVNU_FISCAL_RANGE_TLS_CSR_CREATED_NOT_ACTIVATED'
printf 'Public CSR: %s\n' "$csr"
printf '%s\n' 'The private key remains on VM4; no service, database, invoice or DGII endpoint was changed.'

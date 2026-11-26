#!/usr/bin/env bash
# Sign the public range-service CSR on the internal CA custodian (VM3).
set -Eeuo pipefail
set +x
umask 077

readonly ca='/var/lib/corestack-pki/internal-root-2026'
readonly output='/usr/local/share/corestack-pki/rivnu-range-registration-2026.crt'
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly source_csr=${1:-}

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ $# == 1 && -f "$source_csr" && ! -L "$source_csr" && $(stat -c %s -- "$source_csr") -le 16384 ]] || fail 'SUPPLY_PUBLIC_RANGE_CSR'
[[ ! -e "$output" && ! -L "$output" ]] || fail 'RANGE_TLS_CERTIFICATE_EXISTS_REVIEW_REQUIRED'
[[ -f "$ca/ca.crt.pem" && -f "$ca/private/ca.key.pem" ]] || fail 'INTERNAL_CA_MATERIAL_MISSING'
[[ "$(stat -c '%u:%g:%a' "$ca/private/ca.key.pem")" == '0:0:400' ]] || fail 'INTERNAL_CA_KEY_PERMISSIONS_INVALID'
[[ "$(openssl x509 -in "$ca/ca.crt.pem" -noout -fingerprint -sha256 | cut -d= -f2)" == "$expected_ca" ]] || fail 'INTERNAL_CA_PIN_MISMATCH'
openssl x509 -in "$ca/ca.crt.pem" -noout -checkend 31622400 || fail 'INTERNAL_CA_RENEWAL_REQUIRED'

work=$(mktemp -d /var/lib/corestack-pki/rivnu-range-issue.XXXXXX)
cleanup() {
  rm -f -- "$work/request.pem" "$work/extensions.cnf" "$work/server.crt"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
install -o root -g root -m 0400 "$source_csr" "$work/request.pem"
openssl req -in "$work/request.pem" -verify -noout >/dev/null
[[ "$(openssl req -in "$work/request.pem" -noout -subject -nameopt RFC2253)" == 'subject=CN=CoreStack Fiscal Range Registration RIVNU' ]] || fail 'RANGE_TLS_CSR_SUBJECT_INVALID'
openssl req -in "$work/request.pem" -noout -text | grep -q 'IP Address:10.0.0.1' || fail 'RANGE_TLS_CSR_IP_INVALID'
openssl req -in "$work/request.pem" -noout -text | grep -q 'DNS:rivnu-range-registration.internal' || fail 'RANGE_TLS_CSR_DNS_INVALID'

printf '%s\n' \
  '[server]' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  'subjectAltName=IP:10.0.0.1,DNS:rivnu-range-registration.internal' \
  'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid,issuer' >"$work/extensions.cnf"

printf '%s\n' 'Enter the internal CA passphrase at the OpenSSL prompt; never send it through chat.'
openssl x509 -req -in "$work/request.pem" \
  -CA "$ca/ca.crt.pem" -CAkey "$ca/private/ca.key.pem" \
  -set_serial "0x$(openssl rand -hex 16)" -days 365 -sha256 \
  -extfile "$work/extensions.cnf" -extensions server -out "$work/server.crt"
openssl verify -CAfile "$ca/ca.crt.pem" -purpose sslserver -verify_ip 10.0.0.1 "$work/server.crt" >/dev/null
openssl verify -CAfile "$ca/ca.crt.pem" -purpose sslserver -verify_hostname rivnu-range-registration.internal "$work/server.crt" >/dev/null
install -o root -g root -m 0444 "$work/server.crt" "$output"

openssl x509 -in "$output" -noout -subject -issuer -dates -fingerprint -sha256
printf 'RIVNU_FISCAL_RANGE_TLS_CERTIFICATE_ISSUED_NOT_ACTIVATED: %s\n' "$output"
printf '%s\n' 'No PostgreSQL role, firewall, ERP, container, invoice or DGII endpoint was changed.'

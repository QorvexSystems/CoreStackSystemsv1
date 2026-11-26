#!/usr/bin/env bash
# Install the signed public leaf after CA, identity and private-key verification.
set -Eeuo pipefail
set +x
umask 077

readonly ca='/opt/corestack/fe/config/internal-root-2026.crt'
readonly key='/opt/corestack/secrets/rivnu-range-registration/tls.key'
readonly target='/opt/corestack/fe/config/rivnu-range-registration.crt'
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly source_certificate=${1:-}

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# == 1 && -f "$source_certificate" && ! -L "$source_certificate" && $(stat -c %s -- "$source_certificate") -le 16384 ]] || fail 'SUPPLY_SIGNED_RANGE_CERTIFICATE'
[[ -f "$ca" && ! -L "$ca" && "$(openssl x509 -in "$ca" -noout -fingerprint -sha256 | cut -d= -f2)" == "$expected_ca" ]] || fail 'INTERNAL_CA_PIN_MISMATCH'
[[ -f "$key" && ! -L "$key" && "$(stat -c '%u:%g:%a' "$key")" == '0:4101:440' ]] || fail 'RANGE_TLS_KEY_INVALID'
[[ ! -e "$target" && ! -L "$target" ]] || fail 'RANGE_TLS_CERTIFICATE_EXISTS_REVIEW_REQUIRED'

work=$(mktemp -d /opt/corestack/secrets/.rivnu-range-certificate.XXXXXX)
cleanup() {
  rm -f -- "$work/server.crt" "$work/cert-public.pem" "$work/key-public.pem"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
install -o root -g root -m 0400 "$source_certificate" "$work/server.crt"
openssl verify -CAfile "$ca" -purpose sslserver -verify_ip 10.0.0.1 "$work/server.crt" >/dev/null
openssl verify -CAfile "$ca" -purpose sslserver -verify_hostname rivnu-range-registration.internal "$work/server.crt" >/dev/null
[[ "$(openssl x509 -in "$work/server.crt" -noout -subject -nameopt RFC2253)" == 'subject=CN=CoreStack Fiscal Range Registration RIVNU' ]] || fail 'RANGE_TLS_CERTIFICATE_SUBJECT_INVALID'
openssl x509 -in "$work/server.crt" -noout -checkend 2592000 || fail 'RANGE_TLS_CERTIFICATE_EXPIRING'
openssl x509 -in "$work/server.crt" -pubkey -noout >"$work/cert-public.pem"
openssl pkey -in "$key" -pubout >"$work/key-public.pem"
cmp -s "$work/cert-public.pem" "$work/key-public.pem" || fail 'RANGE_TLS_CERTIFICATE_KEY_MISMATCH'

install -o root -g root -m 0444 "$work/server.crt" "$target"
[[ "$(stat -c '%u:%g:%a' "$target")" == '0:0:444' ]] || fail 'RANGE_TLS_CERTIFICATE_PERMISSIONS_INVALID'

openssl x509 -in "$target" -noout -subject -issuer -dates -fingerprint -sha256
printf '%s\n' 'RIVNU_FISCAL_RANGE_TLS_CERTIFICATE_INSTALLED_NOT_ACTIVATED'
printf '%s\n' 'No service, database, invoice, queue or DGII endpoint was changed.'

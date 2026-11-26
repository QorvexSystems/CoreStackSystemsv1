#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly source=/home/luismel/rivnu-auth-case-alias-20261020/rivnu-fiscal-receiver.locations.conf
readonly target=/etc/nginx/snippets/rivnu-fiscal-receiver.locations.conf
readonly expected_previous_sha256=0c34dfbcc452cafc04462c3b72bdfe9cfd290fd53c79f9ecb2031bc85ac1316e
readonly expected_source_sha256=c406c1762eef3b365bc6c885b27c20df7c0ff15c04f467e1fd4f2f7bebfe7dee

fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail RUN_WITH_SUDO_ON_VM1
ip -4 addr show | grep -q '10\.0\.0\.2/' || fail VM1_PRIVATE_IP_NOT_PRESENT
[[ -f "$source" && ! -L "$source" ]] || fail ROUTE_SOURCE_MISSING
[[ -f "$target" && ! -L "$target" ]] || fail INSTALLED_ROUTE_FILE_MISSING
[[ "$(hash_of "$source")" == "$expected_source_sha256" ]] || fail ROUTE_SOURCE_HASH_MISMATCH
[[ "$(hash_of "$target")" == "$expected_previous_sha256" ]] || fail INSTALLED_ROUTE_CHANGED_REVIEW_REQUIRED
[[ "$(grep -Fc 'location = /fe/autenticacion/api/validacionCertificado {' "$source")" == 1 ]] ||
  fail EXACT_ALIAS_COUNT_INVALID

readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup=/opt/corestack/backups/nginx/$timestamp-before-rivnu-auth-case-alias
install -d -o root -g root -m 0750 "$backup"
install -o root -g root -m 0444 "$target" "$backup/rivnu-fiscal-receiver.locations.conf"

rollback() {
  code=$?
  trap - ERR
  install -o root -g root -m 0444 "$backup/rivnu-fiscal-receiver.locations.conf" "$target" || true
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  printf 'RIVNU_AUTH_CASE_ALIAS_UPDATE_ROLLED_BACK backup=%s\n' "$backup" >&2
  exit "$code"
}
trap rollback ERR

readonly candidate="$(mktemp /etc/nginx/snippets/.rivnu-fiscal-receiver.locations.XXXXXX)"
install -o root -g root -m 0444 "$source" "$candidate"
mv -f -- "$candidate" "$target"
nginx -t
systemctl reload nginx

readonly status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --connect-timeout 5 --request POST \
  https://rivnu.corestack-systems.com/fe/autenticacion/api/validacionCertificado)"
[[ "$status" == 400 ]] || fail EXACT_ALIAS_ROUTE_UNEXPECTED_STATUS
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://rivnu.corestack-systems.com/fe/internal/v1/analyze)" == 404 ]] || fail INTERNAL_ROUTE_EXPOSED

trap - ERR
printf 'RIVNU_VM1_EXACT_AUTH_CASE_ALIAS_INSTALLED backup=%s\n' "$backup"

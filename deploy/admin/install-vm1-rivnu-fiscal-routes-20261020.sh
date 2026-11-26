#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly source=/home/luismel/rivnu-fiscal-routes-deploy-20261020
readonly site=/etc/nginx/sites-available/rivnu-production.conf
readonly locations=/etc/nginx/snippets/rivnu-fiscal-receiver.locations.conf
readonly proxy=/etc/nginx/snippets/rivnu-fiscal-receiver-proxy.conf
readonly trust=/etc/nginx/trust/fiscal-receiver-tls.crt
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail RUN_WITH_SUDO_ON_VM1
ip -4 addr show | grep -q '10\.0\.0\.2/' || fail VM1_PRIVATE_IP_NOT_PRESENT
command -v nginx >/dev/null || fail NGINX_NOT_INSTALLED
[[ -f "$site" && ! -L "$site" ]] || fail RIVNU_NGINX_SITE_NOT_FOUND
for file in rivnu-fiscal-receiver.locations.conf rivnu-fiscal-receiver-proxy.conf fiscal-receiver-tls.crt; do
  [[ -f "$source/$file" && ! -L "$source/$file" ]] || fail "SOURCE_MISSING_$file"
done
for path in "$locations" "$proxy" "$trust"; do [[ ! -e "$path" && ! -L "$path" ]] || fail FISCAL_ROUTE_ALREADY_INSTALLED_REVIEW_REQUIRED; done
openssl x509 -in "$source/fiscal-receiver-tls.crt" -noout -checkend 0 >/dev/null || fail RECEIVER_TLS_CERTIFICATE_INVALID
openssl x509 -in "$source/fiscal-receiver-tls.crt" -noout -ext subjectAltName | grep -q 'DNS:rivnu-fiscal-receiver.internal' || fail RECEIVER_TLS_NAME_INVALID

backup=/opt/corestack/backups/nginx/"$(date -u +%Y%m%dT%H%M%SZ)-before-rivnu-fiscal-routes"
install -d -o root -g root -m 0750 "$backup" /etc/nginx/snippets /etc/nginx/trust
cp -a "$site" "$backup/rivnu-production.conf"
candidate="$(mktemp /etc/nginx/sites-available/.rivnu-production.XXXXXX)"
trap 'rm -f -- "$candidate"' EXIT
awk '
  /server_name rivnu\.corestack-systems\.com;/ { target=1 }
  target && !done && /client_max_body_size 20M;/ {
    print
    print "    include /etc/nginx/snippets/rivnu-fiscal-receiver.locations.conf;"
    done=1
    next
  }
  { print }
  END { if (!done) exit 42 }
' "$site" > "$candidate" || fail NGINX_INSERTION_POINT_NOT_FOUND
[[ "$(grep -c 'rivnu-fiscal-receiver.locations.conf' "$candidate")" == 1 ]] || fail NGINX_INCLUDE_COUNT_INVALID
install -o root -g root -m 0444 "$source/rivnu-fiscal-receiver.locations.conf" "$locations"
install -o root -g root -m 0444 "$source/rivnu-fiscal-receiver-proxy.conf" "$proxy"
install -o root -g root -m 0444 "$source/fiscal-receiver-tls.crt" "$trust"
install -o root -g root -m 0644 "$candidate" "$site"
rollback() {
  trap - ERR
  cp -a "$backup/rivnu-production.conf" "$site"
  rm -f -- "$locations" "$proxy" "$trust"
  nginx -t && systemctl reload nginx
}
trap 'printf "VM1_ROUTE_INSTALL_FAILED_ROLLING_BACK\n" >&2; rollback' ERR
nginx -t
curl --silent --show-error --fail --cacert "$trust" --resolve rivnu-fiscal-receiver.internal:8444:10.0.0.1 \
  https://rivnu-fiscal-receiver.internal:8444/health/live >/dev/null
systemctl reload nginx
curl --silent --show-error --fail https://rivnu.corestack-systems.com/fe/autenticacion/api/semilla | grep -q '<SemillaModel>'
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' https://rivnu.corestack-systems.com/fe/internal/v1/analyze)" == 404 ]] || fail INTERNAL_ROUTE_EXPOSED
trap - ERR EXIT
rm -f -- "$candidate"
printf 'RIVNU_VM1_EXACT_FISCAL_ROUTES_INSTALLED backup=%s\n' "$backup"


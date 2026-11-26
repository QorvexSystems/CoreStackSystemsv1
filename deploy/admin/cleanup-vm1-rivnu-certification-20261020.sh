#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly home_root=/home/luismel
readonly archive=/opt/corestack/backups/rivnu-certification-gateway-complete-20261020
readonly site=/etc/nginx/sites-available/rivnu-production.conf
readonly locations=/etc/nginx/snippets/rivnu-fiscal-receiver.locations.conf
readonly proxy=/etc/nginx/snippets/rivnu-fiscal-receiver-proxy.conf
readonly tls_cert=/etc/nginx/trust/fiscal-receiver-tls.crt
readonly expected_locations_sha=c406c1762eef3b365bc6c885b27c20df7c0ff15c04f467e1fd4f2f7bebfe7dee
readonly expected_proxy_sha=77fa03860391869e5dd7ef870401a36bba5ec35d5d0998670eb01c760d5d7a18
readonly expected_tls_sha=1592a2be4441f8f407b5cda3c7fcc232a2fd5e61ed237870ccf1cf563917a799

fail() { printf '%s\n' "$1" >&2; exit 1; }
file_sha() { sha256sum "$1" | awk '{print $1}'; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStack-VM1-Gateway ]] ||
  fail RUN_WITH_SUDO_ON_VM1
[[ ! -e "$archive" && ! -L "$archive" ]] || fail CLEANUP_ARCHIVE_ALREADY_EXISTS
[[ -f "$site" && ! -L "$site" ]] || fail ACTIVE_SITE_MISSING
[[ -f "$locations" && ! -L "$locations" ]] || fail ACTIVE_LOCATIONS_MISSING
[[ -f "$proxy" && ! -L "$proxy" ]] || fail ACTIVE_PROXY_MISSING
[[ -f "$tls_cert" && ! -L "$tls_cert" ]] || fail ACTIVE_TLS_CERTIFICATE_MISSING
[[ "$(file_sha "$locations")" == "$expected_locations_sha" ]] || fail ACTIVE_LOCATIONS_HASH_UNEXPECTED
[[ "$(file_sha "$proxy")" == "$expected_proxy_sha" ]] || fail ACTIVE_PROXY_HASH_UNEXPECTED
[[ "$(file_sha "$tls_cert")" == "$expected_tls_sha" ]] || fail ACTIVE_TLS_HASH_UNEXPECTED

systemctl is-active --quiet nginx || fail NGINX_NOT_ACTIVE
nginx -t || fail NGINX_CONFIGURATION_INVALID
curl --fail --silent --show-error --connect-timeout 5 \
  --noproxy '*' \
  --cacert "$tls_cert" \
  --resolve rivnu-fiscal-receiver.internal:8444:10.0.0.1 \
  https://rivnu-fiscal-receiver.internal:8444/health/live >/dev/null ||
  fail VM4_FISCAL_RECEIVER_UNREACHABLE

readonly temporary_names=(
  rivnu-auth-case-alias-20261020
  rivnu-auth-case-alias-20261020.tar.gz
  rivnu-fiscal-routes-deploy-20261020
)

for name in "${temporary_names[@]}"; do
  path="$home_root/$name"
  [[ -e "$path" && ! -L "$path" ]] || fail "TEMPORARY_ARTIFACT_MISSING_$name"
done

install -d -o root -g root -m 0700 "$archive" "$archive/active-nginx"
install -o root -g root -m 0600 "$site" "$archive/active-nginx/rivnu-production.conf"
install -o root -g root -m 0600 "$locations" "$archive/active-nginx/rivnu-fiscal-receiver.locations.conf"
install -o root -g root -m 0600 "$proxy" "$archive/active-nginx/rivnu-fiscal-receiver-proxy.conf"
install -o root -g root -m 0600 "$tls_cert" "$archive/active-nginx/fiscal-receiver-tls.crt"

{
  printf 'hostname=%s\n' "$(hostname)"
  printf 'completed_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'nginx_state=%s\n' "$(systemctl is-active nginx)"
  printf 'preserved_home_path=%s\n' "$home_root/corestack-rivnu-admin"
} > "$archive/MANIFEST.txt"
chmod 0600 "$archive/MANIFEST.txt"

(
  cd "$archive"
  find active-nginx -type f -print0 | sort -z | xargs -0 sha256sum
) > "$archive/SHA256SUMS"
chmod 0600 "$archive/SHA256SUMS"

for name in "${temporary_names[@]}"; do
  path="$home_root/$name"
  if [[ -d "$path" ]]; then
    rm -rf -- "$path"
  else
    rm -f -- "$path"
  fi
done

for name in "${temporary_names[@]}"; do
  [[ ! -e "$home_root/$name" && ! -L "$home_root/$name" ]] || fail "TEMPORARY_ARTIFACT_REMAINS_$name"
done
[[ -d "$home_root/corestack-rivnu-admin" && ! -L "$home_root/corestack-rivnu-admin" ]] ||
  fail PRESERVED_ADMIN_DIRECTORY_CHANGED
[[ "$(file_sha "$locations")" == "$expected_locations_sha" ]] || fail ACTIVE_LOCATIONS_CHANGED
[[ "$(file_sha "$proxy")" == "$expected_proxy_sha" ]] || fail ACTIVE_PROXY_CHANGED
[[ "$(file_sha "$tls_cert")" == "$expected_tls_sha" ]] || fail ACTIVE_TLS_CHANGED

nginx -t || fail NGINX_CONFIGURATION_INVALID_AFTER_CLEANUP
systemctl is-active --quiet nginx || fail NGINX_NOT_ACTIVE_AFTER_CLEANUP
curl --fail --silent --show-error --connect-timeout 5 \
  --noproxy '*' \
  --cacert "$tls_cert" \
  --resolve rivnu-fiscal-receiver.internal:8444:10.0.0.1 \
  https://rivnu-fiscal-receiver.internal:8444/health/live >/dev/null ||
  fail VM4_FISCAL_RECEIVER_UNREACHABLE_AFTER_CLEANUP

printf 'RIVNU_VM1_CERTIFICATION_CLEANUP_COMPLETE archive=%s\n' "$archive"
du -sh "$archive"
df -h /

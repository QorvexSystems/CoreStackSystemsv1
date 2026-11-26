#!/usr/bin/env bash
# Operator-run initial TLS activation, or guarded rollback. No HBA/role changes.
set +x
set -euo pipefail
umask 077
ulimit -c 0
readonly config='/etc/postgresql/17/main/postgresql.conf'
readonly pki='/var/lib/corestack-pki'
readonly backup="$pki/postgresql-tls-activation-2026"
readonly bundle="$pki/issued/vm3-postgresql-2026"
readonly tls='/etc/corestack-postgresql-tls-2026'
readonly ca='/usr/local/share/corestack-pki/internal-root-2026.crt'
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly expected_leaf='A5:31:CD:3B:F7:65:58:7B:7D:9E:6E:6A:CE:DD:16:84:CF:6F:EC:01:16:5F:4A:AA:B5:68:FF:4E:C9:4B:C4:EB'
readonly expected_old='72:5C:21:D0:15:C2:A3:ED:EB:6D:7D:72:24:8C:79:E0:D6:9F:79:3C:24:1E:90:6E:84:97:F2:45:49:71:58:F0'
fail() { printf '%s\n' "$*" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d ' ' -f 1; }
fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d = -f 2; }
pg_read() {
  sudo -u postgres env PGOPTIONS='-c statement_timeout=10000' psql -X --no-password \
    -h /var/run/postgresql -p 5432 -d postgres -v ON_ERROR_STOP=1 -Atqc "$1"
}
[[ "$EUID" -eq 0 && "$(hostname)" == VM3-SQLDB ]] || fail 'Run with sudo on VM3-SQLDB.'
[[ $# -eq 1 && ( "$1" == activate || "$1" == rollback ) ]] || fail 'Usage: script activate|rollback'
for cmd in openssl timeout flock sha256sum sudo psql install; do command -v "$cmd" >/dev/null; done
[[ ! -L "$pki" && "$(stat -c '%u:%g:%a' "$pki")" == 0:0:700 ]] || fail 'Unsafe PKI directory.'
[[ ! -L "$pki/.activation.lock" ]] || fail 'Unsafe lock.'
exec 9>"$pki/.activation.lock"
flock -n 9 || fail 'Another activation/rollback is running.'
[[ ! -L "$config" && -f "$config" ]] || fail 'Unexpected configuration path.'
[[ "$(pg_read 'SHOW config_file')" == "$config" ]] || fail 'Unexpected PostgreSQL cluster.'
[[ "$(pg_read 'SHOW server_version_num')" == 17* ]] || fail 'Expected PostgreSQL 17.'

# Connect locally but verify the actual production identity in the certificate.
probe() {
  local expected="$1" strict="$2"
  local options=()
  if [[ "$strict" == yes ]]; then options=(-CAfile "$ca" -verify_return_error -verify_ip 10.0.0.4); fi
  timeout 4 openssl s_client -starttls postgres -connect 127.0.0.1:5432 \
    -showcerts "${options[@]}" </dev/null > "$backup/handshake.pem" 2> "$backup/handshake.log" || return 1
  [[ "$(fingerprint "$backup/handshake.pem")" == "$expected" ]]
}
wait_for_certificate() {
  local attempt
  for attempt in {1..10}; do
    if probe "$1" "$2"; then return 0; fi
    sleep 1
  done
  return 1
}
restore_original() {
  [[ "$(hash_file "$config")" == "$(< "$backup/activated.sha256")" ]] || {
    echo 'Configuration changed after activation; refusing to overwrite. Manual review required.' >&2; return 1;
  }
  [[ "$(hash_file "$backup/postgresql.conf.original")" == "$(< "$backup/original.sha256")" ]] || return 1
  local restore_stage
  restore_stage=$(mktemp /etc/postgresql/17/main/.corestack-tls-restore.XXXXXX) || return 1
  cp --preserve=mode,ownership,timestamps "$backup/postgresql.conf.original" "$restore_stage" || return 1
  mv -T "$restore_stage" "$config" || return 1
  [[ "$(pg_read 'SELECT pg_reload_conf()')" == t ]] || return 1
  wait_for_certificate "$expected_old" no || return 1
  printf 'TLS_ROLLED_BACK: original configuration and served certificate restored.\n'
}
if [[ "$1" == rollback ]]; then
  [[ ! -L "$backup" && -d "$backup" && "$(stat -c '%u:%g:%a' "$backup")" == 0:0:700 ]] || fail 'Missing/unsafe activation backup.'
  restore_original || fail 'Rollback incomplete; review before any restart.'
  exit 0
fi

[[ ! -e "$backup" && ! -L "$backup" && ! -e "$tls" && ! -L "$tls" ]] || fail 'Activation paths already exist. No overwrite; inspect previous execution.'
[[ "$(pg_read "SELECT count(*) FROM pg_file_settings WHERE error IS NOT NULL")" == 0 ]] || fail 'Existing configuration errors.'
[[ "$(pg_read 'SHOW ssl')" == on ]] || fail 'TLS must already be enabled.'
[[ "$(pg_read 'SHOW ssl_cert_file')" == /etc/ssl/certs/ssl-cert-snakeoil.pem ]] || fail 'Certificate configuration changed since audit.'
[[ "$(pg_read 'SHOW ssl_key_file')" == /etc/ssl/private/ssl-cert-snakeoil.key ]] || fail 'Key configuration changed since audit.'
[[ "$(fingerprint /etc/ssl/certs/ssl-cert-snakeoil.pem)" == "$expected_old" ]] || fail 'Previous certificate changed.'
[[ "$(fingerprint "$ca")" == "$expected_ca" && "$(fingerprint "$bundle/server.crt.pem")" == "$expected_leaf" ]] || fail 'Unexpected CA/server certificate.'
[[ ! -L "$bundle" && "$(stat -c '%u:%g:%a' "$bundle")" == 0:0:700 ]] || fail 'Unsafe server bundle.'
[[ ! -L "$bundle/server.key.pem" && "$(stat -c '%u:%g:%a' "$bundle/server.key.pem")" == 0:0:400 ]] || fail 'Unsafe server key.'
openssl verify -CAfile "$ca" -purpose sslserver -verify_ip 10.0.0.4 "$bundle/server.crt.pem"
openssl x509 -in "$bundle/server.crt.pem" -checkend 5184000 -noout
mkdir -m 0700 "$backup"
changed=no
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$result" -ne 0 ]]; then
    if [[ "$changed" == yes ]]; then
      restore_original || echo 'AUTOMATIC ROLLBACK INCOMPLETE: inspect configuration before restarting PostgreSQL.' >&2
    fi
    printf 'Failure; protected backup/staging retained at %s. Do not rerun blindly.\n' "$backup" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp --preserve=mode,ownership,timestamps "$config" "$backup/postgresql.conf.original"
hash_file "$backup/postgresql.conf.original" > "$backup/original.sha256"
probe "$expected_old" no || fail 'Served certificate differs from audited certificate.'
openssl pkey -in "$bundle/server.key.pem" -pubout -out "$backup/key-public.pem"
openssl x509 -in "$bundle/server.crt.pem" -pubkey -noout > "$backup/cert-public.pem"
cmp "$backup/key-public.pem" "$backup/cert-public.pem"
install -d -o root -g postgres -m 0750 "$tls"
install -o root -g postgres -m 0640 "$bundle/server.key.pem" "$tls/server.key.pem"
install -o root -g postgres -m 0644 "$bundle/server.crt.pem" "$tls/server.crt.pem"
sudo -u postgres test -r "$tls/server.key.pem"
config_stage=$(mktemp /etc/postgresql/17/main/.corestack-tls-activate.XXXXXX)
cp --preserve=mode,ownership,timestamps "$backup/postgresql.conf.original" "$config_stage"
printf '\n# CoreStack initial TLS activation 2026; rollback via protected backup.\nssl_cert_file = '\''%s/server.crt.pem'\''\nssl_key_file = '\''%s/server.key.pem'\''\n' "$tls" "$tls" >> "$config_stage"
hash_file "$config_stage" > "$backup/activated.sha256"
[[ "$(hash_file "$config")" == "$(< "$backup/original.sha256")" ]] || fail 'Configuration changed during preparation.'
mv -T "$config_stage" "$config"
changed=yes
[[ "$(pg_read "SELECT count(*) FROM pg_file_settings WHERE error IS NOT NULL")" == 0 ]] || fail 'New configuration failed parsing.'
[[ "$(pg_read "SELECT setting FROM pg_file_settings WHERE name='ssl_cert_file' AND applied")" == "$tls/server.crt.pem" ]] || fail 'Another source overrides certificate path.'
[[ "$(pg_read "SELECT setting FROM pg_file_settings WHERE name='ssl_key_file' AND applied")" == "$tls/server.key.pem" ]] || fail 'Another source overrides key path.'
[[ "$(pg_read 'SELECT pg_reload_conf()')" == t ]] || fail 'Reload request failed.'
wait_for_certificate "$expected_leaf" yes || fail 'New verified TLS certificate not served.'
[[ "$(pg_read 'SHOW ssl_cert_file')" == "$tls/server.crt.pem" ]] || fail 'Active certificate path mismatch.'
printf '\nTLS_ACTIVATED_LOCAL_VERIFIED\nBackup: %s\n' "$backup"
printf 'No restart, HBA, roles, databases or ERP settings changed. VM4 and ERP fresh-connection tests still required.\n'

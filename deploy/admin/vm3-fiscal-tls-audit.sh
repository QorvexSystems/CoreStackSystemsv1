#!/usr/bin/env bash
# Read-only TLS audit on VM3, run personally by the administrator.
# Never prints private keys, credentials, connection strings or application data.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  echo 'Run with sudo on VM3.' >&2
  exit 1
fi
pg_read() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d postgres -v ON_ERROR_STOP=1 "$@"
}
hostname
pg_lsclusters
pg_read -P pager=off -c "SELECT name, setting, pending_restart FROM pg_settings WHERE name IN
  ('server_version','port','listen_addresses','ssl','ssl_cert_file','ssl_key_file',
   'ssl_ca_file','ssl_min_protocol_version','ssl_max_protocol_version') ORDER BY name;"

data_dir="$(pg_read -Atqc 'SHOW data_directory;')"
cert_file="$(pg_read -Atqc 'SHOW ssl_cert_file;')"
key_file="$(pg_read -Atqc 'SHOW ssl_key_file;')"
if [[ -z "$cert_file" || -z "$key_file" || "$data_dir" != /* ]]; then
  echo 'Missing or unexpected TLS paths; no files changed.' >&2
  exit 1
fi
[[ "$cert_file" == /* ]] || cert_file="$data_dir/$cert_file"
[[ "$key_file" == /* ]] || key_file="$data_dir/$key_file"
cert_file="$(realpath -e -- "$cert_file")"
key_file="$(realpath -e -- "$key_file")"
printf '\nCertificate and key metadata only (key contents never read):\n'
stat -c '%A %U:%G %n' -- "$cert_file" "$key_file"
printf '\nPublic certificate identity and fingerprint:\n'
openssl x509 -in "$cert_file" -noout -subject -issuer -dates -fingerprint -sha256 \
  -ext subjectAltName,basicConstraints,keyUsage,extendedKeyUsage
printf '\nCertificate identity checks (not trust-chain verification):\n'
openssl x509 -in "$cert_file" -noout -checkip 10.0.0.4 || true
openssl x509 -in "$cert_file" -noout -checkhost VM3-SQLDB || true
printf '\nHBA rules (no passwords or options):\n'
pg_read -P pager=off -c 'SELECT rule_number,type,database,user_name,address,netmask,auth_method,error FROM pg_hba_file_rules ORDER BY rule_number;'
printf '\nRead-only audit complete. No reload, restart, certificates or permissions changed.\n'

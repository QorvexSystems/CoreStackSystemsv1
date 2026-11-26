#!/usr/bin/env bash
# Read-only inventory before changing shared PostgreSQL TLS configuration.
# Run personally with sudo; no key contents, passwords or SQL query texts printed.
set +x
set -euo pipefail
[[ "$EUID" -eq 0 && "$(hostname)" == VM3-SQLDB ]] || {
  echo 'Run with sudo on VM3-SQLDB.' >&2; exit 1;
}
pg_read() {
  sudo -u postgres env PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000' \
    psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres \
    -v ON_ERROR_STOP=1 -P pager=off "$@"
}
printf 'Active settings and source locations (no configuration file dump):\n'
pg_read -c "SELECT name,setting,source,sourcefile,sourceline,pending_restart
 FROM pg_settings WHERE name IN ('config_file','hba_file','data_directory',
 'ssl','ssl_cert_file','ssl_key_file','ssl_ca_file','ssl_passphrase_command_supports_reload')
 ORDER BY name;"
printf '\nParsed TLS entries and configuration error count:\n'
pg_read -c "SELECT sourcefile,sourceline,seqno,name,setting,applied,(error IS NOT NULL) AS has_error
 FROM pg_file_settings WHERE name IN ('ssl','ssl_cert_file','ssl_key_file','ssl_ca_file') ORDER BY seqno;"
pg_read -c 'SELECT count(*) AS configuration_errors FROM pg_file_settings WHERE error IS NOT NULL;'
printf '\nCurrent remote clients (snapshot only, not a complete consumer inventory):\n'
pg_read -c "SELECT a.datname,a.usename,a.client_addr,s.ssl,s.version,count(*) AS connections
 FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s USING(pid)
 WHERE a.client_addr IS NOT NULL
 GROUP BY a.datname,a.usename,a.client_addr,s.ssl,s.version
 ORDER BY a.datname,a.usename,a.client_addr;"
printf '\nHBA rules, without options or credentials:\n'
pg_read -c 'SELECT rule_number,type,database,user_name,address,netmask,auth_method,(error IS NOT NULL) AS has_error FROM pg_hba_file_rules ORDER BY rule_number;'
printf '\nExisting database and non-system role inventory (no password hashes):\n'
pg_read -c "SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE NOT datistemplate ORDER BY datname;"
pg_read -c "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;"
printf '\nNew server bundle metadata only:\n'
stat -c '%U:%G %a %n' /var/lib/corestack-pki/issued/vm3-postgresql-2026 \
  /var/lib/corestack-pki/issued/vm3-postgresql-2026/server.key.pem \
  /var/lib/corestack-pki/issued/vm3-postgresql-2026/server.crt.pem
openssl verify -CAfile /usr/local/share/corestack-pki/internal-root-2026.crt \
  -purpose sslserver -verify_ip 10.0.0.4 \
  /usr/local/share/corestack-pki/vm3-postgresql-2026.crt
printf '\nAUDIT_COMPLETE_NO_CHANGES\n'

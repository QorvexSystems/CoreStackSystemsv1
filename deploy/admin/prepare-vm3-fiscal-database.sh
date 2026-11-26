#!/usr/bin/env bash
# Run personally with sudo. Initial, locked-down precertification database only.
set +x
set -euo pipefail
umask 077
readonly pki=/var/lib/corestack-pki
readonly backup="$pki/fiscal-db-bootstrap-2026"
readonly hba=/etc/postgresql/17/main/pg_hba.conf
readonly expected_sql='b59a6c7607dfae3d87458566d39767a5c9758f5b141fe76fe6e6f1e9edde006d'
fail() { printf '%s\n' "$*" >&2; exit 1; }
hash_file() { sha256sum "$1" | cut -d ' ' -f 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres -v ON_ERROR_STOP=1 "$@"; }
[[ "$EUID" -eq 0 && "$(hostname)" == VM3-SQLDB ]] || fail 'Run with sudo on VM3-SQLDB.'
[[ ! -L "$pki" && "$(stat -c '%u:%g:%a' "$pki")" == 0:0:700 ]] || fail 'Unsafe PKI directory.'
[[ ! -L "$pki/.fiscal-bootstrap.lock" ]] || fail 'Unsafe lock.'
exec 9>"$pki/.fiscal-bootstrap.lock"
flock -n 9 || fail 'Another bootstrap is running.'
[[ ! -e "$backup" && ! -L "$backup" ]] || fail 'Bootstrap already attempted; inspect retained state. No overwrite.'
[[ ! -L "$hba" && -f "$hba" && "$(pg -Atqc 'SHOW hba_file')" == "$hba" ]] || fail 'Unexpected HBA path.'
[[ "$(pg -Atqc 'SHOW server_version_num')" == 17* ]] || fail 'Expected PostgreSQL 17.'
[[ "$(pg -Atqc 'SHOW ssl')" == on && "$(pg -Atqc 'SHOW ssl_cert_file')" == /etc/corestack-postgresql-tls-2026/server.crt.pem ]] || fail 'Approved TLS activation required.'
[[ "$(pg -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] || fail 'Existing HBA errors.'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_database WHERE datname='rivnu_fiscal_pre'")" == 0 ]] || fail 'Database already exists.'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('rivnu_fe_pre_owner','rivnu_fe_pre_migrator','rivnu_fe_pre_runtime')")" == 0 ]] || fail 'Fiscal roles already exist.'
mkdir -m 0700 "$backup"
# Copy then verify the exact reviewed SQL; do not execute a changing shared file.
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
cp -- "$script_dir/bootstrap-rivnu-fiscal-pre.sql" "$backup/bootstrap.sql"
[[ "$(hash_file "$backup/bootstrap.sql")" == "$expected_sql" ]] || fail 'SQL hash mismatch.'
cp --preserve=mode,ownership,timestamps "$hba" "$backup/pg_hba.conf.original"
hash_file "$hba" > "$backup/original.sha256"
changed=no
cleanup() {
 local result=$?
 trap - EXIT
 if [[ "$result" -ne 0 ]]; then
  if [[ "$changed" == yes ]]; then
   if [[ "$(hash_file "$hba")" == "$(< "$backup/activated.sha256")" ]]; then
    local restore_stage
    restore_stage=$(mktemp /etc/postgresql/17/main/.fiscal-hba-restore.XXXXXX)
    cp --preserve=mode,ownership,timestamps "$backup/pg_hba.conf.original" "$restore_stage"
    mv -T "$restore_stage" "$hba"
    pg -Atqc 'SELECT pg_reload_conf()' || true
   else
    echo 'HBA changed concurrently; manual review required, no overwrite.' >&2
   fi
  fi
  echo 'Bootstrap incomplete. Created database/NOLOGIN roles and backup retained; do not drop or rerun blindly.' >&2
 fi
 exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pg < "$backup/bootstrap.sql"
hba_stage=$(mktemp /etc/postgresql/17/main/.fiscal-hba-activate.XXXXXX)
{
 printf '%s\n' \
  '# CoreStack RIVNU precertification: explicit isolated access, before defaults.' \
  'local rivnu_fiscal_pre postgres peer' \
  'local rivnu_fiscal_pre all reject' \
  'local all rivnu_fe_pre_runtime reject' \
  'hostssl rivnu_fiscal_pre rivnu_fe_pre_runtime 10.0.0.1/32 scram-sha-256' \
  'host all rivnu_fe_pre_runtime 0.0.0.0/0 reject' \
  'host all rivnu_fe_pre_runtime ::/0 reject' \
  'host rivnu_fiscal_pre all 0.0.0.0/0 reject' \
  'host rivnu_fiscal_pre all ::/0 reject' \
  '# End fiscal access block; existing ERP rules follow unchanged.'
 cat "$backup/pg_hba.conf.original"
} > "$hba_stage"
chmod --reference="$hba" "$hba_stage"
chown --reference="$hba" "$hba_stage"
hash_file "$hba_stage" > "$backup/activated.sha256"
[[ "$(hash_file "$hba")" == "$(< "$backup/original.sha256")" ]] || fail 'HBA changed during preparation.'
mv -T "$hba_stage" "$hba"
changed=yes
[[ "$(pg -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] || fail 'New HBA parsing errors.'
[[ "$(pg -Atqc 'SELECT pg_reload_conf()')" == t ]] || fail 'Reload request failed.'
pg -P pager=off -c "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname LIKE 'rivnu_fe_pre_%' ORDER BY rolname;"
printf '\nFISCAL_DB_PREPARED_RUNTIME_LOCKED\nBackup: %s\n' "$backup"
printf 'NOLOGIN: no passwords created, no remote authentication enabled yet. No e-NCF or ERP data changed.\n'

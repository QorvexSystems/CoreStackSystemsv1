#!/bin/sh
# Disposable postgres client on VM4 fiscal-network. Mount only public CA and
# the individual runtime password read-only; /tmp must be tmpfs. No emissions.
set +x
set -eu
umask 077
ulimit -c 0
export PGHOST=10.0.0.4 PGPORT=5432 PGUSER=rivnu_fe_pre_runtime
export PGDATABASE=rivnu_fiscal_pre PGSSLMODE=verify-full
export PGSSLROOTCERT=/run/ca.crt PGCONNECT_TIMEOUT=8
export PGOPTIONS='-c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000'
probe_dir=$(mktemp -d /tmp/fiscal-db-probe.XXXXXX)
export PGPASSFILE="$probe_dir/pgpass"
cleanup() {
  rm -f -- "$probe_dir/pgpass" "$probe_dir/stdout" "$probe_dir/stderr"
  rmdir -- "$probe_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Escape pgpass delimiters without putting the secret in arguments/environment.
{
  printf '10.0.0.4:5432:*:rivnu_fe_pre_runtime:'
  sed -e 's/\\/\\\\/g' -e 's/:/\\:/g' /run/db-password
  printf '\n'
} > "$PGPASSFILE"
chmod 0600 "$PGPASSFILE"
query() { psql -X -w -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -Atqc "$1"; }
if ! query "SELECT current_database() || '|' || current_user || '|' || host(inet_client_addr()) || '|' || ssl::text || '|' || version FROM pg_stat_ssl WHERE pid=pg_backend_pid()" > "$probe_dir/stdout" 2> "$probe_dir/stderr"; then
  echo 'FAIL: strict TLS/database authentication failed; raw diagnostics withheld.' >&2; exit 1
fi
connection=$(cat "$probe_dir/stdout")
case "$connection" in
 'rivnu_fiscal_pre|rivnu_fe_pre_runtime|10.0.0.1|true|TLSv1.3'|'rivnu_fiscal_pre|rivnu_fe_pre_runtime|10.0.0.1|true|TLSv1.2') ;;
 *) printf 'FAIL: unexpected database/user/source/TLS metadata: %s\n' "$connection" >&2; exit 1;;
esac
echo 'PASS: authenticated with verify-full from VM4; expected database/user and TLS.'
scope=$(query "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")
[ "$scope" = 'cmqn0r66a0002lit0vxbzq5l4|40220429126|precertification' ] || { echo 'FAIL: issuer scope mismatch'; exit 1; }
echo 'PASS: exact RIVNU/precertification scope.'
deny_sql() {
  label="$1"
  sql="$2"
  # If a forbidden operation unexpectedly succeeds, explicit rollback prevents
  # persistence; if it errors, psql disconnects and PostgreSQL aborts the tx.
  if query "BEGIN; $sql; ROLLBACK;" > "$probe_dir/stdout" 2> "$probe_dir/stderr"; then
    echo "FAIL: forbidden operation accepted (rolled back): $label" >&2; exit 1
  fi
  grep -q '42501' "$probe_dir/stderr" || { echo "FAIL: unexpected error for $label"; exit 1; }
  printf 'PASS: %s denied (42501).\n' "$label"
}
deny_sql schema_creation 'CREATE SCHEMA fiscal_access_probe'
deny_sql temp_table 'CREATE TEMP TABLE fiscal_access_probe(id integer)'
deny_sql public_table 'CREATE TABLE public.fiscal_access_probe(id integer)'
deny_sql scope_update "UPDATE fiscal_meta.issuer_scope SET environment='precertification' WHERE false"
deny_sql scope_delete 'DELETE FROM fiscal_meta.issuer_scope WHERE false'
deny_sql owner_escalation 'SET ROLE rivnu_fe_pre_owner'
deny_sql migrator_escalation 'SET ROLE rivnu_fe_pre_migrator'
for blocked_db in rivnu_production rivnu_rehearsal postgres; do
  if PGDATABASE="$blocked_db" query 'SELECT 1' > "$probe_dir/stdout" 2> "$probe_dir/stderr"; then
    echo 'FAIL: access to another database accepted' >&2; exit 1
  fi
  grep -q 'pg_hba.conf rejects connection' "$probe_dir/stderr" || { echo 'FAIL: unexpected cross-database rejection'; exit 1; }
  printf 'PASS: connection to %s rejected by HBA.\n' "$blocked_db"
done
if PGSSLMODE=disable query 'SELECT 1' > "$probe_dir/stdout" 2> "$probe_dir/stderr"; then
  echo 'FAIL: non-TLS connection accepted' >&2; exit 1
fi
grep -q 'pg_hba.conf rejects connection' "$probe_dir/stderr" || { echo 'FAIL: unexpected non-TLS rejection'; exit 1; }
echo 'PASS: non-TLS connection rejected by HBA.'
echo 'FISCAL_DB_ACCESS_VERIFIED_NO_FISCAL_DATA_CHANGED'

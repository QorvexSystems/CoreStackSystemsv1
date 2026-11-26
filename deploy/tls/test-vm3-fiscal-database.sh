#!/usr/bin/env bash
# Called only inside test-vm3-tls-activation.sh's disposable container.
set -euo pipefail
[[ -f /.dockerenv && "$(stat -f -c '%T' /var/lib/corestack-pki)" == tmpfs ]] || exit 1
pg() { sudo -u postgres psql -X -h /var/run/postgresql -d "${fiscal_test_db:-postgres}" -v ON_ERROR_STOP=1 -Atqc "$1"; }
pg 'CREATE DATABASE unrelated_erp;'
hba=/etc/postgresql/17/main/pg_hba.conf
cp "$hba" /tmp/hba-before
bash /work/admin/prepare-vm3-fiscal-database.sh
enable_runtime() {
 sudo -u postgres psql -X -h /var/run/postgresql -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 \
  -f /work/admin/enable-rivnu-fiscal-runtime.sql
}
if enable_runtime >/dev/null 2>/tmp/enable-denied; then echo 'FAIL: missing password accepted'; exit 1; fi
grep -q 'valid SCRAM credential' /tmp/enable-denied
[[ "$(pg "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'rivnu_fe_pre_%' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)")" == 0 ]]
[[ "$(pg "SELECT pg_has_role('rivnu_fe_pre_runtime','rivnu_fe_pre_owner','MEMBER')")" == f ]]
[[ "$(pg 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]]
[[ "$(pg "SELECT type||':'||address||':'||auth_method FROM pg_hba_file_rules WHERE rule_number=4")" == hostssl:10.0.0.1:scram-sha-256 ]]
tail -n +11 "$hba" > /tmp/hba-after-tail
cmp /tmp/hba-before /tmp/hba-after-tail
fiscal_test_db=rivnu_fiscal_pre
[[ "$(pg "SET SESSION AUTHORIZATION rivnu_fe_pre_runtime; SELECT environment FROM fiscal_meta.issuer_scope")" == precertification ]]
for forbidden in \
 'CREATE SCHEMA unauthorized' \
 'CREATE TEMP TABLE unauthorized(id integer)' \
 'CREATE TABLE public.unauthorized(id integer)' \
 'DELETE FROM fiscal_meta.issuer_scope' \
 "UPDATE fiscal_meta.issuer_scope SET environment='production'" \
 'SET ROLE rivnu_fe_pre_owner'; do
 if pg "SET SESSION AUTHORIZATION rivnu_fe_pre_runtime; $forbidden" >/dev/null 2>/tmp/denied; then
   echo "FAIL: forbidden operation accepted: $forbidden"; exit 1
 fi
 grep -q 'permission denied' /tmp/denied
done
# Owner-created functions must not silently grant runtime execution through PUBLIC.
pg 'SET ROLE rivnu_fe_pre_owner; CREATE FUNCTION fiscal_meta.denied_test() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;'
[[ "$(pg "SELECT has_function_privilege('rivnu_fe_pre_runtime','fiscal_meta.denied_test()','EXECUTE')")" == f ]]
fiscal_test_db=postgres
# Synthetic password is confined to disposable test DB. No real credential used.
pg "SET password_encryption='scram-sha-256'; ALTER ROLE rivnu_fe_pre_runtime LOGIN PASSWORD 'disposable-only';" >/dev/null
for db in unrelated_erp rivnu_fiscal_pre; do
 if PGPASSWORD=disposable-only PGSSLMODE=require psql -X -h 127.0.0.1 -U rivnu_fe_pre_runtime -d "$db" -c 'SELECT 1' >/dev/null 2>/tmp/denied; then
   echo 'FAIL: unauthorized source/database connected'; exit 1
 fi
 grep -q 'pg_hba.conf rejects connection' /tmp/denied
done
pg 'ALTER ROLE rivnu_fe_pre_runtime NOLOGIN;'
enable_runtime
[[ "$(pg "SELECT rolcanlogin FROM pg_roles WHERE rolname='rivnu_fe_pre_runtime'")" == t ]]
if enable_runtime >/dev/null 2>/tmp/enable-denied; then echo 'FAIL: repeated enable accepted'; exit 1; fi
pg 'ALTER ROLE rivnu_fe_pre_runtime NOLOGIN;'
if bash /work/admin/prepare-vm3-fiscal-database.sh; then echo 'FAIL: overwrite allowed'; exit 1; fi
echo 'PASS: isolated scope, no login/elevated roles, no DDL/DML/TEMP/function execution, HBA restrictions, original rules preserved, no overwrite.'

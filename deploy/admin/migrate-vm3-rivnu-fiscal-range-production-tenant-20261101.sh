#!/usr/bin/env bash
# Correct certification tenant scope to the real RIVNU production tenant, only while empty.
set -Eeuo pipefail
set +x
umask 077

readonly fiscal_database='rivnu_fiscal_prod'
readonly app_database='rivnu_production'
readonly owner='rivnu_fe_prod_owner'
readonly range_role='rivnu_fe_prod_range'
readonly old_tenant='cmt397emm0002nm0ogb50l2q6'
readonly new_tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly stage='/var/lib/corestack-pki/rivnu-fiscal-range-tenant-correction-20261101'

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg_fiscal() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$fiscal_database" -v ON_ERROR_STOP=1 "$@"; }
pg_app() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$app_database" -v ON_ERROR_STOP=1 "$@"; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ ! -e "$stage" && ! -L "$stage" ]] || fail 'TENANT_CORRECTION_ALREADY_ATTEMPTED_REVIEW_REQUIRED'
[[ "$(pg_app -Atqc "SELECT count(*) FROM \"Tenant\" WHERE id='$new_tenant' AND rnc='$rnc'")" == '1' ]] || fail 'PRODUCTION_TENANT_IDENTITY_INVALID'
[[ "$(pg_app -Atqc "SELECT count(*) FROM \"ElectronicFiscalRange\"")" == '0' ]] || fail 'APPLICATION_ELECTRONIC_RANGES_NOT_EMPTY'
[[ "$(pg_fiscal -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope WHERE singleton")" == "$old_tenant|$rnc|production" ]] || fail 'CURRENT_FISCAL_SCOPE_UNEXPECTED'
[[ "$(pg_fiscal -Atqc "SELECT login_role||'|'||tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.range_registration_identity")" == "$range_role|$old_tenant|$rnc|production" ]] || fail 'CURRENT_RANGE_IDENTITY_UNEXPECTED'
[[ "$(pg_fiscal -Atqc 'SELECT (SELECT count(*) FROM corestack_fiscal.sequence_range)+(SELECT count(*) FROM corestack_fiscal.range_event)')" == '0' ]] || fail 'FISCAL_RANGE_REGISTRY_NOT_EMPTY'
[[ "$(pg_fiscal -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$range_role' AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit")" == '1' ]] || fail 'RANGE_ROLE_INVALID'

mkdir -m 0700 "$stage"
pg_fiscal -Atqc "SELECT row_to_json(scope) FROM fiscal_meta.issuer_scope scope" >"$stage/issuer-scope.before.json"
pg_fiscal -Atqc "SELECT row_to_json(identity) FROM fiscal_meta.range_registration_identity identity" >"$stage/range-identity.before.json"
chmod 0400 "$stage/issuer-scope.before.json" "$stage/range-identity.before.json"

pg_fiscal <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
SELECT pg_advisory_xact_lock(hashtextextended('rivnu:fiscal-range:tenant-correction:20261101',0));
DO \$\$
BEGIN
  IF (SELECT count(*) FROM corestack_fiscal.sequence_range)<>0
     OR (SELECT count(*) FROM corestack_fiscal.range_event)<>0 THEN
    RAISE EXCEPTION 'Fiscal range registry is no longer empty';
  END IF;
END \$\$;
SET LOCAL ROLE $owner;
UPDATE fiscal_meta.issuer_scope
SET tenant_id='$new_tenant'
WHERE singleton AND tenant_id='$old_tenant' AND issuer_rnc='$rnc' AND environment='production';
UPDATE fiscal_meta.range_registration_identity
SET tenant_id='$new_tenant'
WHERE login_role='$range_role' AND tenant_id='$old_tenant' AND issuer_rnc='$rnc' AND environment='production';
INSERT INTO fiscal_meta.schema_migration(name,sha256)
VALUES('20261101_correct_rivnu_production_tenant','not-applicable-scope-only');
COMMIT;
SQL

[[ "$(pg_fiscal -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope WHERE singleton")" == "$new_tenant|$rnc|production" ]] || fail 'CORRECTED_FISCAL_SCOPE_INVALID'
[[ "$(pg_fiscal -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.range_registration_identity WHERE login_role='$range_role'")" == "$new_tenant|$rnc|production" ]] || fail 'CORRECTED_RANGE_IDENTITY_INVALID'
[[ "$(pg_fiscal -Atqc 'SELECT (SELECT count(*) FROM corestack_fiscal.sequence_range)+(SELECT count(*) FROM corestack_fiscal.range_event)')" == '0' ]] || fail 'FISCAL_RANGE_REGISTRY_CHANGED'

printf 'RIVNU_FISCAL_RANGE_PRODUCTION_TENANT_CORRECTED_EMPTY backup=%s\n' "$stage"
printf '%s\n' 'No range, sequence, invoice, credential, service or DGII request was created.'

#!/usr/bin/env bash
# Create the production range registry locked at NOLOGIN. No e-CF emission objects.
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_fiscal_prod'
readonly owner='rivnu_fe_prod_owner'
readonly migrator='rivnu_fe_prod_migrator'
readonly range_role='rivnu_fe_prod_range'
readonly tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly source_hash='80d1b9277935097d5ed478cea667e45bc399d007ffce3c61bf61a9f77642c30f'
readonly stage='/var/lib/corestack-pki/rivnu-fiscal-range-production-20261031'
readonly hba='/etc/postgresql/17/main/pg_hba.conf'

fail() { printf '%s\n' "$*" >&2; exit 1; }
pg_root() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres -v ON_ERROR_STOP=1 "$@"; }
pg_fiscal() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$database" -v ON_ERROR_STOP=1 "$@"; }
hash_file() { sha256sum "$1" | cut -d' ' -f1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -d /var/lib/corestack-pki && ! -L /var/lib/corestack-pki && "$(stat -c '%u:%g:%a' /var/lib/corestack-pki)" == '0:0:700' ]] || fail 'PKI_STAGING_PARENT_INVALID'
[[ ! -L "$stage" ]] || fail 'FISCAL_PRODUCTION_STAGE_SYMLINK_REJECTED'
[[ -f "$hba" && ! -L "$hba" && "$(pg_root -Atqc 'SHOW hba_file')" == "$hba" ]] || fail 'HBA_FILE_INVALID'
[[ "$(pg_root -Atqc 'SHOW server_version_num')" == 17* && "$(pg_root -Atqc 'SHOW ssl')" == 'on' ]] || fail 'POSTGRESQL_17_TLS_REQUIRED'
[[ "$(pg_root -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == '0' ]] || fail 'EXISTING_HBA_ERRORS'

source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
source_sql="$source_dir/../../packages/fiscal/sql/006_production_authorized_ranges.sql"
[[ -f "$source_sql" && ! -L "$source_sql" && "$(hash_file "$source_sql")" == "$source_hash" ]] || fail 'FISCAL_SQL_HASH_MISMATCH'

database_count=$(pg_root -Atqc "SELECT count(*) FROM pg_database WHERE datname='$database'")
role_count=$(pg_root -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('$owner','$migrator','$range_role')")

if [[ "$database_count:$role_count" == '0:0' ]]; then
  [[ ! -e "$stage" ]] || fail 'UNEXPECTED_EXISTING_FISCAL_PRODUCTION_STAGE'
  mkdir -m 0700 "$stage"
  cp -- "$source_sql" "$stage/006_production_authorized_ranges.sql"
  sed '/^BEGIN;$/d; /^COMMIT;$/d' "$stage/006_production_authorized_ranges.sql" >"$stage/install-body.sql"
  cp --preserve=mode,ownership,timestamps "$hba" "$stage/pg_hba.conf.original"
  hash_file "$hba" >"$stage/hba-original.sha256"

  pg_root <<SQL
BEGIN;
CREATE ROLE $owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE $migrator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE $range_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
GRANT $owner TO $migrator WITH INHERIT FALSE;
COMMIT;
CREATE DATABASE $database OWNER $owner TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $migrator,$range_role;
ALTER ROLE $range_role IN DATABASE $database SET search_path=pg_catalog;
ALTER ROLE $range_role IN DATABASE $database SET statement_timeout='20s';
ALTER ROLE $range_role IN DATABASE $database SET idle_in_transaction_session_timeout='15s';
SQL
elif [[ "$database_count:$role_count" == '1:3' ]]; then
  [[ -d "$stage" && "$(stat -c '%u:%g:%a' "$stage")" == '0:0:700' ]] || fail 'FISCAL_PRODUCTION_RETRY_STAGE_INVALID'
  [[ -f "$stage/006_production_authorized_ranges.sql" && ! -L "$stage/006_production_authorized_ranges.sql" ]] || fail 'STAGED_FISCAL_SQL_INVALID'
  [[ "$(hash_file "$stage/006_production_authorized_ranges.sql")" == "$source_hash" ]] || fail 'STAGED_FISCAL_SQL_HASH_MISMATCH'
  [[ -f "$stage/install-body.sql" && ! -L "$stage/install-body.sql" ]] || fail 'STAGED_INSTALL_BODY_INVALID'
  cmp -s "$stage/install-body.sql" <(sed '/^BEGIN;$/d; /^COMMIT;$/d' "$source_sql") || fail 'STAGED_INSTALL_BODY_MISMATCH'
  [[ -f "$stage/pg_hba.conf.original" && ! -L "$stage/pg_hba.conf.original" && -f "$stage/hba-original.sha256" && ! -L "$stage/hba-original.sha256" ]] || fail 'STAGED_HBA_BACKUP_INVALID'
  [[ "$(hash_file "$stage/pg_hba.conf.original")" == "$(<"$stage/hba-original.sha256")" ]] || fail 'STAGED_HBA_BACKUP_HASH_MISMATCH'
  [[ "$(hash_file "$hba")" == "$(<"$stage/hba-original.sha256")" ]] || fail 'HBA_CHANGED_SINCE_FAILED_BOOTSTRAP'
  [[ "$(pg_root -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$owner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls")" == '1' ]] || fail 'FISCAL_OWNER_ROLE_INVALID'
  [[ "$(pg_root -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$migrator' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls")" == '1' ]] || fail 'FISCAL_MIGRATOR_ROLE_INVALID'
  [[ "$(pg_root -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$range_role' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=4")" == '1' ]] || fail 'FISCAL_RANGE_ROLE_INVALID'
  [[ "$(pg_root -Atqc "SELECT count(*) FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE granted.rolname='$owner' AND member.rolname='$migrator' AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option")" == '1' ]] || fail 'FISCAL_MIGRATOR_MEMBERSHIP_INVALID'
  [[ "$(pg_root -Atqc "SELECT count(*) FROM pg_database WHERE datname='$database' AND pg_get_userbyid(datdba)='$owner' AND pg_encoding_to_char(encoding)='UTF8'")" == '1' ]] || fail 'FISCAL_PRODUCTION_DATABASE_INVALID'
  [[ "$(pg_fiscal -Atqc "SELECT count(*) FROM pg_namespace WHERE nspname IN ('fiscal_meta','corestack_fiscal')")" == '0' ]] || fail 'FISCAL_PRODUCTION_PARTIAL_SCHEMA_REVIEW_REQUIRED'
else
  fail 'FISCAL_PRODUCTION_PARTIAL_STATE_REVIEW_REQUIRED'
fi

{
cat <<SQL
BEGIN;
SET LOCAL ROLE $owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
cat "$stage/install-body.sql"
cat <<SQL
INSERT INTO fiscal_meta.issuer_scope(tenant_id,issuer_rnc,environment)
VALUES('$tenant','$rnc','production');
INSERT INTO fiscal_meta.range_registration_identity(login_role,tenant_id,issuer_rnc,environment)
VALUES('$range_role','$tenant','$rnc','production');
GRANT USAGE ON SCHEMA fiscal_meta,corestack_fiscal TO $range_role;
GRANT SELECT ON fiscal_meta.issuer_scope TO $range_role;
GRANT EXECUTE ON FUNCTION corestack_fiscal.register_authorized_range(
  text,text,text,smallint,bigint,bigint,bigint,text,date,date
) TO $range_role;
CREATE TABLE fiscal_meta.schema_migration(
  name text PRIMARY KEY,sha256 text NOT NULL,installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON fiscal_meta.schema_migration FROM PUBLIC,$range_role;
INSERT INTO fiscal_meta.schema_migration(name,sha256)
VALUES('006_production_authorized_ranges.sql','$source_hash');
COMMIT;
SQL
} | pg_fiscal

hba_stage=$(mktemp /etc/postgresql/17/main/.rivnu-fiscal-prod-hba.XXXXXX)
{
  printf '%s\n' \
    '# CoreStack RIVNU production range registration: VM4 only.' \
    "local $database postgres peer" \
    "local $database all reject" \
    "local all $range_role reject" \
    "hostssl $database $range_role 10.0.0.1/32 scram-sha-256" \
    "host all $range_role 0.0.0.0/0 reject" \
    "host all $range_role ::/0 reject" \
    "host $database all 0.0.0.0/0 reject" \
    "host $database all ::/0 reject" \
    '# End RIVNU production range registration block.'
  cat "$stage/pg_hba.conf.original"
} >"$hba_stage"
chmod --reference="$hba" "$hba_stage"
chown --reference="$hba" "$hba_stage"
[[ "$(hash_file "$hba")" == "$(<"$stage/hba-original.sha256")" ]] || fail 'HBA_CHANGED_CONCURRENTLY'
mv -T "$hba_stage" "$hba"
hash_file "$hba" >"$stage/hba-activated.sha256"
if [[ "$(pg_root -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" != '0' ]] ||
   [[ "$(pg_root -Atqc 'SELECT pg_reload_conf()')" != 't' ]]; then
  cp --preserve=mode,ownership,timestamps "$stage/pg_hba.conf.original" "$hba"
  pg_root -Atqc 'SELECT pg_reload_conf()' >/dev/null || true
  fail 'HBA_ACTIVATION_FAILED_ROLLED_BACK_DATABASE_REMAINS_LOCKED'
fi

[[ "$(pg_fiscal -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")" == "$tenant|$rnc|production" ]] || fail 'FISCAL_SCOPE_VERIFICATION_FAILED'
[[ "$(pg_root -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$range_role' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit=4")" == '1' ]] || fail 'RANGE_ROLE_NOT_LOCKED'
[[ "$(pg_fiscal -Atqc "SELECT has_function_privilege('$range_role','corestack_fiscal.register_authorized_range(text,text,text,smallint,bigint,bigint,bigint,text,date,date)','EXECUTE') AND NOT has_table_privilege('$range_role','corestack_fiscal.sequence_range','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')")" == 't' ]] || fail 'RANGE_ROLE_PRIVILEGES_INVALID'

printf 'RIVNU_FISCAL_PRODUCTION_RANGE_REGISTRY_PREPARED_NOLOGIN\n'
printf 'Backup=%s\n' "$stage"
printf 'No password, range, reservation, signing job, delivery job or DGII request was created.\n'

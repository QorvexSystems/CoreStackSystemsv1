#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_fiscal_prod'
readonly owner='rivnu_fe_prod_owner'
readonly runtime='rivnu_fe_prod_runtime'
readonly reader='rivnu_fe_prod_range'
readonly stage="/var/lib/corestack-pki/rivnu-printed-representation-$(date -u +%Y%m%dT%H%M%SZ)"
fail(){ printf '%s\n' "$1" >&2; exit 1; }
pg(){ sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d "$database" -v ON_ERROR_STOP=1 "$@"; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail RUN_WITH_SUDO_ON_VM3
source_root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
source_sql="$source_root/packages/fiscal/sql/009_production_printed_representation.sql"
[[ -f "$source_sql" && ! -L "$source_sql" ]] || fail SOURCE_MISSING
[[ "$(pg -Atqc "SELECT count(*) FROM fiscal_meta.schema_migration WHERE name='009_production_printed_representation.sql'")" == 0 ]] || {
  printf '%s\n' RIVNU_PRINTED_REPRESENTATION_ALREADY_MIGRATED
  exit 0
}
[[ "$(pg -Atqc "SELECT count(*) FROM corestack_fiscal.document")" == 0 ]] || fail EXISTING_DOCUMENTS_REQUIRE_SEPARATE_BACKFILL_REVIEW
install -d -o root -g root -m 0700 "$stage"
install -o root -g root -m 0400 "$source_sql" "$stage/migration.sql"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d "$database" --schema-only --no-owner --no-privileges >"$stage/before-schema.sql"
chmod 0600 "$stage/before-schema.sql"
body="$stage/body.sql"
{
  printf 'BEGIN;\nSET LOCAL ROLE %s;\n' "$owner"
  sed '/^BEGIN;$/d; /^COMMIT;$/d' "$stage/migration.sql"
  cat <<SQL
GRANT EXECUTE ON FUNCTION corestack_fiscal.enqueue_delivery_with_representation(bigint,text,text,text,text,text,text,jsonb) TO $runtime;
GRANT EXECUTE ON FUNCTION corestack_fiscal.read_accepted_printed_representation(bigint) TO $reader;
INSERT INTO fiscal_meta.schema_migration(name,sha256)
VALUES('009_production_printed_representation.sql','$(sha256sum "$stage/migration.sql" | cut -d' ' -f1)');
DO \$\$
BEGIN
 IF NOT has_function_privilege('$runtime','corestack_fiscal.enqueue_delivery_with_representation(bigint,text,text,text,text,text,text,jsonb)','EXECUTE')
  OR NOT has_function_privilege('$reader','corestack_fiscal.read_accepted_printed_representation(bigint)','EXECUTE')
  OR has_table_privilege('$reader','corestack_fiscal.printed_representation','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('$runtime','corestack_fiscal.printed_representation','SELECT,INSERT,UPDATE,DELETE')
 THEN RAISE EXCEPTION 'printed representation minimum privilege failed'; END IF;
 IF (SELECT count(*) FROM corestack_fiscal.document)<>0
  OR (SELECT count(*) FROM corestack_fiscal.sequence_reservation)<>0
 THEN RAISE EXCEPTION 'migration changed fiscal state'; END IF;
END \$\$;
COMMIT;
SQL
} >"$body"
chmod 0400 "$body"
pg <"$body"
printf 'RIVNU_PRINTED_REPRESENTATION_MIGRATED_MINIMUM_PRIVILEGE backup=%s\n' "$stage"
printf '%s\n' 'No e-NCF, invoice, reservation, queue or DGII request was created.'

#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly source_sql='/home/luismel/scope_alignment_20261006.sql'
readonly stage='/var/lib/corestack-pki/fiscal-scope-alignment-20261006'
readonly expected_old='cmqn0r66a0002lit0vxbzq5l4|40220429126|precertification'
readonly expected_new='cmt397emm0002nm0ogb50l2q6|40220429126|precertification'
readonly expected_hash='fab041e927e67ad9f6b3d231145b18704c0080b9d74bdd0921a546932309951a'
fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 "$@"; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -f "$source_sql" && ! -L "$source_sql" ]] || fail 'MIGRATION_SOURCE_INVALID'
[[ "$(sha256sum "$source_sql" | cut -d' ' -f1)" == "$expected_hash" ]] || fail 'MIGRATION_HASH_MISMATCH'
[[ "$(pg -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")" == "$expected_old" ]] || fail 'CURRENT_SCOPE_NOT_EXPECTED'

if [[ ! -e "$stage" && ! -L "$stage" ]]; then
  install -d -o root -g postgres -m 0750 "$stage"
  sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre --format=custom >"$stage/before.dump"
  pg_restore --list "$stage/before.dump" >"$stage/before.inventory"
  install -o root -g postgres -m 0440 "$source_sql" "$stage/migration.sql"
  sed -i "s/REPLACED_BY_INSTALLER/$expected_hash/" "$stage/migration.sql"
else
  [[ -d "$stage" && ! -L "$stage" ]] || fail 'ALIGNMENT_STAGE_INVALID'
  [[ "$(stat -c '%U:%G:%a' "$stage")" == 'root:postgres:750' ]] || fail 'ALIGNMENT_STAGE_PERMISSIONS_INVALID'
  for artifact in before.dump before.inventory migration.sql; do
    [[ -f "$stage/$artifact" && ! -L "$stage/$artifact" ]] || fail "ALIGNMENT_STAGE_ARTIFACT_INVALID_$artifact"
  done
  pg_restore --list "$stage/before.dump" >/dev/null || fail 'ALIGNMENT_BACKUP_INVALID'
  cmp -s <(sed "s/REPLACED_BY_INSTALLER/$expected_hash/" "$source_sql") "$stage/migration.sql" || fail 'STAGED_MIGRATION_MISMATCH'
  [[ "$(pg -Atqc "SELECT count(*) FROM corestack_fiscal.schema_migration WHERE name='scope_alignment_20261006.sql'")" == '0' ]] || fail 'ALIGNMENT_MIGRATION_ALREADY_RECORDED'
  [[ "$(pg -Atqc "SELECT (SELECT count(*) FROM corestack_fiscal.sequence_range)+(SELECT count(*) FROM corestack_fiscal.sequence_reservation)+(SELECT count(*) FROM corestack_fiscal.request_snapshot)+(SELECT count(*) FROM corestack_fiscal.document)+(SELECT count(*) FROM corestack_fiscal.preparation_job)+(SELECT count(*) FROM corestack_fiscal.document_artifact)")" == '0' ]] || fail 'FISCAL_DATABASE_NO_LONGER_EMPTY'
  echo 'RESUMING_VERIFIED_ALIGNMENT_STAGE'
fi

# Root opens the protected staged file and PostgreSQL receives it on stdin.
# The postgres OS user intentionally cannot traverse the PKI backup root.
pg <"$stage/migration.sql"
[[ "$(pg -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope")" == "$expected_new" ]] || fail 'SCOPE_ALIGNMENT_VERIFICATION_FAILED'
[[ "$(pg -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM corestack_fiscal.runtime_scope WHERE login_role='rivnu_fe_pre_runtime'")" == "$expected_new" ]] || fail 'RUNTIME_SCOPE_ALIGNMENT_VERIFICATION_FAILED'
[[ "$(pg -Atqc "SELECT sha256 FROM corestack_fiscal.schema_migration WHERE name='scope_alignment_20261006.sql'")" == "$expected_hash" ]] || fail 'SCOPE_ALIGNMENT_MIGRATION_RECORD_INVALID'
echo 'RIVNU_FISCAL_SCOPE_ALIGNED_EMPTY_DATABASE'
echo "Backup: $stage/before.dump"
echo 'No ranges, reservations, documents, XML or e-NCF were migrated.'

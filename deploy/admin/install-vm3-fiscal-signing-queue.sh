#!/usr/bin/env bash
# Explicit signing-intent queue. Starts paused and does not sign or transmit.
set -euo pipefail
umask 077
readonly source_sql='/home/luismel/005_signing_queue.sql'
readonly expected_hash='bd2c0f41883e0f4e2cc9b3962bff624efcb8b41c679233a89a0fc225c3d74dcb'
readonly stage='/var/lib/corestack-pki/fiscal-signing-install-20261006'
fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 "$@"; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -f "$source_sql" && ! -L "$source_sql" && "$(sha256sum "$source_sql" | cut -d' ' -f1)" == "$expected_hash" ]] || fail 'SIGNING_MIGRATION_SOURCE_INVALID'
[[ ! -e "$stage" && ! -L "$stage" ]] || fail 'SIGNING_INSTALL_ALREADY_ATTEMPTED_REVIEW_STAGE'
[[ "$(pg -Atqc "SELECT sha256 FROM corestack_fiscal.schema_migration WHERE name='004_delivery_queue.sql'")" == '7f0f30e3612364b03c8ac45490c5149d6d84c12823ac2472dfcc75705627278c' ]] || fail 'DELIVERY_QUEUE_NOT_READY'
[[ "$(pg -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='corestack_fiscal' AND table_name IN ('signing_control','signing_job','signing_event')")" == '0' ]] || fail 'SIGNING_SCHEMA_ALREADY_PRESENT'
[[ "$(pg -Atqc "SELECT count(*) FROM corestack_fiscal.request_snapshot")" == '0' ]] || fail 'FISCAL_DATABASE_NOT_EMPTY'
install -d -o root -g root -m 0700 "$stage"
sudo -u postgres pg_dump -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre --format=custom >"$stage/before.dump"
pg_restore --list "$stage/before.dump" >"$stage/before.inventory"
install -o root -g root -m 0400 "$source_sql" "$stage/005_signing_queue.sql"
{
  printf '%s\n' "BEGIN;" "SET LOCAL lock_timeout='5s';" "SET LOCAL statement_timeout='30s';" 'SET LOCAL ROLE rivnu_fe_pre_owner;'
  sed '/^BEGIN;$/d; /^COMMIT;$/d' "$stage/005_signing_queue.sql"
  printf '%s\n' \
    "INSERT INTO corestack_fiscal.signing_control(tenant_id,issuer_rnc,environment,paused) SELECT tenant_id,issuer_rnc,environment,true FROM fiscal_meta.issuer_scope;" \
    'GRANT EXECUTE ON FUNCTION corestack_fiscal.request_signing(bigint) TO rivnu_fe_pre_runtime;' \
    'GRANT EXECUTE ON FUNCTION corestack_fiscal.claim_signing(),corestack_fiscal.complete_signing(bigint,uuid),corestack_fiscal.fail_signing(bigint,uuid,text),corestack_fiscal.read_preparation(bigint),corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text) TO rivnu_fe_pre_signer;' \
    "INSERT INTO corestack_fiscal.schema_migration(name,sha256) VALUES('005_signing_queue.sql','$expected_hash');" \
    'COMMIT;'
} | pg
[[ "$(pg -Atqc "SELECT paused FROM corestack_fiscal.signing_control WHERE tenant_id='cmt397emm0002nm0ogb50l2q6' AND issuer_rnc='40220429126' AND environment='precertification'")" == 't' ]] || fail 'SIGNING_CONTROL_NOT_PAUSED'
echo 'FISCAL_SIGNING_QUEUE_INSTALLED_PAUSED'
echo "Backup: $stage/before.dump"
echo 'No signing request created, no XML signed, delivery remains paused and no DGII request was made.'

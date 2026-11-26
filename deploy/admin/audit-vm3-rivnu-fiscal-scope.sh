#!/usr/bin/env bash
# Read-only guard before aligning the fiscal database with the current ERP tenant.
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'

sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
  -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
BEGIN READ ONLY;
SELECT tenant_id,issuer_rnc,environment FROM fiscal_meta.issuer_scope;
SELECT login_role,tenant_id,issuer_rnc,environment
FROM corestack_fiscal.runtime_scope ORDER BY login_role;
SELECT name,sha256,installed_at FROM corestack_fiscal.schema_migration ORDER BY name;
SELECT
 (SELECT count(*) FROM corestack_fiscal.sequence_range) AS sequence_ranges,
 (SELECT count(*) FROM corestack_fiscal.sequence_reservation) AS reservations,
 (SELECT count(*) FROM corestack_fiscal.request_snapshot) AS requests,
 (SELECT count(*) FROM corestack_fiscal.document) AS documents,
 (SELECT count(*) FROM corestack_fiscal.preparation_job) AS preparation_jobs,
 (SELECT count(*) FROM corestack_fiscal.document_artifact) AS unsigned_artifacts;
SELECT to_regclass('corestack_fiscal.outbound_artifact') IS NOT NULL AS delivery_schema_installed \gset
\if :delivery_schema_installed
SELECT
 (SELECT count(*) FROM corestack_fiscal.outbound_artifact) AS outbound_artifacts,
 (SELECT count(*) FROM corestack_fiscal.delivery_job) AS delivery_jobs;
\else
SELECT NULL::bigint AS outbound_artifacts,NULL::bigint AS delivery_jobs;
\endif
COMMIT;
SQL

echo 'FISCAL_SCOPE_AUDIT_COMPLETE_NO_CHANGES'

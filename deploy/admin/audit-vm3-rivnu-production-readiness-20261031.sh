#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == VM3-SQLDB ]] || fail RUN_WITH_SUDO_ON_VM3

pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -v ON_ERROR_STOP=1 -P pager=off "$@"
}

printf '\n=== POSTGRESQL ===\n'
pg -d postgres -c "SELECT current_setting('server_version') AS version,current_setting('ssl') AS ssl;"
pg -d postgres -c "SELECT datname FROM pg_database WHERE datname IN ('rivnu_production','rivnu_fiscal_pre') ORDER BY datname;"
pg -d postgres -c "SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname LIKE 'rivnu%fiscal%' OR rolname LIKE 'rivnu_fe_%' ORDER BY rolname;"

printf '\n=== HBA FISCAL (NO PASSWORDS) ===\n'
pg -d postgres -c "SELECT line_number,type,database,user_name,address,auth_method,error FROM pg_hba_file_rules WHERE database::text LIKE '%rivnu%' OR user_name::text LIKE '%rivnu_fe_%' ORDER BY line_number;"

for database in rivnu_fiscal_pre rivnu_production; do
  exists="$(pg -d postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname='$database'")"
  [[ "$exists" == 1 ]] || continue

  printf '\n=== DATABASE %s ===\n' "$database"
  pg -d "$database" <<'SQL'
BEGIN READ ONLY;
SELECT schemaname FROM pg_tables
WHERE schemaname IN ('fiscal_meta','corestack_fiscal')
GROUP BY schemaname ORDER BY schemaname;

SELECT to_regclass('fiscal_meta.issuer_scope') IS NOT NULL AS has_issuer_scope \gset
\if :has_issuer_scope
SELECT tenant_id,issuer_rnc,environment FROM fiscal_meta.issuer_scope;
\endif

SELECT to_regclass('corestack_fiscal.runtime_scope') IS NOT NULL AS has_runtime_scope \gset
\if :has_runtime_scope
SELECT login_role,tenant_id,issuer_rnc,environment
FROM corestack_fiscal.runtime_scope ORDER BY login_role;
\endif

SELECT to_regclass('corestack_fiscal.sequence_range') IS NOT NULL AS has_ranges \gset
\if :has_ranges
SELECT tenant_id,issuer_rnc,environment,ecf_type,first_number,last_number,next_number,
       valid_from,valid_until,authorization_reference
FROM corestack_fiscal.sequence_range ORDER BY environment,ecf_type,first_number;
SELECT count(*) AS reservations FROM corestack_fiscal.sequence_reservation;
\endif

SELECT to_regclass('corestack_fiscal.signing_control') IS NOT NULL AS has_signing \gset
\if :has_signing
SELECT tenant_id,issuer_rnc,environment,paused FROM corestack_fiscal.signing_control;
SELECT count(*) AS signing_jobs FROM corestack_fiscal.signing_job;
\endif

SELECT to_regclass('corestack_fiscal.delivery_control') IS NOT NULL AS has_delivery \gset
\if :has_delivery
SELECT tenant_id,issuer_rnc,environment,paused FROM corestack_fiscal.delivery_control;
SELECT count(*) AS delivery_jobs FROM corestack_fiscal.delivery_job;
SELECT count(*) AS outbound_artifacts FROM corestack_fiscal.outbound_artifact;
\endif
COMMIT;
SQL
done

printf '\nRIVNU_VM3_PRODUCTION_READINESS_AUDIT_COMPLETE_NO_CHANGES\n'

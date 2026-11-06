#!/usr/bin/env bash
set -euo pipefail

[[ "$(hostname)" == VM3-SQLDB && "${EUID}" -eq 0 ]] || { echo 'Ejecutar como root en VM3-SQLDB' >&2; exit 1; }

secrets=/opt/corestack/secrets/solucionesautomotriz-db-provision.env
[[ -f "$secrets" && "$(stat -c %a "$secrets")" == 600 ]] || { echo 'Falta db-provision.env (modo 600)' >&2; exit 1; }
read_secret() {
  local key="$1" value
  [[ "$(grep -c "^${key}=" "$secrets")" == 1 ]] || { echo "Falta $key o está duplicada" >&2; return 1; }
  value=$(sed -n "s/^${key}=//p" "$secrets")
  [[ "$value" =~ ^[A-Za-z0-9_-]{48,128}$ ]] || { echo "Formato inválido: $key" >&2; return 1; }
  printf '%s' "$value"
}
migrator_password=$(read_secret MIGRATOR_PASSWORD)
runtime_password=$(read_secret RUNTIME_PASSWORD)

psql_admin=(runuser -u postgres -- psql --no-psqlrc -X -v ON_ERROR_STOP=1)
[[ "$(pg_lsclusters --no-header | awk '$1==17 && $2=="main" {print $4}')" == online ]] || { echo 'PostgreSQL 17/main no está activo' >&2; exit 1; }
[[ "$("${psql_admin[@]}" -Atqc 'SHOW ssl')" == on ]] || { echo 'PostgreSQL TLS no está activo' >&2; exit 1; }
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_database WHERE datname='solucionesautomotriz_production'")" == 0 ]] || { echo 'La base ya existe; revisar antes de continuar' >&2; exit 1; }
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('solucionesautomotriz_migrator','solucionesautomotriz_runtime')")" == 0 ]] || { echo 'Los roles ya existen; revisar antes de continuar' >&2; exit 1; }

hba=$("${psql_admin[@]}" -Atqc 'SHOW hba_file')
marker='# BEGIN CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION'
! grep -Fq "$marker" "$hba" || { echo 'Bloque HBA existente; revisar antes de continuar' >&2; exit 1; }
backup="${hba}.before-solucionesautomotriz.$(date -u +%Y%m%dT%H%M%SZ)"
install -m 600 -o "$(stat -c %U "$hba")" -g "$(stat -c %G "$hba")" "$hba" "$backup"

{
  printf "\\set migrator_password '%s'\n" "$migrator_password"
  printf "\\set runtime_password '%s'\n" "$runtime_password"
  cat <<'SQL'
BEGIN;
CREATE ROLE solucionesautomotriz_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator_password';
CREATE ROLE solucionesautomotriz_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'runtime_password';
COMMIT;
SQL
} | "${psql_admin[@]}" -q
unset migrator_password runtime_password
runuser -u postgres -- createdb --owner=solucionesautomotriz_migrator --template=template0 --encoding=UTF8 solucionesautomotriz_production
"${psql_admin[@]}" -q -c 'REVOKE ALL ON DATABASE solucionesautomotriz_production FROM PUBLIC'
"${psql_admin[@]}" -q -c 'GRANT CONNECT ON DATABASE solucionesautomotriz_production TO solucionesautomotriz_runtime'

"${psql_admin[@]}" -q -d solucionesautomotriz_production <<'SQL'
GRANT USAGE ON SCHEMA public TO solucionesautomotriz_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE solucionesautomotriz_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO solucionesautomotriz_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE solucionesautomotriz_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO solucionesautomotriz_runtime;
SQL

temp=$(mktemp "${hba}.solucionesautomotriz.XXXXXX")
{
  cat <<'HBA'
# BEGIN CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION
hostssl solucionesautomotriz_production solucionesautomotriz_migrator 10.0.0.3/32 scram-sha-256
hostssl solucionesautomotriz_production solucionesautomotriz_runtime  10.0.0.3/32 scram-sha-256
host    all                               solucionesautomotriz_migrator 0.0.0.0/0 reject
host    all                               solucionesautomotriz_runtime  0.0.0.0/0 reject
host    all                               solucionesautomotriz_migrator ::/0 reject
host    all                               solucionesautomotriz_runtime  ::/0 reject
# END CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION

HBA
  cat "$hba"
} > "$temp"
install -m "$(stat -c %a "$hba")" -o "$(stat -c %U "$hba")" -g "$(stat -c %G "$hba")" "$temp" "$hba"
rm -f "$temp"
"${psql_admin[@]}" -q -c 'SELECT pg_reload_conf()' >/dev/null
[[ "$("${psql_admin[@]}" -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]] || { echo "HBA inválido. Restaurar desde $backup" >&2; exit 1; }
rm -f "$secrets"
echo "Base y roles creados; respaldo HBA: $backup"

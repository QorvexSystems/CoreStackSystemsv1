#!/usr/bin/env bash
set -euo pipefail

database_name=hotelancla_production
migrator_role=hotelancla_migrator
runtime_role=hotelancla_runtime
secrets_file=/opt/corestack/scripts/.hotelancla-db-provision.env
marker='# BEGIN CORESTACK HOTELANCLA PRODUCTION'

[[ $EUID -eq 0 ]] || { echo 'Ejecuta con sudo en VM3' >&2; exit 1; }
[[ $(hostname) == VM3-SQLDB ]] || { echo 'Host inesperado' >&2; exit 1; }
[[ -f $secrets_file && $(stat -c %a "$secrets_file") == 600 ]] || {
  echo 'Faltan credenciales privadas de aprovisionamiento (modo 600)' >&2
  exit 1
}

read_secret() {
  local key=$1 value
  [[ $(grep -c "^${key}=" "$secrets_file") == 1 ]] || { echo "Falta $key" >&2; return 1; }
  value=$(sed -n "s/^${key}=//p" "$secrets_file")
  [[ $value =~ ^[A-Za-z0-9_-]{48,128}$ ]] || { echo "Formato inválido: $key" >&2; return 1; }
  printf %s "$value"
}

migrator_password=$(read_secret HOTELANCLA_MIGRATOR_PASSWORD)
runtime_password=$(read_secret HOTELANCLA_RUNTIME_PASSWORD)
[[ -n $(pg_lsclusters --no-header | awk '$1 == "17" && $2 == "main" && $4 == "online" {print}') ]] || {
  echo 'PostgreSQL 17/main no está online' >&2
  exit 1
}
[[ $(runuser -u postgres -- psql -XAtc 'SHOW password_encryption') == scram-sha-256 ]] || {
  echo 'PostgreSQL no usa SCRAM' >&2; exit 1;
}
[[ $(runuser -u postgres -- psql -XAtc 'SHOW ssl') == on ]] || {
  echo 'PostgreSQL no tiene TLS activo' >&2; exit 1;
}

existing_db=$(runuser -u postgres -- psql -XAtc "SELECT count(*) FROM pg_database WHERE datname='${database_name}'")
existing_roles=$(runuser -u postgres -- psql -XAtc "SELECT count(*) FROM pg_roles WHERE rolname IN ('${migrator_role}','${runtime_role}')")
[[ $existing_db == 0 && $existing_roles == 0 ]] || {
  echo 'Ya existen objetos del hotel; no se sobrescribieron' >&2; exit 1;
}

hba_file=$(runuser -u postgres -- psql -XAtc 'SHOW hba_file')
[[ -f $hba_file ]] || { echo 'No existe pg_hba.conf' >&2; exit 1; }
! grep -Fq "$marker" "$hba_file" || { echo 'Ya existe bloque HBA del hotel' >&2; exit 1; }
backup_dir=/opt/corestack/backups/postgresql
install -d -o root -g root -m 700 "$backup_dir"
hba_backup="$backup_dir/pg_hba.conf.before-hotelancla.$(date -u +%Y%m%dT%H%M%SZ)"
install -o root -g root -m 600 "$hba_file" "$hba_backup"

objects_created=false
hba_changed=false
cleanup_on_error() {
  local code=$?
  set +e
  if [[ $hba_changed == true ]]; then
    install -o "$(stat -c %U "$hba_file")" -g "$(stat -c %G "$hba_file")" \
      -m "$(stat -c %a "$hba_file")" "$hba_backup" "$hba_file"
    runuser -u postgres -- psql -Xqc 'SELECT pg_reload_conf()' >/dev/null
  fi
  if [[ $objects_created == true ]]; then
    runuser -u postgres -- dropdb --if-exists "$database_name" >/dev/null
    runuser -u postgres -- dropuser --if-exists "$runtime_role" >/dev/null
    runuser -u postgres -- dropuser --if-exists "$migrator_role" >/dev/null
  fi
  echo 'Falló el aprovisionamiento; se revirtieron sus cambios' >&2
  exit "$code"
}
trap cleanup_on_error ERR

{
  printf "\\set migrator_password '%s'\n" "$migrator_password"
  printf "\\set runtime_password '%s'\n" "$runtime_password"
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE hotelancla_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator_password';
CREATE ROLE hotelancla_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'runtime_password';
COMMIT;
SQL
} | runuser -u postgres -- psql -Xq
objects_created=true

runuser -u postgres -- createdb --owner="$migrator_role" --template=template0 --encoding=UTF8 "$database_name"
runuser -u postgres -- psql -Xq -c "REVOKE ALL ON DATABASE ${database_name} FROM PUBLIC"
runuser -u postgres -- psql -Xq -c "GRANT CONNECT ON DATABASE ${database_name} TO ${runtime_role}"

hba_tmp=$(mktemp "${hba_file}.hotelancla.XXXXXX")
{
  cat <<EOF
$marker
# TLS-only from VM2; deny these roles on all other origins and databases.
hostssl ${database_name} ${runtime_role}  10.0.0.3/32 scram-sha-256
hostssl ${database_name} ${migrator_role} 10.0.0.3/32 scram-sha-256
host    all ${runtime_role}  0.0.0.0/0 reject
host    all ${migrator_role} 0.0.0.0/0 reject
host    all ${runtime_role}  ::/0 reject
host    all ${migrator_role} ::/0 reject
# END CORESTACK HOTELANCLA PRODUCTION

EOF
  cat "$hba_file"
} > "$hba_tmp"
install -o "$(stat -c %U "$hba_file")" -g "$(stat -c %G "$hba_file")" \
  -m "$(stat -c %a "$hba_file")" "$hba_tmp" "$hba_file"
rm -f "$hba_tmp"
hba_changed=true

runuser -u postgres -- psql -Xqc 'SELECT pg_reload_conf()' >/dev/null
[[ $(runuser -u postgres -- psql -XAtc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL') == 0 ]] || {
  echo 'Error de sintaxis en pg_hba.conf' >&2; false;
}

rm -f "$secrets_file"
unset migrator_password runtime_password
trap - ERR
echo "DATABASE=$database_name"
echo "ROLES=$migrator_role,$runtime_role"
echo "HBA_BACKUP=$hba_backup"

#!/usr/bin/env bash
set -euo pipefail

expected_hostname="VM3-SQLDB"
database_name="allpa_production"
migrator_role="allpa_migrator"
runtime_role="allpa_runtime"
vm2_address="10.0.0.3/32"
secrets_file="/opt/corestack/scripts/.allpa-db-provision.env"
marker="# BEGIN CORESTACK ALLPA PRODUCTION"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script con sudo en VM3."
  exit 1
fi

if [[ "$(hostname)" != "${expected_hostname}" ]]; then
  echo "Host inesperado; se esperaba ${expected_hostname}."
  exit 1
fi

if [[ ! -f "${secrets_file}" ]]; then
  echo "No existe el archivo temporal de credenciales."
  exit 1
fi

if [[ "$(stat -c '%a' "${secrets_file}")" != "600" ]]; then
  echo "El archivo temporal de credenciales debe tener permisos 600."
  exit 1
fi

read_secret() {
  local key="$1"
  local value
  if [[ "$(grep -c "^${key}=" "${secrets_file}")" -ne 1 ]]; then
    echo "Falta ${key} o esta duplicada." >&2
    return 1
  fi
  value="$(sed -n "s/^${key}=//p" "${secrets_file}")"
  if [[ ! "${value}" =~ ^[A-Za-z0-9_-]{48,128}$ ]]; then
    echo "${key} no cumple el formato esperado." >&2
    return 1
  fi
  printf '%s' "${value}"
}

migrator_password="$(read_secret ALLPA_MIGRATOR_PASSWORD)"
runtime_password="$(read_secret ALLPA_RUNTIME_PASSWORD)"

cluster_line="$(pg_lsclusters --no-header | awk '$1 == "17" && $2 == "main" && $4 == "online" { print }')"
if [[ -z "${cluster_line}" ]]; then
  echo "PostgreSQL 17/main no esta online."
  exit 1
fi

password_encryption="$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command 'SHOW password_encryption')"
ssl_enabled="$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command 'SHOW ssl')"
if [[ "${password_encryption}" != "scram-sha-256" || "${ssl_enabled}" != "on" ]]; then
  echo "PostgreSQL no cumple SCRAM/TLS; no se realizaron cambios."
  exit 1
fi

database_exists="$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_database WHERE datname='${database_name}'")"
role_count="$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM pg_roles WHERE rolname IN ('${migrator_role}','${runtime_role}')")"
if [[ "${database_exists}" != "0" || "${role_count}" != "0" ]]; then
  echo "ALLPA ya tiene objetos parciales o existentes; no se sobrescribieron."
  exit 1
fi

hba_file="$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command 'SHOW hba_file')"
if [[ ! -f "${hba_file}" ]]; then
  echo "No se encontro pg_hba.conf."
  exit 1
fi
if grep -Fq "${marker}" "${hba_file}"; then
  echo "Ya existe un bloque HBA de ALLPA; no se duplico."
  exit 1
fi

backup_dir="/opt/corestack/backups/postgresql"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 700 "${backup_dir}"
hba_backup="${backup_dir}/pg_hba.conf.before-allpa.${timestamp}"
install -o root -g root -m 600 "${hba_file}" "${hba_backup}"

objects_created=false
hba_changed=false
cleanup_on_error() {
  local exit_code=$?
  set +e
  if [[ "${hba_changed}" == true ]]; then
    install -o "$(stat -c '%U' "${hba_file}")" -g "$(stat -c '%G' "${hba_file}")" \
      -m "$(stat -c '%a' "${hba_file}")" "${hba_backup}" "${hba_file}"
    runuser -u postgres -- psql --no-psqlrc --quiet --command 'SELECT pg_reload_conf()' >/dev/null
  fi
  if [[ "${objects_created}" == true ]]; then
    runuser -u postgres -- psql --no-psqlrc --quiet --command "DROP DATABASE IF EXISTS ${database_name}" >/dev/null
    runuser -u postgres -- psql --no-psqlrc --quiet --command "DROP ROLE IF EXISTS ${runtime_role}" >/dev/null
    runuser -u postgres -- psql --no-psqlrc --quiet --command "DROP ROLE IF EXISTS ${migrator_role}" >/dev/null
  fi
  echo "El aprovisionamiento fallo y se revirtieron sus cambios."
  exit "${exit_code}"
}
trap cleanup_on_error ERR

{
  printf "\\set migrator_password '%s'\n" "${migrator_password}"
  printf "\\set runtime_password '%s'\n" "${runtime_password}"
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE allpa_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator_password';
CREATE ROLE allpa_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'runtime_password';
COMMIT;
SQL
} | runuser -u postgres -- psql --no-psqlrc --quiet
objects_created=true

runuser -u postgres -- createdb --owner="${migrator_role}" --template=template0 --encoding=UTF8 "${database_name}"
runuser -u postgres -- psql --no-psqlrc --quiet --command "REVOKE ALL ON DATABASE ${database_name} FROM PUBLIC"
runuser -u postgres -- psql --no-psqlrc --quiet --command "GRANT CONNECT ON DATABASE ${database_name} TO ${runtime_role}"

hba_temp="$(mktemp "${hba_file}.allpa.XXXXXX")"
{
  cat <<EOF
${marker}
# TLS-only ALLPA access from VM2. Roles are rejected for every other database/origin.
hostssl ${database_name} ${runtime_role}  ${vm2_address} scram-sha-256
hostssl ${database_name} ${migrator_role} 10.0.0.3/32 scram-sha-256
host    all             ${runtime_role}  0.0.0.0/0     reject
host    all             ${migrator_role} 0.0.0.0/0     reject
host    all             ${runtime_role}  ::/0          reject
host    all             ${migrator_role} ::/0          reject
# END CORESTACK ALLPA PRODUCTION

EOF
  cat "${hba_file}"
} > "${hba_temp}"
install -o "$(stat -c '%U' "${hba_file}")" -g "$(stat -c '%G' "${hba_file}")" \
  -m "$(stat -c '%a' "${hba_file}")" "${hba_temp}" "${hba_file}"
rm -f "${hba_temp}"
hba_changed=true

runuser -u postgres -- psql --no-psqlrc --quiet --command 'SELECT pg_reload_conf()' >/dev/null
hba_errors="$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')"
if [[ "${hba_errors}" != "0" ]]; then
  echo "PostgreSQL detecto errores en pg_hba.conf."
  false
fi

runuser -u postgres -- psql --no-psqlrc --command \
  "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='${database_name}'"
runuser -u postgres -- psql --no-psqlrc --command \
  "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname IN ('${migrator_role}','${runtime_role}') ORDER BY rolname"

rm -f "${secrets_file}"
unset migrator_password runtime_password
trap - ERR
echo "HBA_BACKUP=${hba_backup}"
echo "ALLPA_DATABASE_PROVISIONED"

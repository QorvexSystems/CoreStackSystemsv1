#!/usr/bin/env bash
set -euo pipefail

[[ "$(hostname)" == VM3-SQLDB && "$EUID" -eq 0 ]] || {
  echo 'Ejecutar como root en VM3-SQLDB.' >&2
  exit 1
}

secrets=/opt/corestack/secrets/solucionesautomotrizcyr-rename.env
[[ -f "$secrets" && "$(stat -c %a "$secrets")" == 600 ]] || {
  echo 'Falta el archivo privado de credenciales (modo 600).' >&2
  exit 1
}

read_secret() {
  local key="$1" value
  [[ "$(grep -c "^${key}=" "$secrets")" == 1 ]] || return 1
  value=$(sed -n "s/^${key}=//p" "$secrets")
  [[ "$value" =~ ^[A-Za-z0-9_-]{48,128}$ ]] || return 1
  printf '%s' "$value"
}
migrator_password=$(read_secret MIGRATOR_PASSWORD)
runtime_password=$(read_secret RUNTIME_PASSWORD)
psql_admin=(runuser -u postgres -- psql --no-psqlrc -X -v ON_ERROR_STOP=1)

old_db=solucionesautomotriz_production
new_db=solucionesautomotrizcyr_production
old_migrator=solucionesautomotriz_migrator
new_migrator=solucionesautomotrizcyr_migrator
old_runtime=solucionesautomotriz_runtime
new_runtime=solucionesautomotrizcyr_runtime

[[ "$(pg_lsclusters --no-header | awk '$1==17 && $2=="main" {print $4}')" == online ]] || {
  echo 'PostgreSQL 17/main no está activo.' >&2
  exit 1
}
[[ "$("${psql_admin[@]}" -Atqc 'SHOW ssl')" == on ]] || {
  echo 'PostgreSQL TLS no está activo.' >&2
  exit 1
}
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_database WHERE datname='${old_db}'")" == 1 ]] || {
  echo 'No existe exactamente una base de origen.' >&2
  exit 1
}
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_database WHERE datname='${new_db}'")" == 0 ]] || {
  echo 'La base nueva ya existe; no se sobrescribe.' >&2
  exit 1
}
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('${old_migrator}','${old_runtime}')")" == 2 ]] || {
  echo 'Faltan roles de origen.' >&2
  exit 1
}
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('${new_migrator}','${new_runtime}')")" == 0 ]] || {
  echo 'Ya existen roles nuevos; no se sobrescriben.' >&2
  exit 1
}
[[ "$("${psql_admin[@]}" -Atqc "SELECT count(*) FROM pg_stat_activity WHERE datname='${old_db}'")" == 0 ]] || {
  echo 'La base tiene conexiones activas. Detener API y respaldos antes de renombrar.' >&2
  exit 1
}

hba=$("${psql_admin[@]}" -Atqc 'SHOW hba_file')
old_begin='# BEGIN CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION'
old_end='# END CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION'
[[ "$(grep -Fc "$old_begin" "$hba")" == 1 && "$(grep -Fc "$old_end" "$hba")" == 1 ]] || {
  echo 'El bloque HBA de origen no es único.' >&2
  exit 1
}
backup="${hba}.before-solucionesautomotrizcyr.$(date -u +%Y%m%dT%H%M%SZ)"
install -m 600 -o "$(stat -c %U "$hba")" -g "$(stat -c %G "$hba")" "$hba" "$backup"

db_renamed=false
roles_renamed=false
hba_changed=false
rollback() {
  local exit_code=$?
  trap - ERR
  set +e
  if [[ "$hba_changed" == true ]]; then
    install -m "$(stat -c %a "$hba")" -o "$(stat -c %U "$hba")" -g "$(stat -c %G "$hba")" "$backup" "$hba"
    "${psql_admin[@]}" -q -c 'SELECT pg_reload_conf()' >/dev/null
  fi
  if [[ "$roles_renamed" == true ]]; then
    "${psql_admin[@]}" -q -c "ALTER ROLE ${new_migrator} RENAME TO ${old_migrator}"
    "${psql_admin[@]}" -q -c "ALTER ROLE ${new_runtime} RENAME TO ${old_runtime}"
  fi
  if [[ "$db_renamed" == true ]]; then
    "${psql_admin[@]}" -q -c "ALTER DATABASE ${new_db} RENAME TO ${old_db}"
  fi
  echo 'El cambio falló; se intentó restaurar nombres y HBA originales. Revisar el estado antes de reintentar.' >&2
  exit "$exit_code"
}
trap rollback ERR

"${psql_admin[@]}" -q -c "ALTER DATABASE ${old_db} RENAME TO ${new_db}"
db_renamed=true

{
  printf "\\set migrator_password '%s'\n" "$migrator_password"
  printf "\\set runtime_password '%s'\n" "$runtime_password"
  cat <<'SQL'
BEGIN;
ALTER ROLE solucionesautomotriz_migrator RENAME TO solucionesautomotrizcyr_migrator;
ALTER ROLE solucionesautomotriz_runtime RENAME TO solucionesautomotrizcyr_runtime;
ALTER ROLE solucionesautomotrizcyr_migrator PASSWORD :'migrator_password';
ALTER ROLE solucionesautomotrizcyr_runtime PASSWORD :'runtime_password';
COMMIT;
SQL
} | "${psql_admin[@]}" -q
roles_renamed=true
unset migrator_password runtime_password

temp=$(mktemp "${hba}.solucionesautomotrizcyr.XXXXXX")
python3 - "$hba" "$temp" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
begin = '# BEGIN CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION'
end = '# END CORESTACK SOLUCIONESAUTOMOTRIZ PRODUCTION'
assert source.count(begin) == source.count(end) == 1
start = source.index(begin)
finish = source.index(end, start) + len(end)
replacement = '''# BEGIN CORESTACK SOLUCIONESAUTOMOTRIZCYR PRODUCTION
hostssl solucionesautomotrizcyr_production solucionesautomotrizcyr_migrator 10.0.0.3/32 scram-sha-256
hostssl solucionesautomotrizcyr_production solucionesautomotrizcyr_runtime  10.0.0.3/32 scram-sha-256
host    all                                  solucionesautomotrizcyr_migrator 0.0.0.0/0 reject
host    all                                  solucionesautomotrizcyr_runtime  0.0.0.0/0 reject
host    all                                  solucionesautomotrizcyr_migrator ::/0 reject
host    all                                  solucionesautomotrizcyr_runtime  ::/0 reject
# END CORESTACK SOLUCIONESAUTOMOTRIZCYR PRODUCTION'''
Path(sys.argv[2]).write_text(source[:start] + replacement + source[finish:])
PY
install -m "$(stat -c %a "$hba")" -o "$(stat -c %U "$hba")" -g "$(stat -c %G "$hba")" "$temp" "$hba"
rm -f "$temp"
hba_changed=true
"${psql_admin[@]}" -q -c 'SELECT pg_reload_conf()' >/dev/null
[[ "$("${psql_admin[@]}" -Atqc 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" == 0 ]]
[[ "$("${psql_admin[@]}" -Atqc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='${new_db}'")" == "$new_migrator" ]]

rm -f "$secrets"
trap - ERR
echo "RENAMED_DATABASE=${new_db}"
echo "RENAMED_ROLES=${new_migrator},${new_runtime}"
echo "HBA_BACKUP=${backup}"

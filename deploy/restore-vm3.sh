#!/usr/bin/env bash
set -euo pipefail

root=/opt/corestack/apps/hotelancla
backup_dir="$root/backups"
env_file="$root/secrets/migrator.env"
dump=${1:?Uso: restore-vm3.sh /opt/corestack/apps/hotelancla/backups/archivo.dump}
[[ -f $env_file && -f $dump && -f $dump.sha256 ]] || {
  echo 'Falta el dump, su checksum o migrator.env' >&2; exit 1;
}
[[ $(realpath -m "$dump") == "$backup_dir/"* ]] || {
  echo 'El dump debe estar en backups del hotel' >&2; exit 1;
}
(cd "$backup_dir" && sha256sum -c "$(basename "$dump").sha256")

docker run --rm --network host \
  --env-file "$env_file" \
  -v "$backup_dir:/backup:ro" \
  postgres:17-alpine sh -ec '
    conn="${PG_DUMP_URL%%\?*}?sslmode=require"
    export PGCONNECT_TIMEOUT=12
    test "$(psql "$conn" -XAtc "SELECT current_database()")" = hotelancla_production || {
      echo "La conexión no apunta a la base del hotel" >&2; exit 1;
    }
    test "$(psql "$conn" -XAtc "SELECT count(*) FROM pg_tables WHERE schemaname=current_schema()")" = 0 || {
      echo "La base destino no está vacía; no se sobrescribió" >&2; exit 1;
    }
    pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl \
      --dbname="$conn" "/backup/$1"
    psql "$conn" -X -v ON_ERROR_STOP=1 <<SQL
GRANT USAGE ON SCHEMA public TO hotelancla_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hotelancla_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO hotelancla_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hotelancla_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelancla_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hotelancla_runtime;
SQL
    psql "$conn" -XAtc "SELECT (SELECT count(*) FROM public.\"HotelRoom\"), (SELECT count(*) FROM public.\"HotelGuest\"), (SELECT count(*) FROM public.\"HotelReservation\");"
  ' sh "$(basename "$dump")"

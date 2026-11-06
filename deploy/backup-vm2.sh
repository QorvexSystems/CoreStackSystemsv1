#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/corestack/apps/solucionesautomotrizcyr
env_file="$root/secrets/migrator.env"
backup_dir="$root/backups"
[[ -f "$env_file" ]] || { echo 'Falta migrator.env' >&2; exit 1; }
install -d -m 700 "$backup_dir"
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || exit 0

name="solucionesautomotrizcyr-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$backup_dir/$name.part"
trap 'rm -f "$partial"' EXIT

docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  --env-file "$env_file" \
  -v "$backup_dir:/backup" \
  postgres:17-alpine \
  sh -ec 'pg_dump --format=custom --no-owner --no-acl --schema=public --file "/backup/$1" "$PG_DUMP_URL"' \
  sh "$name.part"

mv "$partial" "$backup_dir/$name"
(cd "$backup_dir" && sha256sum "$name" > "$name.sha256")
find "$backup_dir" -maxdepth 1 -type f \( -name 'solucionesautomotrizcyr-*.dump' -o -name 'solucionesautomotrizcyr-*.dump.sha256' \) -mtime +30 -delete
echo "$backup_dir/$name"

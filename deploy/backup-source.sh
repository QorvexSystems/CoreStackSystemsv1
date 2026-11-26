#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/corestack/apps/hotelancla
source_env="$root/repo/Hotel/.env"
backup_dir="$root/backups"
[[ -f "$source_env" ]] || { echo 'Falta el .env de origen' >&2; exit 1; }
install -d -m 700 "$backup_dir"

name="hotelancla-supabase-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$backup_dir/$name.part"
trap 'rm -f "$partial"' EXIT

docker run --rm --network host \
  --user "$(id -u):$(id -g)" \
  -v "$source_env:/run/source.env:ro" \
  -v "$backup_dir:/backup" \
  postgres:17-alpine sh -ec '
    conn=$(sed -n '\''s/^DIRECT_URL="\([^"]*\)".*/\1/p'\'' /run/source.env | head -n 1)
    test -n "$conn" || { echo "Falta DIRECT_URL en origen" >&2; exit 1; }
    export PGCONNECT_TIMEOUT=12 PGSSLMODE=require
    pg_dump --format=custom --no-owner --no-acl --schema=public --file="/backup/$1" "$conn"
  ' sh "$name.part"

mv "$partial" "$backup_dir/$name"
chmod 600 "$backup_dir/$name"
(cd "$backup_dir" && sha256sum "$name" > "$name.sha256")
chmod 600 "$backup_dir/$name.sha256"
echo "$backup_dir/$name"

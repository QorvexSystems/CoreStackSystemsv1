#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly app_dir='/opt/corestack/apps/allpa'
readonly api_env="${app_dir}/secrets/api.env"
readonly deploy_env="${app_dir}/secrets/deploy.env"
readonly migrator_password="${app_dir}/secrets/db-migrator.password"
readonly source_url='https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip'

exec 9>"${app_dir}/secrets/dgii-sync.lock"
flock -n 9 || exit 0

for file in "$api_env" "$deploy_env" "$migrator_password"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "Falta archivo requerido: $file" >&2; exit 1; }
done

image_tag="${ALLPA_DGII_IMAGE_TAG:-$(awk -F= '$1 == "ALLPA_IMAGE_TAG" { print substr($0, index($0, "=") + 1); exit }' "$deploy_env")}"
[[ "$image_tag" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || { echo 'ALLPA_IMAGE_TAG inválido.' >&2; exit 1; }

work_dir="$(mktemp -d /tmp/allpa-dgii-sync.XXXXXX)"
chmod 0700 "$work_dir"
trap 'rm -rf -- "$work_dir"' EXIT

curl --fail --silent --show-error --retry 3 --retry-all-errors \
  --connect-timeout 15 --max-time 300 --max-filesize 67108864 --proto '=https' \
  --user-agent 'Mozilla/5.0 (compatible; CoreStack-ALLPA-DGII-Sync/1.0)' \
  --dump-header "$work_dir/headers" --output "$work_dir/DGII_RNC.zip" "$source_url"

archive_size="$(stat -c '%s' "$work_dir/DGII_RNC.zip")"
[[ "$archive_size" -ge 1048576 && "$archive_size" -le 67108864 ]] || {
  echo 'ZIP oficial fuera del rango esperado.' >&2; exit 1;
}

http_date="$(awk 'tolower($0) ~ /^last-modified:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); value = $0 } END { print value }' "$work_dir/headers")"
[[ -n "$http_date" ]] || { echo 'DGII no informó Last-Modified.' >&2; exit 1; }
source_updated_at="$(date -u -d "$http_date" '+%Y-%m-%dT%H:%M:%SZ')"

python3 - "$work_dir/DGII_RNC.zip" "$work_dir/DGII_RNC.TXT" <<'PY'
import shutil
import sys
import zipfile
from pathlib import PurePosixPath

with zipfile.ZipFile(sys.argv[1]) as archive:
    files = [entry for entry in archive.infolist() if not entry.is_dir()]
    if len(files) != 1:
        raise SystemExit('El ZIP debe contener exactamente un archivo.')
    entry = files[0]
    path = PurePosixPath(entry.filename.replace('\\', '/'))
    if path.is_absolute() or '..' in path.parts or path.name.upper() != 'DGII_RNC.TXT':
        raise SystemExit('El ZIP contiene una ruta inesperada.')
    if not 50_000_000 <= entry.file_size <= 250_000_000:
        raise SystemExit('El TXT oficial está fuera del rango esperado.')
    with archive.open(entry) as source, open(sys.argv[2], 'wb') as target:
        shutil.copyfileobj(source, target)
PY

chmod 0644 "$work_dir/DGII_RNC.TXT"
docker run --rm --pull never --network container:allpa-api \
  --env-file "$api_env" --user 0 \
  --cpus 1 --memory 768m --memory-swap 768m --pids-limit 128 \
  --read-only --tmpfs /tmp:size=64m,mode=1777 \
  --volume "$work_dir/DGII_RNC.TXT:/production-import/DGII_RNC.TXT:ro" \
  --volume "$migrator_password:/run/secrets/db-migrator.password:ro" \
  --entrypoint node "corestack/allpa-api:${image_tag}" \
  apps/api/dist/cli/import-dgii-registry.js \
  --file /production-import/DGII_RNC.TXT \
  --source-updated-at "$source_updated_at" \
  --migrator-password-file /run/secrets/db-migrator.password

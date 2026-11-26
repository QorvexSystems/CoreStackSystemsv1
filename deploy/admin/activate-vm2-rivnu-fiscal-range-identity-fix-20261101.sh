#!/usr/bin/env bash
# Correct the fixed production tenant route and deploy the Dominican-ID API fix with rollback.
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly secrets="$root/secrets"
readonly api_env="$secrets/api.env"
readonly deploy_env="$secrets/deploy.env"
readonly route_dir="$secrets/fiscal-range-registration"
readonly routes="$route_dir/routes.json"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly compose_hash='fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc'
readonly old_tag='range-sync-20261101'
readonly new_tag='range-identity-fix-20261101'
readonly old_api_id='sha256:838ce8fcb9e0a859a7c8bd2d0cade22085f2abc37707c0243a21555e99b813da'
readonly new_api_id='sha256:eaba9aedd2cf8414c454b8fc8f45cccc0d60fb8fa022a165ef3546724c2fb21b'
readonly web_id='sha256:b7934e3bc141c7e311e1afc72b0ba455d32b56f25722fd57126abab10be10eca'
readonly old_tenant='cmt397emm0002nm0ogb50l2q6'
readonly new_tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly backup="/opt/corestack/backups/rivnu-range-identity-fix-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
write_env() {
  local source=$1 key=$2 value=$3 temporary
  temporary=$(mktemp "$(dirname "$source")/.${key}.XXXXXX")
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    index($0,key "=")==1 { if (!found) print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$source" >"$temporary"
  chown --reference="$source" "$temporary"
  chmod --reference="$source" "$temporary"
  mv -T "$temporary" "$source"
}
validate_route() {
  local expected_tenant=$1
  python3 - "$routes" "$expected_tenant" "$rnc" <<'PY'
import json, sys
path, tenant, rnc = sys.argv[1:]
with open(path, encoding='utf-8') as handle:
    value = json.load(handle)
expected = {
    'version': 1,
    'routes': [{
        'tenantId': tenant,
        'issuerRnc': rnc,
        'origin': 'https://10.0.0.1:4083',
        'tokenFile': '/run/secrets/fiscal-range-registration/rivnu.token',
        'caFile': '/run/secrets/fiscal-range-registration/rivnu-ca.crt',
    }],
}
raise SystemExit(0 if value == expected else 1)
PY
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM2-APP' ]] || fail 'RUN_WITH_SUDO_ON_VM2'
[[ -f "$compose" && ! -L "$compose" && "$(sha256sum "$compose" | cut -d' ' -f1)" == "$compose_hash" ]] || fail 'PRODUCTION_COMPOSE_HASH_MISMATCH'
for file in "$api_env" "$deploy_env"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%u:%g:%a' "$file")" == '1006:1008:600' ]] || fail 'APPLICATION_ENV_INVALID'
done
[[ "$(env_value "$deploy_env" RIVNU_IMAGE_TAG)" == "$old_tag" ]] || fail 'UNEXPECTED_ACTIVE_IMAGE_TAG'
[[ "$(env_value "$api_env" FISCAL_RANGE_REGISTRATION_ROUTES_FILE)" == '/run/secrets/fiscal-range-registration/routes.json' ]] || fail 'RANGE_ROUTE_ENV_INVALID'
[[ "$(docker image inspect "corestack/rivnu-api:$new_tag" --format '{{.Id}}')" == "$new_api_id" ]] || fail 'NEW_API_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "corestack/rivnu-web:$new_tag" --format '{{.Id}}')" == "$web_id" ]] || fail 'NEW_WEB_IMAGE_ID_MISMATCH'
[[ "$(docker inspect rivnu-api --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$old_api_id|running|healthy" ]] || fail 'CURRENT_API_NOT_EXPECTED'
[[ "$(docker inspect rivnu-web --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$web_id|running|healthy" ]] || fail 'CURRENT_WEB_NOT_EXPECTED'
[[ -d "$route_dir" && ! -L "$route_dir" && "$(stat -c '%u:%g:%a' "$route_dir")" == '0:1000:2750' ]] || fail 'RANGE_ROUTE_DIRECTORY_INVALID'
for file in routes.json rivnu.token rivnu-ca.crt; do
  [[ -f "$route_dir/$file" && ! -L "$route_dir/$file" && -s "$route_dir/$file" && "$(stat -c '%u:%g:%a' "$route_dir/$file")" == '0:1000:440' ]] || fail 'RANGE_ROUTE_FILE_INVALID'
done
validate_route "$old_tenant" || fail 'CURRENT_RANGE_ROUTE_UNEXPECTED'

count=$(docker exec rivnu-api node -e 'const {PrismaClient}=require("/app/packages/database/dist/index.js");const p=new PrismaClient();p.electronicFiscalRange.count().then(v=>console.log(v)).finally(()=>p.$disconnect())')
[[ "$count" == '0' ]] || fail 'APPLICATION_ELECTRONIC_RANGES_NOT_EMPTY'

token=$(<"$route_dir/rivnu.token")
[[ "$token" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail 'RANGE_ROUTE_TOKEN_INVALID'
work=$(mktemp -d "$secrets/.rivnu-range-identity-fix.XXXXXX")
cleanup() {
  unset token
  rm -f -- "$work/curl.conf" "$work/routes.json"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
printf 'header = "Authorization: Bearer %s"\n' "$token" >"$work/curl.conf"
unset token
chmod 0600 "$work/curl.conf"
status=$(curl --config "$work/curl.conf" --silent --output /dev/null --write-out '%{http_code}' \
  --noproxy '*' --max-time 5 --cacert "$route_dir/rivnu-ca.crt" \
  --resolve rivnu-range-registration.internal:4083:10.0.0.1 \
  -X POST -H 'content-type: application/json' --data '{}' \
  https://rivnu-range-registration.internal:4083/internal/v1/authorized-ranges)
[[ "$status" == '422' ]] || fail 'RANGE_SERVICE_PREFLIGHT_FAILED'

install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$routes" "$backup/routes.json"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
cat >"$work/routes.json" <<JSON
{
  "version": 1,
  "routes": [
    {
      "tenantId": "$new_tenant",
      "issuerRnc": "$rnc",
      "origin": "https://10.0.0.1:4083",
      "tokenFile": "/run/secrets/fiscal-range-registration/rivnu.token",
      "caFile": "/run/secrets/fiscal-range-registration/rivnu-ca.crt"
    }
  ]
}
JSON
chown --reference="$routes" "$work/routes.json"
chmod --reference="$routes" "$work/routes.json"

activated='false'
rollback() {
  local result=$?
  if [[ "$activated" == 'true' ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/routes.json" "$routes" || true
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env" || true
    docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build rivnu-api rivnu-web >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_RANGE_IDENTITY_FIX_FAILED_ROLLED_BACK status=%s backup=%s\n' "$result" "$backup" >&2
}
trap rollback ERR

mv -T "$work/routes.json" "$routes"
validate_route "$new_tenant"
write_env "$deploy_env" RIVNU_IMAGE_TAG "$new_tag"
activated='true'
docker compose --env-file "$deploy_env" -f "$compose" config --quiet
docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build rivnu-api rivnu-web

for _ in $(seq 1 90); do
  api_health=$(docker inspect rivnu-api --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  web_health=$(docker inspect rivnu-web --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  [[ "$api_health" == 'running|healthy' && "$web_health" == 'running|healthy' ]] && break
  if [[ "$api_health" == *'|unhealthy' || "$web_health" == *'|unhealthy' ]]; then false; fi
  sleep 1
done
[[ "$(docker inspect rivnu-api --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$new_api_id|running|healthy" ]]
[[ "$(docker inspect rivnu-web --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$web_id|running|healthy" ]]
count=$(docker exec rivnu-api node -e 'const {PrismaClient}=require("/app/packages/database/dist/index.js");const p=new PrismaClient();p.electronicFiscalRange.count().then(v=>console.log(v)).finally(()=>p.$disconnect())')
[[ "$count" == '0' ]]
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
trap - ERR

printf 'RIVNU_RANGE_IDENTITY_FIX_ACTIVATED_HEALTHY_EMPTY backup=%s\n' "$backup"
printf 'API=%s\nWEB=%s\n' "$new_api_id" "$web_id"
printf '%s\n' 'No range, sequence, invoice, credential or DGII request was created.'

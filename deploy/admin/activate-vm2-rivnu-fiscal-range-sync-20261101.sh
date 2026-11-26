#!/usr/bin/env bash
# Activate the reviewed RIVNU range route and immutable API/Web images with rollback.
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly secrets="$root/secrets"
readonly api_env="$secrets/api.env"
readonly deploy_env="$secrets/deploy.env"
readonly route="$secrets/fiscal-range-registration"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly compose_hash='fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc'
readonly old_tag='a388b1aeba4a'
readonly new_tag='range-sync-20261101'
readonly api_image_id='sha256:838ce8fcb9e0a859a7c8bd2d0cade22085f2abc37707c0243a21555e99b813da'
readonly web_image_id='sha256:b7934e3bc141c7e311e1afc72b0ba455d32b56f25722fd57126abab10be10eca'
readonly routes_value='/run/secrets/fiscal-range-registration/routes.json'
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly backup="/opt/corestack/backups/rivnu-range-activation-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { printf '%s\n' "$1" >&2; exit 1; }
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
env_count() { grep -c "^$2=" "$1" || true; }
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

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM2-APP' ]] || fail 'RUN_WITH_SUDO_ON_VM2'
[[ -f "$compose" && ! -L "$compose" && "$(sha256sum "$compose" | cut -d' ' -f1)" == "$compose_hash" ]] || fail 'PRODUCTION_COMPOSE_HASH_MISMATCH'
for file in "$api_env" "$deploy_env"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%u:%g:%a' "$file")" == '1006:1008:600' ]] || fail 'APPLICATION_ENV_INVALID'
done
[[ "$(env_count "$api_env" FISCAL_RANGE_REGISTRATION_ROUTES_FILE)" -le 1 ]] || fail 'DUPLICATE_RANGE_ROUTE_ENV'
current_route=$(env_value "$api_env" FISCAL_RANGE_REGISTRATION_ROUTES_FILE)
[[ -z "$current_route" || "$current_route" == "$routes_value" ]] || fail 'UNEXPECTED_RANGE_ROUTE_ENV'
[[ "$(env_count "$deploy_env" RIVNU_IMAGE_TAG)" == '1' && "$(env_value "$deploy_env" RIVNU_IMAGE_TAG)" == "$old_tag" ]] || fail 'UNEXPECTED_ACTIVE_IMAGE_TAG'
[[ "$(docker image inspect "corestack/rivnu-api:$new_tag" --format '{{.Id}}')" == "$api_image_id" ]] || fail 'NEW_API_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "corestack/rivnu-web:$new_tag" --format '{{.Id}}')" == "$web_image_id" ]] || fail 'NEW_WEB_IMAGE_ID_MISMATCH'
[[ "$(docker inspect rivnu-api --format '{{.Config.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "corestack/rivnu-api:$old_tag|running|healthy" ]] || fail 'CURRENT_API_NOT_HEALTHY'
[[ "$(docker inspect rivnu-web --format '{{.Config.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "corestack/rivnu-web:$old_tag|running|healthy" ]] || fail 'CURRENT_WEB_NOT_HEALTHY'

[[ -d "$route" && ! -L "$route" && "$(stat -c '%u:%g:%a' "$route")" == '0:1000:2750' ]] || fail 'RANGE_ROUTE_DIRECTORY_INVALID'
for file in routes.json rivnu.token rivnu-ca.crt; do
  [[ -f "$route/$file" && ! -L "$route/$file" && -s "$route/$file" && "$(stat -c '%u:%g:%a' "$route/$file")" == '0:1000:440' ]] || fail 'RANGE_ROUTE_FILE_INVALID'
done
[[ "$(openssl x509 -in "$route/rivnu-ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)" == "$expected_ca" ]] || fail 'RANGE_ROUTE_CA_PIN_MISMATCH'
token=$(<"$route/rivnu.token")
[[ "$token" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail 'RANGE_ROUTE_TOKEN_INVALID'
work=$(mktemp -d "$secrets/.rivnu-range-activation.XXXXXX")
cleanup() {
  unset token
  rm -f -- "$work/curl.conf"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
printf 'header = "Authorization: Bearer %s"\n' "$token" >"$work/curl.conf"
unset token
chmod 0600 "$work/curl.conf"
status=$(curl --config "$work/curl.conf" --silent --output /dev/null --write-out '%{http_code}' \
  --noproxy '*' --max-time 5 --cacert "$route/rivnu-ca.crt" \
  --resolve rivnu-range-registration.internal:4083:10.0.0.1 \
  -X POST -H 'content-type: application/json' --data '{}' \
  https://rivnu-range-registration.internal:4083/internal/v1/authorized-ranges)
[[ "$status" == '422' ]] || fail 'RANGE_SERVICE_TOKEN_PREFLIGHT_FAILED'

install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$api_env" "$backup/api.env"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"

activated='false'
rollback() {
  local result=$?
  if [[ "$activated" == 'true' ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/api.env" "$api_env" || true
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env" || true
    docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build rivnu-api rivnu-web >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_RANGE_ACTIVATION_FAILED_ROLLED_BACK status=%s backup=%s\n' "$result" "$backup" >&2
}
trap rollback ERR

write_env "$api_env" FISCAL_RANGE_REGISTRATION_ROUTES_FILE "$routes_value"
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
[[ "$(docker inspect rivnu-api --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$api_image_id|running|healthy" ]]
[[ "$(docker inspect rivnu-web --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$web_image_id|running|healthy" ]]
docker exec rivnu-api sh -c 'test "$FISCAL_RANGE_REGISTRATION_ROUTES_FILE" = /run/secrets/fiscal-range-registration/routes.json && test -r "$FISCAL_RANGE_REGISTRATION_ROUTES_FILE" && test -r /run/secrets/fiscal-range-registration/rivnu.token && test -r /run/secrets/fiscal-range-registration/rivnu-ca.crt'
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:3001/login >/dev/null

trap - ERR
printf 'RIVNU_RANGE_SYNC_API_WEB_ACTIVATED_HEALTHY backup=%s\n' "$backup"
printf 'API=%s\nWEB=%s\n' "$api_image_id" "$web_image_id"
printf '%s\n' 'No range, sequence, invoice, signing job, delivery job or DGII request was created.'

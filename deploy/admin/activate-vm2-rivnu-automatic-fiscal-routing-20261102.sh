#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly secrets="$root/secrets"
readonly deploy_env="$secrets/deploy.env"
readonly api_env="$secrets/api.env"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly compose_hash='fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc'
readonly tag='automatic-fiscal-routing-20261102'
readonly api_image="corestack/rivnu-api:$tag"
readonly web_image="corestack/rivnu-web:$tag"
readonly api_id='sha256:22489526228d27b769c70937987071ec9784c6f3ec62ec833050023b3e751105'
readonly web_id='sha256:1ab140d3e4632e4b59dd1673e9705b7d62d943fa9e240c394fd8525ba57c6bc2'
readonly backup="/opt/corestack/backups/rivnu-automatic-fiscal-routing-$(date -u +%Y%m%dT%H%M%SZ)"

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

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM2-APP' ]] || fail RUN_WITH_SUDO_ON_VM2
[[ -f "$compose" && ! -L "$compose" && "$(sha256sum "$compose" | cut -d' ' -f1)" == "$compose_hash" ]] || fail PRODUCTION_COMPOSE_HASH_MISMATCH
for file in "$deploy_env" "$api_env"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%a' "$file")" == 600 ]] || fail "SECRET_FILE_INVALID_$file"
done
[[ "$(docker image inspect "$api_image" --format '{{.Id}}' 2>/dev/null)" == "$api_id" ]] || fail API_IMAGE_ID_MISMATCH
[[ "$(docker image inspect "$web_image" --format '{{.Id}}' 2>/dev/null)" == "$web_id" ]] || fail WEB_IMAGE_ID_MISMATCH
[[ "$(docker image inspect "$api_image" --format '{{.Config.User}}')" == node ]] || fail API_IMAGE_USER_INVALID
[[ "$(docker image inspect "$web_image" --format '{{.Config.User}}')" == node ]] || fail WEB_IMAGE_USER_INVALID
for container in rivnu-api rivnu-web; do
  [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]] || fail "CURRENT_CONTAINER_UNHEALTHY_$container"
done

# VM3 applies DDL with the dedicated migrator. The application credential is
# runtime-only; this check prevents activating code against an older schema.
docker run --rm --network rivnu-network --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --env-file "$api_env" --entrypoint /app/packages/database/node_modules/.bin/prisma \
  "$api_image" migrate status --schema /app/packages/database/prisma/schema.prisma

install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect rivnu-api >"$backup/rivnu-api.before.json"
docker inspect rivnu-web >"$backup/rivnu-web.before.json"
readonly previous_tag="$(env_value "$deploy_env" RIVNU_IMAGE_TAG)"
[[ -n "$previous_tag" ]] || fail ACTIVE_IMAGE_TAG_MISSING

activated=false
rollback() {
  local result=$?
  if [[ "$activated" == true ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env" || true
    docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_AUTOMATIC_FISCAL_ROUTING_ACTIVATION_FAILED_ROLLED_BACK status=%s backup=%s\n' "$result" "$backup" >&2
}
trap rollback ERR
write_env "$deploy_env" RIVNU_IMAGE_TAG "$tag"
activated=true
docker compose --env-file "$deploy_env" -f "$compose" config --quiet
docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web

for container in rivnu-api rivnu-web; do
  for _ in $(seq 1 90); do
    health=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
    [[ "$health" == 'running|healthy' ]] && break
    [[ "$health" == *'|unhealthy' ]] && false
    sleep 1
  done
  [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
done
[[ "$(docker inspect rivnu-api --format '{{.Image}}')" == "$api_id" ]]
[[ "$(docker inspect rivnu-web --format '{{.Image}}')" == "$web_id" ]]
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:3001/login >/dev/null
docker logs --since 5m rivnu-api 2>&1 | grep -q 'ELECTRONIC_FISCAL_DISPATCH_DISABLED' && fail FISCAL_DISPATCH_ROUTE_NOT_ACTIVE
trap - ERR

printf 'RIVNU_AUTOMATIC_FISCAL_ROUTING_ACTIVATED backup=%s previous_tag=%s\n' "$backup" "$previous_tag"
printf 'API=%s\nWEB=%s\n' "$api_id" "$web_id"
printf '%s\n' 'No invoice, local reference, e-NCF reservation, payment or DGII request was created.'

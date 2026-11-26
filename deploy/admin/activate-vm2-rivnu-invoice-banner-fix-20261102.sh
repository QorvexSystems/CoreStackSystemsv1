#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly deploy_env="$root/secrets/deploy.env"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly compose_hash='fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc'
readonly previous_tag='ecf-valid-print-clean-20261102'
readonly tag='auto-fiscal-selection-20261102'
readonly api_image="corestack/rivnu-api:$tag"
readonly web_image="corestack/rivnu-web:$tag"
readonly api_id='sha256:da3827420c085b889dada9229875d36ac48c1fde91a60267893aa1d3f04b6db3'
readonly web_id='sha256:780ec5aa97b64cf67ec623b9fbb5e13607b323c95a4875018d9e3d292068b976'
readonly backup="/opt/corestack/backups/rivnu-auto-fiscal-selection-$(date -u +%Y%m%dT%H%M%SZ)"

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

[[ "$(hostname)" == 'VM2-APP' ]] || fail RUN_ON_VM2_APP
[[ "$(id -u)" -ne 0 ]] || fail RUN_AS_DEPLOY_USER_NOT_ROOT
[[ -f "$compose" && ! -L "$compose" ]] || fail PRODUCTION_COMPOSE_INVALID
[[ "$(sha256sum "$compose" | cut -d' ' -f1)" == "$compose_hash" ]] || fail PRODUCTION_COMPOSE_HASH_MISMATCH
[[ -f "$deploy_env" && ! -L "$deploy_env" && "$(stat -c '%a' "$deploy_env")" == 600 ]] || fail DEPLOY_ENV_INVALID
[[ "$(env_value "$deploy_env" RIVNU_IMAGE_TAG)" == "$previous_tag" ]] || fail UNEXPECTED_ACTIVE_IMAGE_TAG
[[ "$(docker image inspect "$api_image" --format '{{.Id}}')" == "$api_id" ]] || fail API_IMAGE_ID_MISMATCH
[[ "$(docker image inspect "$web_image" --format '{{.Id}}')" == "$web_id" ]] || fail WEB_IMAGE_ID_MISMATCH
[[ "$(docker image inspect "$api_image" --format '{{.Config.User}}')" == node ]] || fail API_IMAGE_USER_INVALID
[[ "$(docker image inspect "$web_image" --format '{{.Config.User}}')" == node ]] || fail WEB_IMAGE_USER_INVALID

for container in rivnu-api rivnu-web; do
  [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]] || fail "CURRENT_CONTAINER_UNHEALTHY_$container"
done

install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect rivnu-api >"$backup/rivnu-api.before.json"
docker inspect rivnu-web >"$backup/rivnu-web.before.json"

activated=false
rollback() {
  local result=$1 failed_line=$2 failed_command=$3
  if [[ "$activated" == true ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env" || true
    docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_AUTO_FISCAL_SELECTION_FAILED_ROLLED_BACK status=%s line=%s command=%q backup=%s\n' \
    "$result" "$failed_line" "$failed_command" "$backup" >&2
}
trap 'rollback "$?" "$LINENO" "$BASH_COMMAND"' ERR

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
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' http://10.0.0.3:4001/health)" == 200 ]]
web_status=$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' http://10.0.0.3:3001/login)
[[ "$web_status" =~ ^[23] ]]
docker logs --since 3m rivnu-api 2>&1 | grep -Eq 'ERROR|FATAL|ELECTRONIC_FISCAL_DISPATCH_DISABLED' && fail API_RUNTIME_ERROR

trap - ERR
printf 'RIVNU_AUTO_FISCAL_SELECTION_ACTIVATED backup=%s\n' "$backup"
printf 'API=%s\nWEB=%s\n' "$api_id" "$web_id"
printf '%s\n' 'No invoice, sequence, payment, inventory movement or DGII request was created.'

#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly compose="$root/repo/CoreStackSystemsv1/deploy/docker/compose.production.yml"
readonly deploy_env="$root/secrets/deploy.env"
readonly api_image='corestack/rivnu-api:printed-representation-autoprint-20261102'
readonly web_image='corestack/rivnu-web:printed-representation-autoprint-20261102'
readonly api_id='sha256:f1692847e03828960d515e205dba1c3bcbe106db5981ec5a3f728dd1fb47eb46'
readonly web_id='sha256:680ea80763fee8f23e4115dbfd41446ef2bb9e85056f7ba0247aaaa59ee5bb3b'
readonly tag='printed-representation-autoprint-20261102'
readonly backup="/opt/corestack/backups/rivnu-printed-representation-app-$(date -u +%Y%m%dT%H%M%SZ)"
fail(){ printf '%s\n' "$1" >&2; exit 1; }
write_env(){
 local source=$1 key=$2 value=$3 temporary
 temporary=$(mktemp "$(dirname "$source")/.${key}.XXXXXX")
 awk -v key="$key" -v value="$value" 'BEGIN{found=0} index($0,key "=")==1{if(!found)print key "=" value;found=1;next}{print} END{if(!found)print key "=" value}' "$source" >"$temporary"
 chown --reference="$source" "$temporary"; chmod --reference="$source" "$temporary"; mv -T "$temporary" "$source"
}
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM2-APP' ]] || fail RUN_WITH_SUDO_ON_VM2
[[ -f "$compose" && ! -L "$compose" && -f "$deploy_env" && ! -L "$deploy_env" ]] || fail ACTIVE_CONFIG_INVALID
[[ "$(docker image inspect "$api_image" --format '{{.Id}}')" == "$api_id" ]] || fail API_IMAGE_INVALID
[[ "$(docker image inspect "$web_image" --format '{{.Id}}')" == "$web_id" ]] || fail WEB_IMAGE_INVALID
for container in rivnu-api rivnu-web; do
 [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]] || fail "CURRENT_CONTAINER_UNHEALTHY_$container"
done
install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect rivnu-api >"$backup/api.before.json"
docker inspect rivnu-web >"$backup/web.before.json"
activated=false
rollback(){
 local status=$?
 if [[ "$activated" == true ]]; then
  cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env" || true
  docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web >/dev/null 2>&1 || true
 fi
 printf 'RIVNU_PRINTED_REPRESENTATION_VM2_FAILED_ROLLED_BACK status=%s backup=%s\n' "$status" "$backup" >&2
}
trap rollback ERR
write_env "$deploy_env" RIVNU_IMAGE_TAG "$tag"
activated=true
docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web
for container in rivnu-api rivnu-web; do
 for _ in $(seq 1 90); do
  state=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  [[ "$state" == 'running|healthy' ]] && break
  [[ "$state" == *'|unhealthy' ]] && false
  sleep 1
 done
 [[ "$(docker inspect "$container" --format '{{.State.Status}}|{{.State.Health.Status}}')" == 'running|healthy' ]]
done
[[ "$(docker inspect rivnu-api --format '{{.Image}}')" == "$api_id" ]]
[[ "$(docker inspect rivnu-web --format '{{.Image}}')" == "$web_id" ]]
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:3001/login >/dev/null
docker logs --since 3m rivnu-api 2>&1 | grep -q 'ELECTRONIC_FISCAL_DISPATCH_DISABLED' && fail FISCAL_DISPATCH_DISABLED
trap - ERR
printf 'RIVNU_PRINTED_REPRESENTATION_VM2_ACTIVATED backup=%s\n' "$backup"
printf 'API=%s\nWEB=%s\n' "$api_id" "$web_id"
printf '%s\n' 'No invoice or DGII request was created.'

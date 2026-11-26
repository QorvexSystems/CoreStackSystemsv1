#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
printf '%s\n' 'RETIRED: certification is an internal CoreStack CLI, not a RIVNU module.' >&2
exit 1
readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly deploy_env="$root/secrets/deploy.env"
readonly api_env="$root/secrets/api.env"
readonly tag='certification-agent-20261104-final'
readonly api="corestack/rivnu-api:$tag"
readonly web="corestack/rivnu-web:$tag"
readonly api_id='sha256:8fcd3e3a88408566a4a28566d1037d4125a4d9787353e910922cd3574b07ff81'
readonly web_id='sha256:acd9745979d533ba35b22c438b354a6ebbbe777078b32565d5f86f1fd883f7ec'
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $EUID == 0 && "$(hostname)" == VM2-APP ]] || fail RUN_WITH_SUDO_ON_VM2
[[ "$(sha256sum "$compose" | cut -d' ' -f1)" == fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc ]] || fail COMPOSE_REVIEW_REQUIRED
for file in "$deploy_env" "$api_env"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%a' "$file")" == 600 ]] || fail SECRET_METADATA_INVALID
done
[[ "$(docker image inspect "$api" --format '{{.Id}}')" == "$api_id" ]] || fail API_IMAGE_HASH_MISMATCH
[[ "$(docker image inspect "$web" --format '{{.Id}}')" == "$web_id" ]] || fail WEB_IMAGE_HASH_MISMATCH
for image in "$api" "$web"; do
  [[ "$(docker image inspect "$image" --format '{{.Config.User}}')" == node ]] || fail NON_ROOT_IMAGE_REQUIRED
done
docker run --rm --network rivnu-network --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --env-file "$api_env" --entrypoint /app/packages/database/node_modules/.bin/prisma \
  "$api" migrate status --schema /app/packages/database/prisma/schema.prisma
readonly backup="/opt/corestack/backups/certification-agent-app-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect rivnu-api >"$backup/api.before.json"
docker inspect rivnu-web >"$backup/web.before.json"
activated=false
rollback() {
  local status=$?
  if [[ "$activated" == true ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env"
    docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web || true
  fi
  printf 'CERTIFICATION_AGENT_ACTIVATION_ROLLED_BACK status=%s backup=%s\n' "$status" "$backup" >&2
}
trap rollback ERR
temporary=$(mktemp "$root/secrets/.certification-agent-deploy.XXXXXX")
awk -v tag="$tag" 'BEGIN{found=0} /^RIVNU_IMAGE_TAG=/{if(!found)print "RIVNU_IMAGE_TAG="tag;found=1;next} {print} END{if(!found)print "RIVNU_IMAGE_TAG="tag}' "$deploy_env" >"$temporary"
chmod --reference="$deploy_env" "$temporary"
chown --reference="$deploy_env" "$temporary"
mv -T "$temporary" "$deploy_env"
activated=true
docker compose --env-file "$deploy_env" -f "$compose" config --quiet
docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web
for container in rivnu-api rivnu-web; do
  for attempt in $(seq 1 100); do
    health=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}')
    [[ "$health" == 'running|healthy' ]] && break
    [[ "$health" != *'|unhealthy' && "$attempt" != 100 ]] || fail APPLICATION_HEALTH_FAILED
    sleep 1
  done
done
[[ "$(docker inspect rivnu-api --format '{{.Image}}')" == "$api_id" ]] || fail ACTIVE_API_HASH_MISMATCH
[[ "$(docker inspect rivnu-web --format '{{.Image}}')" == "$web_id" ]] || fail ACTIVE_WEB_HASH_MISMATCH
docker logs --since 3m rivnu-api 2>&1 | grep CERTIFICATION_AGENT_STARTED >/dev/null || fail CERTIFICATION_AGENT_NOT_STARTED
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
trap - ERR
printf 'CERTIFICATION_AGENT_VM2_ACTIVATED backup=%s\n' "$backup"
printf '%s\n' 'No client certification was started; no range, invoice or DGII submission was created.'

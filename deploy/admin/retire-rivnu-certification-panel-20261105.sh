#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
readonly root='/opt/corestack/apps/rivnu'
readonly compose="$root/repo/CoreStackSystemsv1/deploy/docker/compose.production.yml"
readonly env_file="$root/secrets/deploy.env"
readonly clean_tag='unified-fiscal-ui-20261102'
readonly clean_api='sha256:3d3dbba145fb4e3ccfa8c773635001357162ea303595d5ec75c5e6b3354e0297'
readonly clean_web='sha256:435a670dc7588ebd67e0e8d9ee2ebaf04fa03186dff0ff06b6ea6c10fc9e3b51'
fail() { printf '%s\n' "$1" >&2; return 1; }
[[ $EUID == 0 && "$(hostname)" == VM2-APP ]] || fail RUN_WITH_SUDO_ON_VM2
[[ -f "$env_file" && ! -L "$env_file" ]] || fail DEPLOY_ENV_INVALID
[[ "$(sha256sum "$compose" | cut -d' ' -f1)" == fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc ]] || fail COMPOSE_REVIEW_REQUIRED
[[ "$(docker image inspect corestack/rivnu-api:$clean_tag --format '{{.Id}}')" == "$clean_api" ]] || fail CLEAN_API_IMAGE_MISSING
[[ "$(docker image inspect corestack/rivnu-web:$clean_tag --format '{{.Id}}')" == "$clean_web" ]] || fail CLEAN_WEB_IMAGE_MISSING
current=$(docker inspect rivnu-api --format '{{.Config.Image}}')
[[ "$current" == corestack/rivnu-api:certification-agent-20261104-final || "$current" == corestack/rivnu-api:$clean_tag ]] || fail UNEXPECTED_ACTIVE_RELEASE_REVIEW_REQUIRED
readonly backup="/opt/corestack/backups/retire-client-certification-panel-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$env_file" "$backup/deploy.env"
docker inspect rivnu-api >"$backup/api.before.json"
docker inspect rivnu-web >"$backup/web.before.json"
rollback() {
  local status=$?
  cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$env_file"
  docker compose --env-file "$env_file" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web || true
  printf 'RETIREMENT_ROLLED_BACK status=%s backup=%s\n' "$status" "$backup" >&2
}
trap rollback ERR
temporary=$(mktemp "$root/secrets/.retire-certification.XXXXXX")
awk -v tag="$clean_tag" 'BEGIN{found=0} /^RIVNU_IMAGE_TAG=/{if(!found)print "RIVNU_IMAGE_TAG="tag;found=1;next} {print} END{if(!found)print "RIVNU_IMAGE_TAG="tag}' "$env_file" >"$temporary"
chmod --reference="$env_file" "$temporary"
chown --reference="$env_file" "$temporary"
mv -T "$temporary" "$env_file"
docker compose --env-file "$env_file" -f "$compose" up -d --no-build --pull never rivnu-api rivnu-web
for container in rivnu-api rivnu-web; do
  for attempt in $(seq 1 100); do
    health=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}')
    [[ "$health" == 'running|healthy' ]] && break
    [[ "$attempt" != 100 && "$health" != *'|unhealthy' ]] || fail APPLICATION_UNHEALTHY
    sleep 1
  done
done
[[ "$(docker inspect rivnu-api --format '{{.Image}}')" == "$clean_api" ]] || fail ACTIVE_API_MISMATCH
[[ "$(docker inspect rivnu-web --format '{{.Image}}')" == "$clean_web" ]] || fail ACTIVE_WEB_MISMATCH
docker exec rivnu-web test ! -e '/app/apps/web/.next/server/app/settings/electronic-certifications/page.js'
docker exec rivnu-api test ! -e '/app/apps/api/dist/modules/certification-orchestrator'
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
trap - ERR
printf 'RIVNU_CERTIFICATION_PANEL_AND_AGENT_RETIRED backup=%s\n' "$backup"
printf '%s\n' 'No database migration was reversed; no invoice, range, fiscal service, credential or DGII record was altered.'

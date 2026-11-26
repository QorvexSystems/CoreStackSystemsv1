#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly deploy_env="$root/secrets/deploy.env"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly tag='cashier-print-discard-20261112'
readonly api_id='sha256:ad8cebea0dd2684bd75bb5828619b58c43ff4b2b968fd994e8c309e87b014094'
readonly web_id='sha256:a29097976c974a482d7cfc56362220210422b823148229ec6ebba8949d337bef'
readonly backup="/opt/corestack/backups/rivnu-cashier-print-discard-$(date -u +%Y%m%dT%H%M%SZ)"
fail() { printf '%s\n' "$1" >&2; exit 1; }
dc() { docker compose --env-file "$deploy_env" -f "$compose" "$@"; }
health() {
  local name="$1" state
  for _ in $(seq 1 90); do
    state=$(docker inspect "$name" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}')
    [[ "$state" == 'running|healthy' ]] && return 0
    [[ "$state" == *'|unhealthy' || "$state" == 'exited|'* ]] && return 1
    sleep 1
  done
  return 1
}

[[ "$(hostname)" == VM2-APP ]] || fail RUN_ON_VM2
[[ -f "$deploy_env" && ! -L "$deploy_env" && -w "$deploy_env" ]] || fail DEPLOY_ENV_NOT_WRITABLE
[[ "$(stat -c '%a' "$deploy_env")" == 600 ]] || fail DEPLOY_ENV_PERMISSIONS_INVALID
[[ "$(sha256sum "$compose" | cut -d' ' -f1)" == fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc ]] || fail COMPOSE_REVIEW_REQUIRED
[[ "$(docker image inspect "corestack/rivnu-api:$tag" --format '{{.Id}}')" == "$api_id" ]] || fail API_IMAGE_MISMATCH
[[ "$(docker image inspect "corestack/rivnu-web:$tag" --format '{{.Id}}')" == "$web_id" ]] || fail WEB_IMAGE_MISMATCH
for container in rivnu-api rivnu-web; do health "$container" || fail "CURRENT_SERVICE_UNHEALTHY_$container"; done
current_api=$(docker inspect rivnu-api --format '{{.Image}}')
current_web=$(docker inspect rivnu-web --format '{{.Image}}')
[[ "$current_api" == sha256:3d3dbba145fb4e3ccfa8c773635001357162ea303595d5ec75c5e6b3354e0297 || "$current_api" == "$api_id" ]] || fail CURRENT_API_RELEASE_REVIEW_REQUIRED
[[ "$current_web" == sha256:435a670dc7588ebd67e0e8d9ee2ebaf04fa03186dff0ff06b6ea6c10fc9e3b51 || "$current_web" == "$web_id" ]] || fail CURRENT_WEB_RELEASE_REVIEW_REQUIRED

install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect rivnu-api >"$backup/rivnu-api.before.json"
docker inspect rivnu-web >"$backup/rivnu-web.before.json"

activated=false
temporary=''
rollback() {
  local result=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env"
    dc up -d --no-build --pull never rivnu-api rivnu-web || true
    health rivnu-api && health rivnu-web || true
  fi
  printf 'RIVNU_CASHIER_PRINT_DISCARD_FAILED_ROLLBACK_REQUESTED status=%s backup=%s\n' "$result" "$backup" >&2
  exit "$result"
}
trap rollback ERR
temporary=$(mktemp "$root/secrets/.rivnu-cashier-print-discard.XXXXXX")
awk -v tag="$tag" '
  BEGIN { found=0 }
  /^RIVNU_IMAGE_TAG=/ { if (!found) print "RIVNU_IMAGE_TAG=" tag; found=1; next }
  { print }
  END { if (!found) print "RIVNU_IMAGE_TAG=" tag }
' "$deploy_env" >"$temporary"
chmod --reference="$deploy_env" "$temporary"
chown --reference="$deploy_env" "$temporary"
activated=true
mv -T "$temporary" "$deploy_env"
dc config --quiet
dc up -d --no-build --pull never rivnu-api rivnu-web
health rivnu-api
health rivnu-web
[[ "$(docker inspect rivnu-api --format '{{.Image}}')" == "$api_id" ]]
[[ "$(docker inspect rivnu-web --format '{{.Image}}')" == "$web_id" ]]
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' http://10.0.0.3:4001/health)" == 200 ]]
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' http://10.0.0.3:3001/login)" == 200 ]]
trap - ERR
printf 'RIVNU_CASHIER_PRINT_DISCARD_ACTIVATED_HEALTHY backup=%s\n' "$backup"
printf 'API=%s\nWEB=%s\n' "$api_id" "$web_id"
printf '%s\n' 'No migration or test sale was run; no invoice, fiscal number or payment was deleted.'

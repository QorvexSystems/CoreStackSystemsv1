#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

root='/opt/corestack/apps/allpa'
repo="$root/repo/CoreStackSystemsv1"
deploy_env="$root/secrets/deploy.env"
compose="$repo/deploy/docker/compose.production.yml"
tag='quotations-20261113'
api_id='sha256:591192261e197775e7983878951f16ed3acdc588bdc4fe7dfec1678175b118ae'
web_id='sha256:a30742034cd12d2bb069bc9dd2eca98d7e8003c2a5649bfa6e1810e056b46509'
backup="/opt/corestack/backups/allpa-quotations-$(date -u +%Y%m%dT%H%M%SZ)"

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

[[ "$(hostname)" == VM2-APP ]]
[[ -f "$deploy_env" && ! -L "$deploy_env" && -w "$deploy_env" ]]
[[ "$(stat -c '%a' "$deploy_env")" == 600 ]]
[[ "$(docker image inspect "corestack/allpa-api:$tag" --format '{{.Id}}')" == "$api_id" ]]
[[ "$(docker image inspect "corestack/allpa-web:$tag" --format '{{.Id}}')" == "$web_id" ]]
health allpa-api
health allpa-web

install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect allpa-api >"$backup/allpa-api.before.json"
docker inspect allpa-web >"$backup/allpa-web.before.json"

activated=false
rollback() {
  local result=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env"
    dc up -d --no-deps --no-build --pull never allpa-api allpa-web || true
    health allpa-api && health allpa-web || true
  fi
  printf 'ALLPA_QUOTATIONS_FAILED_ROLLBACK_REQUESTED status=%s backup=%s\n' "$result" "$backup" >&2
  exit "$result"
}
trap rollback ERR

temporary=$(mktemp "$root/secrets/.allpa-quotations.XXXXXX")
awk -v tag="$tag" '
  BEGIN { found=0 }
  /^ALLPA_IMAGE_TAG=/ { if (!found) print "ALLPA_IMAGE_TAG=" tag; found=1; next }
  { print }
  END { if (!found) print "ALLPA_IMAGE_TAG=" tag }
' "$deploy_env" >"$temporary"
chmod --reference="$deploy_env" "$temporary"
chown --reference="$deploy_env" "$temporary"
activated=true
mv -T "$temporary" "$deploy_env"
dc config --quiet
dc up -d --no-deps --no-build --pull never allpa-api allpa-web
health allpa-api
health allpa-web
[[ "$(docker inspect allpa-api --format '{{.Image}}')" == "$api_id" ]]
[[ "$(docker inspect allpa-web --format '{{.Image}}')" == "$web_id" ]]
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' http://10.0.0.3:4002/health)" == 200 ]]
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' http://10.0.0.3:3002/login)" == 200 ]]
trap - ERR
printf 'ALLPA_QUOTATIONS_ACTIVATED_HEALTHY backup=%s\n' "$backup"

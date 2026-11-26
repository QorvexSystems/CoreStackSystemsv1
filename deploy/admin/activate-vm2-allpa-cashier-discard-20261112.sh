#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/allpa'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly deploy_env="$root/secrets/deploy.env"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly tag='cashier-discard-20261112'
readonly api_id='sha256:ed9d01e74c9522e65470f084dc922d4a07ebeaa0395187247d95da82a7d64492'
readonly web_id='sha256:b8afa5cc38fd2afb9f38335251a135c2144ebf0fc1042e9eaea466a4e3ccc082'
readonly backup="/opt/corestack/backups/allpa-cashier-discard-$(date -u +%Y%m%dT%H%M%SZ)"
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
[[ "$(sha256sum "$compose" | cut -d' ' -f1)" == 2e222c7e5c01f3768b47627ef450e7ecf33163f507206b9f5ae6d1017974a2ea ]] || fail COMPOSE_REVIEW_REQUIRED
[[ "$(docker image inspect "corestack/allpa-api:$tag" --format '{{.Id}}')" == "$api_id" ]] || fail API_IMAGE_MISMATCH
[[ "$(docker image inspect "corestack/allpa-web:$tag" --format '{{.Id}}')" == "$web_id" ]] || fail WEB_IMAGE_MISMATCH
docker run --rm --network none --entrypoint openssl "corestack/allpa-api:$tag" version >/dev/null || fail API_OPENSSL_RUNTIME_MISSING
for container in allpa-api allpa-web; do health "$container" || fail "CURRENT_SERVICE_UNHEALTHY_$container"; done
current_api=$(docker inspect allpa-api --format '{{.Image}}')
current_web=$(docker inspect allpa-web --format '{{.Image}}')
[[ "$current_api" == sha256:fbaceecb843ffa23c9db7730ecf1e840e700f7fc389b58440fe2f42d627444b4 || "$current_api" == "$api_id" ]] || fail CURRENT_API_RELEASE_REVIEW_REQUIRED
[[ "$current_web" == sha256:6f617db3216e9494cd26962a8db97ee1b681e89e70978a3a6467cd2bc2123d87 || "$current_web" == "$web_id" ]] || fail CURRENT_WEB_RELEASE_REVIEW_REQUIRED

install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect allpa-api >"$backup/allpa-api.before.json"
docker inspect allpa-web >"$backup/allpa-web.before.json"

activated=false
rollback() {
  local result=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    docker logs --tail 100 allpa-api >"$backup/allpa-api.failure.log" 2>&1 || true
    docker logs --tail 100 allpa-web >"$backup/allpa-web.failure.log" 2>&1 || true
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env"
    dc up -d --no-deps --no-build --pull never allpa-api allpa-web || true
    health allpa-api && health allpa-web || true
  fi
  printf 'ALLPA_CASHIER_DISCARD_FAILED_ROLLBACK_REQUESTED status=%s backup=%s\n' "$result" "$backup" >&2
  exit "$result"
}
trap rollback ERR
temporary=$(mktemp "$root/secrets/.allpa-cashier-discard.XXXXXX")
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
printf 'ALLPA_CASHIER_DISCARD_ACTIVATED_HEALTHY backup=%s\n' "$backup"
printf 'API=%s\nWEB=%s\n' "$api_id" "$web_id"
printf '%s\n' 'No migration or real order cancellation was run; no invoice, payment or fiscal number was deleted.'

#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly tenant="${1:-}"
readonly tag='e31-identity-20261112'
case "$tenant" in
  allpa)
    readonly root='/opt/corestack/apps/allpa'
    readonly tag_key='ALLPA_IMAGE_TAG'
    readonly compose_hash='2e222c7e5c01f3768b47627ef450e7ecf33163f507206b9f5ae6d1017974a2ea'
    readonly old_api='sha256:ed9d01e74c9522e65470f084dc922d4a07ebeaa0395187247d95da82a7d64492'
    readonly old_web='sha256:b8afa5cc38fd2afb9f38335251a135c2144ebf0fc1042e9eaea466a4e3ccc082'
    readonly api_id='sha256:d55bef84e7d9da206afd5a1907eb814627eb46b36a27784e47321813b1f1b5ac'
    readonly web_id='sha256:5f5ef65aa79fa34d7b6530d4a5abb893ce4c5a08329d8bd76e035cd85a9f97f6'
    readonly api_port=4002 web_port=3002
    services=(allpa-api allpa-web)
    ;;
  rivnu)
    readonly root='/opt/corestack/apps/rivnu'
    readonly tag_key='RIVNU_IMAGE_TAG'
    readonly compose_hash='fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc'
    readonly old_api='sha256:ad8cebea0dd2684bd75bb5828619b58c43ff4b2b968fd994e8c309e87b014094'
    readonly old_web='sha256:a29097976c974a482d7cfc56362220210422b823148229ec6ebba8949d337bef'
    readonly api_id="$old_api"
    readonly web_id='sha256:7d533a4461ebbcac0e6702458df42e372fdab4afada5f4ea3bf600842ab0bffe'
    readonly api_port=4001 web_port=3001
    # RIVNU already supports both identities; only its selector label changes.
    services=(rivnu-web)
    ;;
  *) printf '%s\n' 'Usage: bash activate-vm2-e31-identity-20261112.sh allpa|rivnu' >&2; exit 2 ;;
esac
readonly deploy_env="$root/secrets/deploy.env"
readonly compose="$root/repo/CoreStackSystemsv1/deploy/docker/compose.production.yml"
readonly backup="/opt/corestack/backups/$tenant-e31-identity-$(date -u +%Y%m%dT%H%M%SZ)"
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
[[ -f "$deploy_env" && ! -L "$deploy_env" && -w "$deploy_env" && "$(stat -c '%a' "$deploy_env")" == 600 ]] || fail DEPLOY_ENV_INVALID
[[ "$(sha256sum "$compose" | cut -d' ' -f1)" == "$compose_hash" ]] || fail COMPOSE_REVIEW_REQUIRED
[[ "$(docker image inspect "corestack/$tenant-api:$tag" --format '{{.Id}}')" == "$api_id" ]] || fail API_IMAGE_MISMATCH
[[ "$(docker image inspect "corestack/$tenant-web:$tag" --format '{{.Id}}')" == "$web_id" ]] || fail WEB_IMAGE_MISMATCH
docker run --rm --network none --entrypoint openssl "corestack/$tenant-api:$tag" version >/dev/null || fail API_OPENSSL_RUNTIME_MISSING
health "$tenant-api"
health "$tenant-web"
current_api=$(docker inspect "$tenant-api" --format '{{.Image}}')
current_web=$(docker inspect "$tenant-web" --format '{{.Image}}')
[[ "$current_api" == "$old_api" || "$current_api" == "$api_id" ]] || fail CURRENT_API_REVIEW_REQUIRED
[[ "$current_web" == "$old_web" || "$current_web" == "$web_id" ]] || fail CURRENT_WEB_REVIEW_REQUIRED

install -d -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"
docker inspect "$tenant-api" >"$backup/api.before.json"
docker inspect "$tenant-web" >"$backup/web.before.json"
activated=false
rollback() {
  local result=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    docker logs --tail 100 "$tenant-api" >"$backup/api.failure.log" 2>&1 || true
    docker logs --tail 100 "$tenant-web" >"$backup/web.failure.log" 2>&1 || true
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env"
    dc up -d --no-deps --no-build --pull never "${services[@]}" || true
    health "$tenant-api" && health "$tenant-web" || true
  fi
  printf 'E31_IDENTITY_ACTIVATION_FAILED_ROLLBACK_REQUESTED tenant=%s status=%s backup=%s\n' "$tenant" "$result" "$backup" >&2
  exit "$result"
}
trap rollback ERR
temporary=$(mktemp "$root/secrets/.e31-identity.XXXXXX")
awk -v key="$tag_key" -v tag="$tag" '
  BEGIN { found=0 }
  index($0,key "=")==1 { if (!found) print key "=" tag; found=1; next }
  { print }
  END { if (!found) print key "=" tag }
' "$deploy_env" >"$temporary"
chmod --reference="$deploy_env" "$temporary"
chown --reference="$deploy_env" "$temporary"
activated=true
mv -T "$temporary" "$deploy_env"
dc config --quiet
dc up -d --no-deps --no-build --pull never "${services[@]}"
health "$tenant-api"
health "$tenant-web"
[[ "$(docker inspect "$tenant-api" --format '{{.Image}}')" == "$api_id" ]]
[[ "$(docker inspect "$tenant-web" --format '{{.Image}}')" == "$web_id" ]]
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' "http://10.0.0.3:$api_port/health")" == 200 ]]
[[ "$(curl --silent --show-error --noproxy '*' --max-time 5 --output /dev/null --write-out '%{http_code}' "http://10.0.0.3:$web_port/login")" == 200 ]]
trap - ERR
printf 'E31_RNC_CEDULA_ACTIVATED_HEALTHY tenant=%s backup=%s\n' "$tenant" "$backup"
printf '%s\n' 'No migration, test invoice, reservation, credential or DGII submission was created.'

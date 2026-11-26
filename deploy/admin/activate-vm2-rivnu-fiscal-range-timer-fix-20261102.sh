#!/usr/bin/env bash
# Explicitly start the electronic-range outbox and verify the existing E31 is synchronized once.
set -Eeuo pipefail
set +x
umask 077

readonly root='/opt/corestack/apps/rivnu'
readonly repo="$root/repo/CoreStackSystemsv1"
readonly secrets="$root/secrets"
readonly deploy_env="$secrets/deploy.env"
readonly routes="$secrets/fiscal-range-registration/routes.json"
readonly compose="$repo/deploy/docker/compose.production.yml"
readonly compose_hash='fc0b63fdb2a1807650a32b6cf8fc1ede668cbbd2e69e1923f7ccfa8f091987bc'
readonly old_tag='range-sync-utc-fix-20261102'
readonly new_tag='range-sync-payload-fix-20261102'
readonly old_api_id='sha256:c9f4f8680a9c0f865a6690d6a4ec1817d8f76af12389976b90f53699f6310c5d'
readonly new_api_id='sha256:4c1b4a04f2a8c2e13692c2eb0bdc6ac2f2555aebe7095ee080175b1568ca8567'
readonly web_id='sha256:b7934e3bc141c7e311e1afc72b0ba455d32b56f25722fd57126abab10be10eca'
readonly tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly backup="/opt/corestack/backups/rivnu-range-payload-fix-$(date -u +%Y%m%dT%H%M%SZ)"

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
range_state() {
  docker exec rivnu-api node -e '
    const {PrismaClient}=require("/app/packages/database/dist/index.js");
    const p=new PrismaClient();
    p.electronicFiscalRange.findMany({
      orderBy:{createdAt:"asc"},
      select:{tenantId:true,issuerTaxId:true,ecfType:true,startNumber:true,endNumber:true,
        nextNumber:true,authorizationNumber:true,syncStatus:true,syncAttempts:true,
        lastErrorCode:true,remoteRangeId:true,syncedAt:true}
    }).then(rows=>console.log(JSON.stringify(rows,(_,v)=>typeof v==="bigint"?v.toString():v)))
      .finally(()=>p.$disconnect())'
}
validate_failed_range() {
  python3 -c '
import json, sys
rows=json.loads(sys.stdin.read())
ok=(len(rows)==1 and rows[0]["tenantId"]==sys.argv[1]
    and rows[0]["issuerTaxId"]==sys.argv[2] and rows[0]["ecfType"]==31
    and rows[0]["startNumber"]=="1" and rows[0]["endNumber"]=="300"
    and rows[0]["nextNumber"]=="1" and rows[0]["authorizationNumber"]=="6005643910"
    and rows[0]["syncStatus"]=="FAILED" and rows[0]["syncAttempts"]==1
    and rows[0]["lastErrorCode"]=="REMOTE_REJECTED" and rows[0]["remoteRangeId"] is None)
raise SystemExit(0 if ok else 1)
' "$tenant" "$rnc"
}
retry_failed_range() {
  docker exec -i rivnu-api node <<'NODE'
const { PrismaClient } = require('/app/packages/database/dist/index.js');
const p = new PrismaClient();
(async () => {
  const range = await p.electronicFiscalRange.findFirst({
    where: { syncStatus: 'FAILED', syncAttempts: 1, lastErrorCode: 'REMOTE_REJECTED' },
    select: { id: true, tenantId: true, createdById: true },
  });
  if (!range) throw new Error('FAILED_RANGE_NOT_FOUND');
  await p.$transaction(async (tx) => {
    const updated = await tx.electronicFiscalRange.updateMany({
      where: { id: range.id, syncStatus: 'FAILED', syncAttempts: 1 },
      data: { syncStatus: 'PENDING', nextSyncAt: new Date(), lastErrorCode: null },
    });
    if (updated.count !== 1) throw new Error('FAILED_RANGE_CHANGED');
    await tx.auditLog.create({
      data: {
        tenantId: range.tenantId,
        userId: range.createdById,
        action: 'ELECTRONIC_FISCAL_RANGE_SYNC_RETRIED',
        entity: 'ElectronicFiscalRange',
        entityId: range.id,
      },
    });
  });
  console.log('RIVNU_E31_RETRY_RECORDED');
})().finally(() => p.$disconnect());
NODE
}
validate_route() {
  python3 - "$routes" "$tenant" "$rnc" <<'PY'
import json, sys
path, tenant, rnc = sys.argv[1:]
with open(path, encoding='utf-8') as handle:
    value=json.load(handle)
expected={'version':1,'routes':[{'tenantId':tenant,'issuerRnc':rnc,
    'origin':'https://10.0.0.1:4083',
    'tokenFile':'/run/secrets/fiscal-range-registration/rivnu.token',
    'caFile':'/run/secrets/fiscal-range-registration/rivnu-ca.crt'}]}
raise SystemExit(0 if value == expected else 1)
PY
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM2-APP' ]] || fail 'RUN_WITH_SUDO_ON_VM2'
[[ -f "$compose" && ! -L "$compose" && "$(sha256sum "$compose" | cut -d' ' -f1)" == "$compose_hash" ]] || fail 'PRODUCTION_COMPOSE_HASH_MISMATCH'
[[ -f "$deploy_env" && ! -L "$deploy_env" && "$(stat -c '%u:%g:%a' "$deploy_env")" == '1006:1008:600' ]] || fail 'DEPLOY_ENV_INVALID'
[[ "$(env_value "$deploy_env" RIVNU_IMAGE_TAG)" == "$old_tag" ]] || fail 'UNEXPECTED_ACTIVE_IMAGE_TAG'
[[ "$(docker image inspect "corestack/rivnu-api:$new_tag" --format '{{.Id}}')" == "$new_api_id" ]] || fail 'NEW_API_IMAGE_ID_MISMATCH'
[[ "$(docker image inspect "corestack/rivnu-web:$new_tag" --format '{{.Id}}')" == "$web_id" ]] || fail 'NEW_WEB_IMAGE_ID_MISMATCH'
[[ "$(docker inspect rivnu-api --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$old_api_id|running|healthy" ]] || fail 'CURRENT_API_NOT_EXPECTED'
[[ "$(docker inspect rivnu-web --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$web_id|running|healthy" ]] || fail 'CURRENT_WEB_NOT_EXPECTED'
validate_route || fail 'PRODUCTION_RANGE_ROUTE_INVALID'
range_state | validate_failed_range || fail 'EXPECTED_SINGLE_FAILED_E31_NOT_FOUND'

install -d -o root -g root -m 0700 "$backup"
cp --preserve=mode,ownership,timestamps "$deploy_env" "$backup/deploy.env"

activated='false'
rollback() {
  local result=$?
  if [[ "$activated" == 'true' ]]; then
    cp --preserve=mode,ownership,timestamps "$backup/deploy.env" "$deploy_env" || true
    docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build rivnu-api >/dev/null 2>&1 || true
  fi
  printf 'RIVNU_RANGE_START_FIX_FAILED_ROLLED_BACK status=%s backup=%s\n' "$result" "$backup" >&2
}
trap rollback ERR

write_env "$deploy_env" RIVNU_IMAGE_TAG "$new_tag"
activated='true'
docker compose --env-file "$deploy_env" -f "$compose" config --quiet
docker compose --env-file "$deploy_env" -f "$compose" up -d --no-build rivnu-api

for _ in $(seq 1 90); do
  health=$(docker inspect rivnu-api --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
  [[ "$health" == 'running|healthy' ]] && break
  [[ "$health" == *'|unhealthy' ]] && false
  sleep 1
done
[[ "$(docker inspect rivnu-api --format '{{.Image}}|{{.State.Status}}|{{.State.Health.Status}}')" == "$new_api_id|running|healthy" ]]
curl --fail --silent --show-error --noproxy '*' --max-time 5 http://10.0.0.3:4001/health >/dev/null
docker logs --since 5m rivnu-api 2>&1 | grep -q 'ELECTRONIC_RANGE_SYNC_STARTED'
trap - ERR

retry_failed_range

state=''
for _ in $(seq 1 30); do
  state=$(range_state)
  status=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())[0]["syncStatus"])' <<<"$state")
  [[ "$status" == 'SYNCED' || "$status" == 'FAILED' ]] && break
  sleep 1
done
if [[ "$status" != 'SYNCED' ]]; then
  printf 'RIVNU_E31_SYNC_NOT_CONFIRMED status=%s state=%s\n' "$status" "$state" >&2
  docker logs --since 5m rivnu-api 2>&1 | grep -E 'ELECTRONIC_RANGE_' | tail -20 >&2 || true
  exit 1
fi
python3 -c '
import json,sys
r=json.loads(sys.stdin.read())[0]
ok=(r["syncAttempts"]==2 and r["lastErrorCode"] is None
    and isinstance(r["remoteRangeId"],str) and r["remoteRangeId"].isdigit()
    and r["syncedAt"] is not None)
raise SystemExit(0 if ok else 1)
' <<<"$state" || fail 'RIVNU_E31_SYNCED_STATE_INVALID'

printf 'RIVNU_E31_RANGE_SYNCHRONIZED backup=%s\n' "$backup"
printf 'API=%s\n' "$new_api_id"
printf '%s\n' 'Existing E31 1-300 was registered once; no invoice, signing job, delivery job or DGII request was created.'

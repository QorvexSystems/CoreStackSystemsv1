#!/usr/bin/env bash
# Run only after VM3 reports RIVNU_FISCAL_SCOPE_ALIGNED_EMPTY_DATABASE.
set -euo pipefail
umask 077

readonly old='cmqn0r66a0002lit0vxbzq5l4'
readonly new='cmt397emm0002nm0ogb50l2q6'
readonly stage='/opt/corestack/backups/fiscal-scope-alignment-20261006'
readonly files=(
  /opt/corestack/fe/config/fiscal-worker.json
  /opt/corestack/fe/config/fiscal-registration.json
  /opt/corestack/fe/config/preflight.json
)
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
command -v docker >/dev/null && command -v python3 >/dev/null || fail 'RUNTIME_DEPENDENCY_MISSING'
[[ ! -e "$stage" && ! -L "$stage" ]] || fail 'ALIGNMENT_ALREADY_ATTEMPTED_REVIEW_BACKUP'
install -d -o root -g root -m 0700 "$stage"
changed=false
cleanup() {
  code=$?
  trap - EXIT
  if (( code != 0 )) && [[ "$changed" == true ]]; then
    for file in "${files[@]}"; do
      backup="$stage/$(basename "$file").before"
      [[ -f "$backup" ]] && install --preserve-timestamps -o luismel -g corestack-admins -m 0444 "$backup" "$file"
    done
    docker compose --env-file /opt/corestack/fe/compose/worker.env -f /opt/corestack/fe/compose/compose.worker.yml up -d --force-recreate >/dev/null 2>&1 || true
    docker compose --env-file /opt/corestack/fe/compose/registration.env -f /opt/corestack/fe/compose/compose.registration.yml up -d --force-recreate >/dev/null 2>&1 || true
    docker compose --env-file /opt/corestack/fe/compose/preflight.env -f /opt/corestack/fe/compose/compose.preflight.yml up -d --force-recreate >/dev/null 2>&1 || true
    echo 'VM4_ALIGNMENT_FAILED_CONFIGURATION_ROLLED_BACK' >&2
  fi
  exit "$code"
}
trap cleanup EXIT

for file in "${files[@]}"; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'FISCAL_CONFIG_INVALID'
  install -o root -g root -m 0400 "$file" "$stage/$(basename "$file").before"
  temp=$(mktemp "$(dirname "$file")/.scope-alignment.XXXXXX")
  python3 - "$file" "$temp" "$old" "$new" <<'PY'
import json, pathlib, sys
source, target, old, new = sys.argv[1:]
value = json.loads(pathlib.Path(source).read_text(encoding='utf-8'))
encoded = json.dumps(value, separators=(',', ':'), sort_keys=True)
if encoded.count(old) != 1 or '40220429126' not in encoded or 'precertification' not in encoded:
    raise SystemExit('CONFIG_SCOPE_PRECONDITION_FAILED')
encoded = encoded.replace(old, new)
pathlib.Path(target).write_text(encoded + '\n', encoding='utf-8')
PY
  chown --reference="$file" "$temp"
  chmod --reference="$file" "$temp"
  mv -T "$temp" "$file"
done
changed=true

docker compose --env-file /opt/corestack/fe/compose/worker.env -f /opt/corestack/fe/compose/compose.worker.yml up -d --force-recreate
docker compose --env-file /opt/corestack/fe/compose/registration.env -f /opt/corestack/fe/compose/compose.registration.yml up -d --force-recreate
docker compose --env-file /opt/corestack/fe/compose/preflight.env -f /opt/corestack/fe/compose/compose.preflight.yml up -d --force-recreate

for attempt in $(seq 1 30); do
  states=$(docker inspect \
    corestack-fiscal-worker-fiscal-worker-1 \
    corestack-fiscal-registration-fiscal-registration-1 \
    corestack-fiscal-preflight-fiscal-preflight-1 \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
  [[ "$(printf '%s\n' "$states" | grep -c '^healthy$')" == 3 ]] && break
  sleep 2
done
[[ "$(printf '%s\n' "$states" | grep -c '^healthy$')" == 3 ]] || fail 'FISCAL_SERVICES_NOT_HEALTHY'
for name in \
  corestack-fiscal-worker-fiscal-worker-1 \
  corestack-fiscal-registration-fiscal-registration-1 \
  corestack-fiscal-preflight-fiscal-preflight-1; do
  [[ "$(docker exec "$name" node -e 'const fs=require("fs");for(const p of ["/run/config/fiscal-worker.json","/run/config/fiscal-registration.json","/run/fiscal/config.json"]){try{const x=JSON.parse(fs.readFileSync(p));process.stdout.write((x.scope??x).tenantId);break}catch{}}')" == "$new" ]] || fail 'RUNNING_SCOPE_VERIFICATION_FAILED'
done
changed=false
echo 'RIVNU_VM4_FISCAL_SCOPE_ALIGNED_SERVICES_HEALTHY'
echo "Backup: $stage"

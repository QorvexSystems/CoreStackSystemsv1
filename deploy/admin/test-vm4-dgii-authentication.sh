#!/usr/bin/env bash
# Authentication-only smoke test. No e-CF/RFCE submission and no queue activation.
set -euo pipefail
readonly compose='/opt/corestack/fe/compose/compose.signer.yml'
readonly env='/opt/corestack/fe/compose/signer.env'
readonly service='corestack-fiscal-signer-fiscal-signer-1'
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -f "$compose" && -f "$env" ]] || fail 'SIGNER_DEPLOYMENT_MISSING'
docker compose --env-file "$env" -f "$compose" up -d --force-recreate
for _ in $(seq 1 40); do
  state=$(docker inspect "$service" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy || "$state" == exited ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || fail 'SIGNER_NOT_HEALTHY'
docker compose --env-file "$env" -f "$compose" run --rm --no-deps \
  --entrypoint node fiscal-signer --experimental-strip-types src/dgii-auth-smoke.ts
echo 'DGII_AUTH_SMOKE_COMPLETE_NO_FISCAL_DOCUMENT_SUBMITTED'

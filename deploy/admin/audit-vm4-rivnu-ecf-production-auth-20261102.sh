#!/usr/bin/env bash
# Authentication-only production audit. It never registers, reserves or sends an e-CF.
set -Eeuo pipefail
set +x
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }

readonly expected_host='CoreStackSystems-VM4-Billing'
readonly container='corestack-fiscal-production-fiscal-production-1'
readonly compose_file='/opt/corestack/fe/production/compose.yml'
readonly source_root=${1:-}
readonly audit_source="$source_root/packages/fiscal/test/production-auth-audit.ts"

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == "$expected_host" ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -n "$source_root" && -d "$source_root" && ! -L "$source_root" ]] || fail 'AUDIT_SOURCE_ROOT_INVALID'
[[ -f "$audit_source" && ! -L "$audit_source" && -s "$audit_source" ]] || fail 'AUTH_AUDIT_SOURCE_MISSING'
[[ -f "$compose_file" && ! -L "$compose_file" ]] || fail 'FISCAL_PRODUCTION_COMPOSE_INVALID'

state=$(docker inspect "$container" --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}')
[[ "$state" == 'running|healthy' ]] || fail "FISCAL_PRODUCTION_NOT_HEALTHY state=$state"
image=$(docker inspect "$container" --format '{{.Config.Image}}')
[[ "$image" == 'corestack/fiscal-production:rivnu-20261102-seed-fix' ]] || fail "UNREVIEWED_FISCAL_PRODUCTION_IMAGE image=$image"

env FISCAL_PRODUCTION_IMAGE="$image" \
  docker compose -f "$compose_file" run --rm --no-deps \
  -v "$audit_source:/app/fiscal/test/production-auth-audit.ts:ro" \
  --entrypoint node fiscal-production \
  --experimental-strip-types /app/fiscal/test/production-auth-audit.ts

printf '%s\n' 'RIVNU_VM4_ECF_PRODUCTION_AUTHENTICATION_AUDIT_COMPLETE_NO_DOCUMENT_SENT'

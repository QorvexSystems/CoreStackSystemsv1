#!/usr/bin/env bash
# Test-only dependencies; never installs packages into the ERP or reads .env.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
harness=$(mktemp -d /tmp/corestack-print-test.XXXXXX)
printf 'Test harness retained: %s\n' "$harness"
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache \
  -v "$harness:/harness" --entrypoint npm corestack/rivnu-api:ecf-linked-20260923 \
  install --prefix /harness --no-save --ignore-scripts --no-audit --no-fund \
  @xmldom/xmldom@0.9.12 @zxing/library@0.21.3
docker run --rm --user "$(id -u):$(id -g)" --network none \
  -v "$harness:/harness:ro" \
  -v "$repo/apps/web/lib:/app/apps/web/lib:ro" \
  -v "$repo/apps/web/test:/app/apps/web/test:ro" \
  -v "$repo/packages/fiscal/src:/app/packages/fiscal/src:ro" \
  --entrypoint sh corestack/rivnu-api:ecf-linked-20260923 \
  -c 'cd /app/apps/web && /app/packages/database/node_modules/.bin/tsx --test test/electronic-draft-print.test.ts'

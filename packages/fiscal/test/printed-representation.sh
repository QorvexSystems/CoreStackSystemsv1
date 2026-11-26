#!/usr/bin/env bash
# Offline signed RI fixture + independent QR decoder. No fiscal DB or real keys.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
ri_test_image=${RI_TEST_IMAGE:-corestack/rivnu-api:ecf-print-20260924}
ri_artifacts=$(mktemp -d /tmp/corestack-ri-test.XXXXXX)
mkdir "$ri_artifacts/harness"
printf 'Synthetic artifacts retained: %s\n' "$ri_artifacts"
docker run --rm --user "$(id -u):$(id -g)" --read-only --network none \
  --tmpfs /tmp:rw,nosuid,size=64m -e EXPORT_SYNTHETIC_RI=true \
  -v "$ri_artifacts:/output" \
  -v "$repo/packages/fiscal/src:/app/packages/fiscal/src:ro" \
  -v "$repo/packages/fiscal/test:/app/packages/fiscal/test:ro" \
  --entrypoint node corestack/fiscal-signing-test:local \
  --experimental-strip-types --test test/printed-representation-integration.ts
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache \
  -v "$ri_artifacts/harness:/harness" --entrypoint npm "$ri_test_image" \
  install --prefix /harness --no-save --ignore-scripts --no-audit --no-fund \
  @xmldom/xmldom@0.9.12 @zxing/library@0.21.3
docker run --rm --user "$(id -u):$(id -g)" --network none -e PRINT_SIGNED_RI_FIXTURE=true \
  -v "$ri_artifacts:/artifacts" -v "$ri_artifacts/harness:/harness:ro" \
  -v "$repo/apps/web/lib:/app/apps/web/lib:ro" \
  -v "$repo/apps/web/test:/app/apps/web/test:ro" \
  -v "$repo/packages/fiscal/src:/app/packages/fiscal/src:ro" \
  --entrypoint sh "$ri_test_image" \
  -c 'cd /app/apps/web && /app/packages/database/node_modules/.bin/tsx --test test/electronic-draft-print.test.ts'

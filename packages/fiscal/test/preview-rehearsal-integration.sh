#!/usr/bin/env bash
set -euo pipefail
fiscal_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
preview_test_container=$(docker run --rm -d --network none --memory=256m \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=128m \
  -e POSTGRES_DB=corestack_preview_remote -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)
trap 'docker stop "$preview_test_container" >/dev/null' EXIT
ready=false
for ((i=0;i<30;i++)); do
  if docker exec "$preview_test_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,size=64m --tmpfs /run/synthetic-state:rw,nosuid,size=32m \
 --network "container:$preview_test_container" -e FISCAL_SYNTHETIC_PREVIEW=NO_FISCAL_VALIDITY \
 -v "$fiscal_root/src:/app/packages/fiscal/src:ro" -v "$fiscal_root/test:/app/packages/fiscal/test:ro" \
 -v "$fiscal_root/sql:/app/packages/fiscal/sql:ro" \
 -v "$fiscal_root/../../deploy/preview/remote-rehearsal.sql:/fixtures/remote-rehearsal.sql:ro" \
 --entrypoint node corestack/fiscal-signing-test:local --experimental-strip-types test/preview-rehearsal-integration.ts

#!/usr/bin/env bash
# No published ports, persistent volumes, VM access, or internet routes.
set -euo pipefail
fiscal_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
delivery_container=$(docker run --rm -d --network none --memory=256m \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=128m \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)
trap 'docker stop "$delivery_container" >/dev/null' EXIT
ready=false
for ((i=0;i<30;i++)); do
  if docker exec "$delivery_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || exit 1
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,size=64m \
  --network "container:$delivery_container" -e SYNTHETIC_DELIVERY=OFFLINE_ONLY \
  -v "$fiscal_root/src:/app/packages/fiscal/src:ro" \
  -v "$fiscal_root/test:/app/packages/fiscal/test:ro" \
  -v "$fiscal_root/sql:/app/packages/fiscal/sql:ro" \
  --entrypoint node corestack/fiscal-signing-test:local \
  --experimental-strip-types test/signed-delivery-integration.ts

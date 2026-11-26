#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
test_dir=$(mktemp -d /tmp/corestack-fiscal-integration.XXXXXX)
container=''
cleanup() {
 if [[ -n "$container" ]]; then docker stop "$container" >/dev/null; fi
 rm -f -- "$test_dir/ca.crt"
 rm -f -- "$test_dir/server.crt" "$test_dir/server.key"
 rmdir -- "$test_dir"
}
trap cleanup EXIT
container=$(docker run --rm -d --user 0 --network none --hostname VM3-SQLDB \
 --tmpfs /var/lib/corestack-pki:mode=0700 -v "$repo/deploy:/work:ro" -v "$repo/packages/fiscal:/fiscal:ro" \
 -v "$repo/packages/database/prisma/migrations/20260921180000_add_fiscal_dispatch_outbox/migration.sql:/erp-dispatch-migration.sql:ro" \
 corestack/tls-activation-test:local integration)
ready=false
for ((i=0;i<45;i++)); do
 if docker logs "$container" 2>&1 | grep -q FISCAL_INTEGRATION_FIXTURE_READY; then ready=true; break; fi
 if [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]]; then break; fi
 sleep 1
done
[[ "$ready" == true ]] || { docker logs "$container"; exit 1; }
docker exec --user postgres "$container" psql -X -h /var/run/postgresql -d rivnu_fiscal_pre \
 -v ON_ERROR_STOP=1 -f /fiscal/test/dispatch-fixture.sql >/dev/null
docker cp "$container:/usr/local/share/corestack-pki/internal-root-2026.crt" "$test_dir/ca.crt"
# Ephemeral synthetic fixture only; never copy a real server's private key.
docker cp "$container:/etc/corestack-postgresql-tls-2026/server.crt.pem" "$test_dir/server.crt"
docker cp "$container:/etc/corestack-postgresql-tls-2026/server.key.pem" "$test_dir/server.key"
chmod 0444 "$test_dir/server.crt" "$test_dir/server.key"
docker run --rm --read-only --tmpfs /tmp:rw,size=64m --network "container:$container" \
 --mount "type=bind,src=$test_dir/ca.crt,dst=/run/test-ca.crt,readonly" \
 --mount "type=bind,src=$test_dir/server.crt,dst=/run/test-server.crt,readonly" \
 --mount "type=bind,src=$test_dir/server.key,dst=/run/test-server.key,readonly" \
 -v "$repo/packages/fiscal/src:/app/packages/fiscal/src:ro" \
 -v "$repo/packages/fiscal/test:/app/packages/fiscal/test:ro" \
 corestack/fiscal-worker-test:local node --experimental-strip-types test/worker-integration.ts

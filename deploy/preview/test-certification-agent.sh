#!/usr/bin/env bash
set -Eeuo pipefail
set +x
printf '%s\n' 'RETIRED: run tests in /home/luismel/corestack-certification; no ERP certification module remains.' >&2
exit 1
readonly repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly network="corestack-certification-test-$$"
readonly database="corestack-certification-test-db-$$"
readonly image="${CERTIFICATION_TEST_API_IMAGE:-corestack/rivnu-api:certification-agent-20261104}"
db_created=false
net_created=false
cleanup() {
  if [[ "$db_created" == true ]]; then docker stop "$database" >/dev/null 2>&1 || true; fi
  if [[ "$net_created" == true ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
docker network create "$network" >/dev/null
net_created=true
docker run --rm -d --name "$database" --network "$network" --network-alias certification-test-db \
  -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=certification_test postgres:17-alpine >/dev/null
db_created=true
for attempt in $(seq 1 40); do
  if docker exec "$database" pg_isready -U postgres -d certification_test >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 40 ]] || { echo TEST_POSTGRES_UNAVAILABLE >&2; exit 1; }
  sleep 1
done
docker run --rm --network "$network" \
  -e DATABASE_URL=postgresql://postgres:synthetic-only@certification-test-db:5432/certification_test \
  -e DIRECT_URL=postgresql://postgres:synthetic-only@certification-test-db:5432/certification_test \
  -v "$repo/packages/database/prisma:/schema:ro" --entrypoint /app/packages/database/node_modules/.bin/prisma \
  "$image" migrate deploy --schema /schema/schema.prisma | tail -2
docker exec -i "$database" psql -X -U postgres -d certification_test -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE synthetic_runtime LOGIN PASSWORD 'synthetic-only';
GRANT USAGE ON SCHEMA public TO synthetic_runtime;
GRANT SELECT, INSERT, UPDATE ON "Tenant", "User", "ElectronicCertificationCase", "ElectronicCertificationStep", "ElectronicCertificationJob" TO synthetic_runtime;
GRANT SELECT, INSERT ON "AuditLog", "ElectronicCertificationArtifact", "ElectronicCertificationEvent" TO synthetic_runtime;
SQL
docker run --rm --network "$network" \
  -e DATABASE_URL=postgresql://synthetic_runtime:synthetic-only@certification-test-db:5432/certification_test \
  -e DIRECT_URL=postgresql://synthetic_runtime:synthetic-only@certification-test-db:5432/certification_test \
  -v "$repo/apps/api/src/modules/certification-orchestrator:/app/apps/api/src/modules/certification-orchestrator:ro" \
  -v "$repo/apps/api/test/certification-orchestrator.integration.cjs:/test/integration.cjs:ro" \
  --entrypoint sh "$image" \
  -c '/app/apps/api/node_modules/.bin/tsc -p /app/apps/api/tsconfig.json && node /test/integration.cjs'

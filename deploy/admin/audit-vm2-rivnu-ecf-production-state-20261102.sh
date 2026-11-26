#!/usr/bin/env bash
# Read-only ERP/API audit before RIVNU's first production e-CF.
set -Eeuo pipefail
set +x
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$(hostname)" == 'VM2-APP' ]] || fail 'RUN_ON_VM2'

api_state=$(docker inspect rivnu-api --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Config.Image}}')
web_state=$(docker inspect rivnu-web --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Config.Image}}')
[[ "$api_state" == 'running|healthy|corestack/rivnu-api:ecf-production-20261102' ]] || fail "RIVNU_API_STATE_INVALID state=$api_state"
[[ "$web_state" == 'running|healthy|corestack/rivnu-web:ecf-production-20261102' ]] || fail "RIVNU_WEB_STATE_INVALID state=$web_state"

docker exec rivnu-api sh -lc \
  'test -n "$FISCAL_RANGE_REGISTRATION_ROUTES_FILE" && test -r "$FISCAL_RANGE_REGISTRATION_ROUTES_FILE"' \
  || fail 'FISCAL_RANGE_ROUTE_NOT_CONFIGURED'

docker exec -i rivnu-api node - <<'NODE'
const { PrismaClient } = require('/app/packages/database/generated/client');
const db = new PrismaClient();
(async () => {
try {
  const ranges = await db.electronicFiscalRange.findMany({
    where: { issuerTaxId: '40220429126', ecfType: 31 },
    select: {
      tenantId: true, issuerTaxId: true, ecfType: true, startNumber: true,
      endNumber: true, nextNumber: true, syncStatus: true, syncAttempts: true,
      lastErrorCode: true, remoteRangeId: true, syncedAt: true, validUntil: true,
    },
  });
  const valid = ranges.length === 1 &&
    ranges[0].tenantId === 'cmqn0r66a0002lit0vxbzq5l4' &&
    ranges[0].startNumber === 1n && ranges[0].endNumber === 300n &&
    ranges[0].nextNumber === 1n && ranges[0].syncStatus === 'SYNCED' &&
    ranges[0].lastErrorCode === null && ranges[0].remoteRangeId === '1';
  if (!valid) throw new Error('ERP_E31_RANGE_STATE_INVALID');
  const dispatch = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM corestack_erp_fiscal.dispatch WHERE environment='production'`,
  );
  if (dispatch[0]?.count !== 0) throw new Error('ERP_PRODUCTION_DISPATCH_NOT_EMPTY');
  const invoices = await db.invoice.count({
    where: { documentType: { in: ['FISCAL_CREDIT_ELECTRONIC_31', 'CONSUMER_ELECTRONIC_32'] } },
  });
  if (invoices !== 0) throw new Error('ERP_ECF_INVOICE_ALREADY_EXISTS');
  console.log('ERP_E31=SYNCED|1-300|NEXT=1|REMAINING=300|DISPATCH=0|INVOICES=0');
} finally {
  await db.$disconnect();
}
})().catch((error) => {
  console.error(error instanceof Error ? error.message : 'ERP_AUDIT_FAILED');
  process.exitCode = 1;
});
NODE

docker exec -i rivnu-api /app/packages/database/node_modules/.bin/tsx - <<'TS'
import clientModule from '/app/apps/api/src/modules/fiscal-sequences/electronic-range-registration.client.ts';
const createClient = (clientModule as any).createElectronicRangeRegistrationClientFromEnvironment;
if (typeof createClient !== 'function') throw new Error('RANGE_CLIENT_EXPORT_MISSING');
const client = createClient();
if (!client) throw new Error('RANGE_CLIENT_DISABLED');
const ranges = await client.readRanges('cmqn0r66a0002lit0vxbzq5l4');
const e31 = ranges.find((range: any) => range.ecfType === 31);
if (!e31 || e31.rangeId !== '1' || e31.startNumber !== '1' || e31.endNumber !== '300' ||
    e31.nextNumber !== '1' || e31.remaining !== '300' || e31.used !== '0' || e31.exhausted) {
  throw new Error('AUTHORITATIVE_E31_RANGE_STATE_INVALID');
}
console.log('VM4_E31=REGISTERED|1-300|NEXT=1|REMAINING=300|USED=0');
TS

if docker logs --since 15m rivnu-api 2>&1 | \
  grep -E 'ELECTRONIC_FISCAL_DISPATCH_DISABLED|ERROR|FATAL' >/dev/null; then
  fail 'RECENT_RIVNU_API_FISCAL_ERROR'
fi

printf '%s\n' 'RIVNU_VM2_ECF_PRODUCTION_STATE_AUDIT_PASSED_READ_ONLY'
printf '%s\n' 'No range, sequence, reservation, invoice, queue, credential or DGII endpoint was changed.'

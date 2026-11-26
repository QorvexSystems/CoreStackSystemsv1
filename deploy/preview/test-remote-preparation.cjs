const assert = require('node:assert/strict');
process.env.NODE_ENV = 'development';
process.env.RIVNU_PREVIEW_GUARD = 'RIVNU_DGII_PREVIEW_ONLY';
process.env.DATABASE_URL = process.env.DIRECT_URL =
  'postgresql://rivnu_preview:synthetic@rivnu-dgii-preview-db:5432/rivnu_dgii_preview';
const {
  prepareRemotePreview,
} = require('/app/apps/api/dist/modules/fiscal-documents/preview-remote.js');
const {
  fiscalPreviewCore,
} = require('/app/apps/api/dist/modules/fiscal-documents/preview-preparation.js');
async function main() {
  const tenantId = 'cmt397emm0002nm0ogb50l2q6';
  const scope = { tenantId, issuerRnc: '40220429126', environment: 'precertification' };
  const snapshot = {
    id: 'synthetic',
    revision: '1',
    tenantId,
    operationId: 'synthetic-remote',
    pricingProfile: 'ERP_NET_UNIT_PRICE_V1',
    status: 'DRAFT',
    fiscalStatus: 'NOT_APPLICABLE',
    ncf: null,
    eNcf: null,
    documentType: 'CONSUMER_ELECTRONIC_32',
    issuedOn: '2026-09-22',
    incomeType: '01',
    paymentMode: 'CASH',
    dueOn: null,
    customer: null,
    issuer: { rnc: scope.issuerRnc, legalName: 'PRUEBA SIN VALIDEZ', address: 'Prueba' },
    items: [
      {
        id: '1',
        description: 'Prueba',
        kind: 'GOOD',
        quantity: '1',
        unitPrice: '100',
        originalUnitPrice: '100',
        discountTotal: '0',
        taxCategory: 'ITBIS_18',
        taxRate: '0.18',
        subtotal: '100',
        taxTotal: '18',
        total: '118',
      },
    ],
    subtotal: '100',
    discountTotal: '0',
    taxTotal: '18',
    total: '118',
  };
  const analyzed = fiscalPreviewCore().adaptErpSalesSnapshot(scope, snapshot);
  const ack = { documentId: '9', encf: 'E320000000009', payloadSha256: analyzed.payloadSha256 };
  const row = {
    id: '1',
    snapshot,
    revision: '1',
    planned_at: '2026-09-22T10:00:00-04:00',
    state: 'PENDING',
    result: null,
    error_code: null,
    execution_mode: 'REMOTE_VM4',
    remote_ack: null,
  };
  const writes = [];
  const db = {
    $executeRawUnsafe: async (...args) => {
      writes.push(args);
      return 1;
    },
  };
  let sends = 0;
  const unavailable = async () => ({
    scope,
    send: async (request) => {
      sends++;
      assert.deepEqual(request, analyzed.request);
      return ack;
    },
    read: async () => {
      throw new Error('timeout');
    },
  });
  const pending = await prepareRemotePreview(db, row, tenantId, unavailable);
  assert.equal(pending.state, 'PENDING');
  assert.equal(pending.errorCode, 'REMOTE_UNCONFIRMED');
  assert.match(writes[0][0], /remote_ack/);
  assert.equal(sends, 1);
  const recovered = await prepareRemotePreview(
    db,
    { ...row, remote_ack: ack },
    tenantId,
    async () => ({
      scope,
      send: async () => assert.fail('ack already persisted'),
      read: async (expected) => {
        assert.deepEqual(expected, ack);
        return {
          ...ack,
          state: 'DONE',
          xml: '<ECF/>',
          xmlSha256: 'a'.repeat(64),
          signed: false,
          sendable: false,
          lastErrorCode: null,
        };
      },
    }),
  );
  assert.equal(recovered.state, 'DONE');
  assert.equal(recovered.executionMode, 'REMOTE_VM4');
  assert.equal(recovered.result.sendable, false);
  console.log(
    'PASS: remote timeout preserves pending operation/ack; recovery reads same document; no local fallback',
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

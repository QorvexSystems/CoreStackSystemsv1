import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareVerifiedDelivery, type FiscalSigningService } from '../src/delivery-preparation.ts';
import type { DeliveryBundleVerifier } from '../src/delivery-enqueue.ts';
const scope = {
  tenantId: 'synthetic',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const hash = (xml: string) => createHash('sha256').update(xml).digest('hex');
function fixture(type = 31, total = '118.00', issuer = scope.issuerRnc) {
  const xml = `<ECF><RNCEmisor>${issuer}</RNCEmisor><MontoTotal>${total}</MontoTotal></ECF>`;
  const prepared = {
    documentId: '1',
    encf: `E${type}0000000001`,
    state: 'DONE',
    attempts: 1,
    xml,
    xmlSha256: hash(xml),
    schemaSha256: 'a'.repeat(64),
    sendable: false,
  };
  const calls: string[] = [];
  const db = {
    query: async (sql: string, _values: readonly string[]) => {
      if (sql.includes('read_preparation')) return { rows: [{ preparation: prepared }] };
      calls.push('ENQUEUE');
      return { rows: [{ created: true }] };
    },
  };
  const signer: FiscalSigningService = {
    signEcf: async (s, source) => {
      assert.deepEqual(s, scope);
      assert.equal(source, xml);
      calls.push('SIGN_ECF');
      return '<SignedEcfFixture/>';
    },
    signConsumptionSummary: async (_s, source, signed) => {
      assert.equal(source, xml);
      assert.equal(signed, '<SignedEcfFixture/>');
      calls.push('SIGN_RFCE');
      return '<SignedSummaryFixture/>';
    },
  };
  const verify: DeliveryBundleVerifier = async (_s, input) => {
    calls.push('VERIFY');
    const evidence = (value: string) => ({
      sha256: hash(value),
      actorRnc: scope.issuerRnc,
      encf: prepared.encf,
      total,
    });
    return {
      sourceSha256: hash(xml),
      certificateSha256: 'b'.repeat(64),
      ecf: evidence(input.signedEcfXml),
      submission: evidence(input.submissionXml),
    };
  }; // Explicit non-crypto mocks; integrated suite uses real XMLDSig.
  return { db, signer, verify, calls };
}
test('delivery orchestration selects ECF/RFCE by persisted total, not caller flags', async () => {
  for (const [type, total, summary] of [
    [31, '118.00', false],
    [32, '118.00', true],
    [32, '250000.00', false],
  ] as const) {
    const f = fixture(type, total);
    await prepareVerifiedDelivery(f.db, scope, '1', f.signer, f.verify);
    assert.deepEqual(f.calls, ['SIGN_ECF', ...(summary ? ['SIGN_RFCE'] : []), 'VERIFY', 'ENQUEUE']);
  }
});
test('production, wrong issuer, missing preparation and signer/verifier faults fail closed', async () => {
  const f = fixture();
  await assert.rejects(
    prepareVerifiedDelivery(f.db, { ...scope, environment: 'production' }, '1', f.signer, f.verify),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  assert.equal(f.calls.length, 0);
  const wrong = fixture(31, '118.00', '101010641');
  await assert.rejects(
    prepareVerifiedDelivery(wrong.db, scope, '1', wrong.signer, wrong.verify),
    /ISSUER_MISMATCH/,
  );
  assert.equal(wrong.calls.length, 0);
  await assert.rejects(
    prepareVerifiedDelivery(
      { query: async () => ({ rows: [{ preparation: null }] }) },
      scope,
      '1',
      f.signer,
      f.verify,
    ),
    /NOT_READY/,
  );
  await assert.rejects(
    prepareVerifiedDelivery(
      f.db,
      scope,
      '1',
      {
        ...f.signer,
        signEcf: async () => {
          throw Error('SIGNER_OFFLINE');
        },
      },
      f.verify,
    ),
    /SIGNER_OFFLINE/,
  );
  await assert.rejects(
    prepareVerifiedDelivery(f.db, scope, '1', f.signer, async () => {
      throw Error('UNTRUSTED');
    }),
    /UNTRUSTED/,
  );
  assert.ok(!f.calls.includes('ENQUEUE'));
});

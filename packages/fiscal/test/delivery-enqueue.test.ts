import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { enqueueVerifiedDelivery, type DeliveryBundleVerifier } from '../src/delivery-enqueue.ts';
import type { FiscalRegistrationConnection } from '../src/request-repository.ts';
const scope = {
  tenantId: 'test',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture(type = 31, total = '118.00') {
  const xml = `<ECF><MontoTotal>${total}</MontoTotal></ECF>`;
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
  const calls: string[][] = [];
  const db: FiscalRegistrationConnection = {
    query: async (sql, values) => {
      if (sql.includes('read_preparation')) return { rows: [{ preparation: prepared }] };
      calls.push([...values]);
      return { rows: [{ created: true }] };
    },
  };
  const verify: DeliveryBundleVerifier = async (s, input) => ({
    sourceSha256: hash(input.unsignedEcfXml),
    certificateSha256: 'b'.repeat(64),
    ecf: { actorRnc: s.issuerRnc, encf: prepared.encf, total, sha256: hash(input.signedEcfXml) },
    submission: {
      actorRnc: s.issuerRnc,
      encf: prepared.encf,
      total,
      sha256: hash(input.submissionXml),
    },
  }); // no crypto: mock only
  return { db, calls, verify };
}
test('verified ECF queue insertion binds immutable preparation and exact signed bytes', async () => {
  const f = fixture();
  const result = await enqueueVerifiedDelivery(
    f.db,
    scope,
    '1',
    '<SignedFixture/>',
    '<SignedFixture/>',
    f.verify,
  );
  assert.equal(result.route, 'ECF');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], f.calls[0][5]);
});
test('RFCE insertion retains original signed E32, never only the summary', async () => {
  const f = fixture(32);
  const result = await enqueueVerifiedDelivery(
    f.db,
    scope,
    '1',
    '<FullSignedE32Fixture/>',
    '<SignedRFCEFixture/>',
    f.verify,
  );
  assert.equal(result.route, 'RFCE');
  assert.equal(f.calls[0][5], '<FullSignedE32Fixture/>');
  assert.equal(f.calls[0][1], '<SignedRFCEFixture/>');
});
test('verifier rejection and source mismatch never enqueue', async () => {
  const f = fixture();
  await assert.rejects(
    enqueueVerifiedDelivery(f.db, scope, '1', '<x/>', '<x/>', async () => {
      throw Error('INVALID_SIGNATURE');
    }),
  );
  await assert.rejects(
    enqueueVerifiedDelivery(f.db, scope, '1', '<x/>', '<x/>', async (s, i) => ({
      ...(await f.verify(s, i)),
      sourceSha256: '0'.repeat(64),
    })),
  );
  assert.equal(f.calls.length, 0);
});
test('E32 at threshold cannot replace full ECF with a summary', async () => {
  const f = fixture(32, '250000.00');
  await assert.rejects(
    enqueueVerifiedDelivery(f.db, scope, '1', '<Full/>', '<Summary/>', f.verify),
  );
  assert.equal(f.calls.length, 0);
});

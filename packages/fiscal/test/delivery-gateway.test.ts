import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDeliveryGateway } from '../src/delivery-gateway.ts';
import type { DeliveryClaim } from '../src/delivery-worker.ts';
const scope = {
  tenantId: 'synthetic',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const xml = '<SyntheticOnly/>';
const claim: DeliveryClaim = {
  scope,
  documentId: '1',
  encf: 'E310000000001',
  claimToken: '11111111-1111-4111-8111-111111111111',
  action: 'SEND',
  route: 'ECF',
  xml,
  sha256: createHash('sha256').update(xml).digest('hex'),
  trackId: null,
};
function fixture(c: DeliveryClaim = claim, tracks = ['track-1'], code: unknown = 1) {
  const calls: string[] = [];
  const result = { rnc: scope.issuerRnc, encf: c.encf, codigo: code, secuenciaUtilizada: true };
  const gateway = createDeliveryGateway(
    c.scope,
    {
      submit: async () => {
        calls.push('POST');
        return c.route === 'RFCE' ? { ...result, rnc: undefined } : { trackId: 'track-1' };
      },
      result: async (trackId) => {
        calls.push('GET_RESULT');
        return { ...result, trackId };
      },
      rfceResult: async () => {
        calls.push('GET_RFCE');
        return result;
      },
      trackIds: async () => {
        calls.push('GET_TRACKS');
        return tracks;
      },
    },
    async () => ({
      actorRnc: scope.issuerRnc,
      encf: c.encf,
      sha256: c.sha256,
      securityCode: 'ab+/12',
    }),
  ); // MOCK only
  return { gateway, calls };
}
test('ECF acknowledgment is processing; lost-track recovery uses GET only', async () => {
  const f = fixture();
  assert.equal((await f.gateway.send(claim)).outcome, 'PROCESSING');
  assert.equal((await f.gateway.reconcile({ ...claim, action: 'RECONCILE' })).outcome, 'ACCEPTED');
  assert.deepEqual(f.calls, ['POST', 'GET_TRACKS', 'GET_RESULT']);
});
test('missing or ambiguous track never authorizes resend', async () => {
  for (const tracks of [[], ['one', 'two']]) {
    const f = fixture(claim, tracks);
    const result = await f.gateway.reconcile({ ...claim, action: 'RECONCILE' });
    assert.equal(result.outcome, tracks.length ? 'REVIEW_REQUIRED' : 'UNCONFIRMED');
    assert.deepEqual(f.calls, ['GET_TRACKS']);
  }
});
test('certification missing track is explicit review, not invented endpoint', async () => {
  const c = {
    ...claim,
    scope: { ...scope, environment: 'certification' as const },
    action: 'RECONCILE' as const,
  };
  const f = fixture(c);
  assert.equal((await f.gateway.reconcile(c)).outcome, 'REVIEW_REQUIRED');
  assert.equal(f.calls.length, 0);
});
test('RFCE immediate and consulted statuses bind original invoice and security code', async () => {
  const c = { ...claim, encf: 'E320000000001', route: 'RFCE' as const };
  const f = fixture(c, [], '4');
  assert.equal((await f.gateway.send(c)).outcome, 'ACCEPTED_CONDITIONALLY');
  assert.equal(
    (await f.gateway.reconcile({ ...c, action: 'RECONCILE' })).outcome,
    'ACCEPTED_CONDITIONALLY',
  );
  assert.deepEqual(f.calls, ['POST', 'GET_RFCE']);
});
test('unknown status never becomes accepted', async () => {
  const f = fixture(claim, ['track'], 7);
  await assert.rejects(
    f.gateway.reconcile({ ...claim, action: 'RECONCILE' }),
    /UNKNOWN_DGII_RESULT/,
  );
});
test('wrong actor, unsigned verification failure and cross-tenant claims block network', async () => {
  const f = fixture();
  await assert.rejects(f.gateway.send({ ...claim, scope: { ...scope, tenantId: 'other' } }));
  assert.equal(f.calls.length, 0);
  let sent = false;
  const gateway = createDeliveryGateway(
    scope,
    {
      submit: async () => {
        sent = true;
        return {};
      },
      result: async () => ({}),
      rfceResult: async () => ({}),
      trackIds: async () => [],
    },
    async () => {
      throw Error('SIGNATURE_INVALID');
    },
  );
  await assert.rejects(gateway.send(claim), /SIGNATURE_INVALID/);
  assert.equal(sent, false);
});

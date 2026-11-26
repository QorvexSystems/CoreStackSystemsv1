import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  runDeliveryOnce,
  parseDeliveryClaim,
  type DeliveryClaim,
  type DeliveryGateway,
} from '../src/delivery-worker.ts';
import type { FiscalRegistrationConnection } from '../src/request-repository.ts';
const scope = {
  tenantId: 'delivery-test',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const xml = '<SyntheticOnly/>';
const claim: DeliveryClaim = {
  documentId: '1',
  claimToken: '11111111-1111-4111-8111-111111111111',
  encf: 'E310000000001',
  route: 'ECF',
  action: 'SEND',
  scope,
  xml,
  sha256: createHash('sha256').update(xml).digest('hex'),
  trackId: null,
};
function fixture(c: unknown = claim, save = true) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const db: FiscalRegistrationConnection = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [sql.includes('claim_delivery') ? { claim: c } : { saved: save }] };
    },
  };
  return { db, calls };
}
test('send acknowledgment is PROCESSING, not acceptance; completion uses fencing token', async () => {
  const f = fixture();
  let sends = 0;
  const result = await runDeliveryOnce(f.db, scope, {
    send: async () => {
      sends++;
      return { outcome: 'PROCESSING', trackId: 'track-1', evidence: { acknowledged: true } };
    },
    reconcile: async () => {
      throw Error('must not reconcile');
    },
  });
  assert.equal(result.result, 'PROCESSING');
  assert.equal(sends, 1);
  assert.equal(f.calls[1].values[1], claim.claimToken);
});
test('recovery only reconciles and never resends, even without trackId', async () => {
  for (const trackId of [null, 'track-1']) {
    const f = fixture({ ...claim, action: 'RECONCILE', trackId });
    let reads = 0;
    const r = await runDeliveryOnce(f.db, scope, {
      send: async () => {
        throw Error('POST not allowed');
      },
      reconcile: async () => {
        reads++;
        return { outcome: 'UNCONFIRMED', evidence: { notFound: true } };
      },
    });
    assert.equal(reads, 1);
    assert.equal(r.result, 'UNCONFIRMED');
  }
});
test('timeout is recorded without leaking exception text or retrying', async () => {
  const f = fixture();
  let count = 0;
  const gateway: DeliveryGateway = {
    send: async () => {
      count++;
      throw Error('secret-token');
    },
    reconcile: async () => {
      throw Error('unused');
    },
  };
  assert.equal((await runDeliveryOnce(f.db, scope, gateway)).result, 'UNCONFIRMED');
  assert.equal(count, 1);
  assert.ok(!JSON.stringify(f.calls).includes('secret-token'));
});
test('failed completion propagates and never repeats POST in the same invocation', async () => {
  let sends = 0;
  const db: FiscalRegistrationConnection = {
    query: async (sql) => {
      if (sql.includes('claim_delivery')) return { rows: [{ claim }] };
      throw Error('DB unavailable');
    },
  };
  await assert.rejects(
    runDeliveryOnce(db, scope, {
      send: async () => {
        sends++;
        return { outcome: 'ACCEPTED', evidence: { codigo: 1 } };
      },
      reconcile: async () => {
        throw Error('unused');
      },
    }),
    /DB unavailable/,
  );
  assert.equal(sends, 1);
});
test('scope and artifact tampering blocked before any network call', () => {
  for (const patch of [
    { scope: { ...scope, tenantId: 'other' } },
    { sha256: '0'.repeat(64) },
    { route: 'RFCE' },
    { action: 'OTHER' },
    { trackId: 'x&y' },
    { claimToken: 'bad' },
  ])
    assert.throws(() => parseDeliveryClaim({ ...claim, ...patch }, scope));
});
test('expired lease returns LEASE_LOST and mismatched track response cannot overwrite identity', async () => {
  const f = fixture(claim, false);
  const gateway: DeliveryGateway = {
    send: async () => ({ outcome: 'ACCEPTED', evidence: {} }),
    reconcile: async () => ({ outcome: 'ACCEPTED', trackId: 'other', evidence: {} }),
  };
  assert.equal((await runDeliveryOnce(f.db, scope, gateway)).result, 'LEASE_LOST');
  const g = fixture({ ...claim, action: 'RECONCILE', trackId: 'original' });
  assert.equal((await runDeliveryOnce(g.db, scope, gateway)).result, 'UNCONFIRMED');
  assert.equal(g.calls[1].values[3], '');
});
test('idle and production gate do not send', async () => {
  const gateway: DeliveryGateway = {
    send: async () => {
      throw Error('unused');
    },
    reconcile: async () => {
      throw Error('unused');
    },
  };
  assert.equal((await runDeliveryOnce(fixture(null).db, scope, gateway)).result, 'IDLE');
  const f = fixture();
  await assert.rejects(
    runDeliveryOnce(f.db, { ...scope, environment: 'production' }, gateway),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  assert.equal(f.calls.length, 0);
});

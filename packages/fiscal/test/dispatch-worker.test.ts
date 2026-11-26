import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runDispatchOnce } from '../src/dispatch-worker.ts';
import type { DispatchClaim, FiscalDispatchQueue } from '../src/dispatch-worker.ts';
import { analyzeFiscalRequest } from '../src/mapper.ts';
import { FiscalTransportError } from '../src/registration-client.ts';
import { scope } from './fixtures.ts';

async function fixture() {
  const input = JSON.parse(
    await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
  );
  const analyzed = analyzeFiscalRequest(scope, input);
  const claim: DispatchClaim = {
    id: '1',
    leaseToken: 'synthetic-lease',
    requestText: JSON.stringify(analyzed.request),
    payloadSha256: analyzed.payloadSha256,
  };
  const events: string[] = [];
  const queue: FiscalDispatchQueue = {
    claim: async () => claim,
    acknowledge: async (job) => {
      assert.equal(job, claim);
      events.push('ack');
      return true;
    },
    defer: async (job, reason) => {
      assert.equal(job, claim);
      events.push(reason);
      return true;
    },
  };
  const result = {
    documentId: '1',
    encf: 'E310000000001',
    payloadSha256: claim.payloadSha256,
    stage: 'RESERVED' as const,
    sendable: false as const,
  };
  return { claim, queue, events, result };
}

test('dispatcher sends the frozen snapshot and acknowledges only a matching registration', async () => {
  const f = await fixture();
  assert.deepEqual(
    await runDispatchOnce(f.queue, scope, async (input) => {
      assert.equal(JSON.stringify(input), f.claim.requestText);
      return f.result;
    }),
    { result: 'REGISTERED' },
  );
  assert.deepEqual(f.events, ['ack']);
});

test('dispatcher distinguishes uncertain delivery from permanent HTTP rejection', async () => {
  for (const [outcome, expected, event] of [
    ['UNCONFIRMED', 'DEFERRED', 'UNCONFIRMED'],
    ['REJECTED', 'REVIEW_REQUIRED', 'REJECTED'],
  ] as const) {
    const f = await fixture();
    assert.deepEqual(
      await runDispatchOnce(f.queue, scope, async () => {
        throw new FiscalTransportError(outcome);
      }),
      { result: expected },
    );
    assert.deepEqual(f.events, [event]);
  }
});

test('corrupt snapshot is quarantined without reaching transport', async () => {
  const f = await fixture();
  const corrupt = { ...f.claim, payloadSha256: '0'.repeat(64) };
  const queue = {
    ...f.queue,
    claim: async () => corrupt,
    defer: async (_claim: DispatchClaim, reason: string) => {
      assert.equal(reason, 'INVALID_SNAPSHOT');
      return true;
    },
  };
  assert.deepEqual(
    await runDispatchOnce(queue, scope, async () => {
      assert.fail('must not send');
    }),
    { result: 'REVIEW_REQUIRED' },
  );
});

test('lost acknowledgment write never invokes a second send or a failure update', async () => {
  const f = await fixture();
  let sends = 0;
  f.queue.acknowledge = async () => {
    throw new Error('DB unavailable');
  };
  await assert.rejects(
    runDispatchOnce(f.queue, scope, async () => {
      sends++;
      return f.result;
    }),
  );
  assert.equal(sends, 1);
  assert.deepEqual(f.events, []);
});

test('stale lease cannot acknowledge; mismatch cannot be marked registered', async () => {
  const f = await fixture();
  f.queue.acknowledge = async () => false;
  assert.deepEqual(await runDispatchOnce(f.queue, scope, async () => f.result), {
    result: 'LEASE_LOST',
  });
  assert.deepEqual(
    await runDispatchOnce(f.queue, scope, async () => ({
      ...f.result,
      payloadSha256: '0'.repeat(64),
    })),
    { result: 'DEFERRED' },
  );
  assert.deepEqual(f.events, ['UNCONFIRMED']);
});

test('empty queue has no transport activity', async () => {
  const f = await fixture();
  f.queue.claim = async () => null;
  assert.deepEqual(
    await runDispatchOnce(f.queue, scope, async () => {
      assert.fail();
    }),
    { result: 'IDLE' },
  );
});

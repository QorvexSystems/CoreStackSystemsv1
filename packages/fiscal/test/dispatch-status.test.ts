import assert from 'node:assert/strict';
import test from 'node:test';
import { readDispatchedInvoicePreparation } from '../src/dispatch-status.ts';
import { scope } from './fixtures.ts';

test('status lookup binds invoice, tenant, RNC and environment before remote access', async () => {
  const absent = await readDispatchedInvoicePreparation(
    {
      query: async (sql, params) => {
        assert.match(sql, /JOIN public\."Invoice"/);
        assert.deepEqual(params, [scope.tenantId, scope.issuerRnc, scope.environment, 'invoice-1']);
        return { rows: [] };
      },
    },
    scope,
    'invoice-1',
    async () => assert.fail('no remote access for missing scoped invoice'),
  );
  assert.equal(absent, null);
});
test('pending and review-required dispatches never poll an invented remote ID', async () => {
  for (const state of ['PENDING', 'RUNNING', 'REVIEW_REQUIRED']) {
    const result = await readDispatchedInvoicePreparation(
      { query: async () => ({ rows: [{ state }] }) },
      scope,
      'invoice-1',
      async () => assert.fail(),
    );
    assert.equal(result!.preparation, null);
    assert.equal(result!.sendable, false);
  }
});
test('registered lookup uses frozen IDs and failed remote reads never write/requeue', async () => {
  let calls = 0;
  await assert.rejects(
    readDispatchedInvoicePreparation(
      {
        query: async (sql) => {
          calls++;
          assert.match(sql, /^SELECT/);
          return { rows: [{ state: 'REGISTERED', document_id: '42', encf: 'E310000000042' }] };
        },
      },
      scope,
      'invoice-1',
      async (expected) => {
        assert.deepEqual(expected, { documentId: '42', encf: 'E310000000042' });
        throw new Error('TRANSPORT_UNCONFIRMED');
      },
    ),
    /TRANSPORT_UNCONFIRMED/,
  );
  assert.equal(calls, 1);
});

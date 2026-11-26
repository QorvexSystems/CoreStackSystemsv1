import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { registerFiscalRequest } from '../src/request-repository.ts';
import { scope } from './fixtures.ts';

const input = JSON.parse(
  await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
);

test('repository validates before SQL; parameters preserve canonical digest and bigint ID', async () => {
  let called = 0;
  const result = await registerFiscalRequest(
    {
      query: async (sql, values) => {
        called++;
        assert.ok(sql.includes('$1::text, $2::text'));
        assert.equal(createHash('sha256').update(values[0]!).digest('hex'), values[1]);
        assert.equal(JSON.parse(values[0]!).scope.tenantId, scope.tenantId);
        return {
          rows: [{ document_id: '9007199254740993', encf: 'E310000000001', reused: false }],
        };
      },
    },
    scope,
    input,
  );
  assert.equal(called, 1);
  assert.equal(result.documentId, '9007199254740993');
  assert.equal(result.sendable, false);
  assert.equal(result.stage, 'RESERVED');
});

test('invalid totals and production never reach database', async () => {
  const connection = {
    query: async () => {
      throw new Error('MUST_NOT_REACH_DB');
    },
  };
  await assert.rejects(
    registerFiscalRequest(connection, scope, {
      ...input,
      expectedTotals: { ...input.expectedTotals, total: '0.01' },
    }),
    (error) => error instanceof Error && error.message !== 'MUST_NOT_REACH_DB',
  );
  await assert.rejects(
    registerFiscalRequest(connection, { ...scope, environment: 'production' }, input),
    /PRODUCTION_DISABLED/,
  );
});

test('lost DB response retries identical snapshot; no invented operation or number', async () => {
  const calls: (readonly string[])[] = [];
  const connection = {
    query: async (_sql: string, values: readonly string[]) => {
      calls.push(values);
      if (calls.length === 1) throw new Error('synthetic lost response');
      return { rows: [{ document_id: '12', encf: 'E310000000001', reused: true }] };
    },
  };
  await assert.rejects(registerFiscalRequest(connection, scope, input), /synthetic lost response/);
  assert.equal((await registerFiscalRequest(connection, scope, input)).reused, true);
  assert.deepEqual(calls[0], calls[1]);
});

test('malformed database result is not returned as a registered document', async () => {
  for (const rows of [
    [],
    [{ document_id: 12, encf: 'E310000000001', reused: false }],
    [{ document_id: '12', encf: 'E320000000001', reused: false }],
  ]) {
    await assert.rejects(
      registerFiscalRequest({ query: async () => ({ rows }) }, scope, input),
      /INVALID_PERSISTENCE_RESULT/,
    );
  }
});

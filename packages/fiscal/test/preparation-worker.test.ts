import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serializeFiscalSnapshot, snapshotFiscalRequest } from '../src/contract.ts';
import { runPreparationOnce } from '../src/preparation-worker.ts';
import { SchemaValidationError, SchemaUnavailableError } from '../src/xsd-validator.ts';
import { scope } from './fixtures.ts';

const input = JSON.parse(
  await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
);
const claim = {
  jobId: '1',
  documentId: '1',
  claimToken: '00000000-0000-4000-8000-000000000001',
  snapshotText: serializeFiscalSnapshot(scope, input),
  payloadSha256: snapshotFiscalRequest(scope, input).payloadSha256,
  encf: 'E310000000001',
  validUntil: '2027-12-31',
  plannedSignatureAt: '2026-09-21T10:00:00-04:00',
};

test('worker prepares actual E31 XSD-valid unsigned XML and stores exact hash', async () => {
  let stored = false;
  const result = await runPreparationOnce(
    {
      query: async (sql, values) => {
        if (sql.includes('claim_preparation')) return { rows: [{ claim }] };
        assert.ok(sql.includes('complete_preparation'));
        assert.equal(values[0], claim.jobId);
        assert.equal(values[1], claim.claimToken);
        assert.ok(values[2]!.includes('<eNCF>E310000000001</eNCF>'));
        assert.equal(createHash('sha256').update(values[2]!).digest('hex'), values[3]);
        assert.match(values[4]!, /^[a-f0-9]{64}$/);
        stored = true;
        return { rows: [{ stored: true }] };
      },
    },
    scope,
  );
  assert.equal(stored, true);
  assert.equal(result.result, 'UNSIGNED_XML_STORED');
  assert.equal(result.sendable, false);
});

test('idle worker does not validate or persist', async () => {
  let calls = 0;
  const result = await runPreparationOnce(
    {
      query: async () => {
        calls++;
        return { rows: [{ claim: null }] };
      },
    },
    scope,
  );
  assert.equal(calls, 1);
  assert.equal(result.result, 'IDLE');
});

test('tampered snapshot is failed without generating XML', async () => {
  const codes: string[] = [];
  const result = await runPreparationOnce(
    {
      query: async (sql, values) => {
        if (sql.includes('claim_preparation'))
          return { rows: [{ claim: { ...claim, payloadSha256: '0'.repeat(64) } }] };
        assert.ok(sql.includes('fail_preparation'));
        codes.push(values[2]!);
        return { rows: [{ state: 'FAILED' }] };
      },
    },
    scope,
    {
      validateUnsignedEcf: async () => {
        throw new Error('MUST_NOT_VALIDATE');
      },
    },
  );
  assert.deepEqual(codes, ['INVALID_SNAPSHOT']);
  assert.equal(result.result, 'FAILED');
});

test('schema validation failure is permanent; missing schema is retryable, no raw messages', async () => {
  for (const [error, code, state] of [
    [new SchemaValidationError(), 'INVALID_XML', 'FAILED'],
    [new SchemaUnavailableError(31), 'SCHEMA_UNAVAILABLE', 'PENDING'],
  ] as const) {
    const result = await runPreparationOnce(
      {
        query: async (sql, values) => {
          if (sql.includes('claim_preparation')) return { rows: [{ claim }] };
          assert.ok(sql.includes('fail_preparation'));
          assert.equal(values[2], code);
          return { rows: [{ state }] };
        },
      },
      scope,
      {
        validateUnsignedEcf: async () => {
          throw error;
        },
      },
    );
    assert.equal(result.result, state);
    assert.equal('xml' in result, false);
  }
});

test('lost completion response is uncertain, never followed by fail or new reservation', async () => {
  const calls: string[] = [];
  const result = await runPreparationOnce(
    {
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes('claim_preparation')) return { rows: [{ claim }] };
        throw new Error('synthetic network loss after commit');
      },
    },
    scope,
    { validateUnsignedEcf: async () => {} },
  );
  assert.equal(result.result, 'UNCERTAIN');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.includes('complete_preparation'));
});

test('production worker never accesses DB', async () => {
  await assert.rejects(
    runPreparationOnce(
      {
        query: async () => {
          throw new Error('MUST_NOT_QUERY');
        },
      },
      { ...scope, environment: 'production' },
    ),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
});

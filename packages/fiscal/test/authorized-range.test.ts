import assert from 'node:assert/strict';
import test from 'node:test';
import { FiscalContractError } from '../src/contract.ts';
import {
  parseAuthorizedRangeInput,
  registerAuthorizedRange,
} from '../src/authorized-range-repository.ts';

const scope = {
  tenantId: 'tenant-rivnu',
  issuerRnc: '40220429126',
  environment: 'production',
} as const;
const input = {
  registrationId: 'cm12345678901234567890',
  tenantId: scope.tenantId,
  issuerRnc: scope.issuerRnc,
  ecfType: 31 as const,
  startNumber: '1',
  endNumber: '9999999999',
  nextNumber: '1',
  authorizationNumber: 'DGII-PROD-1',
  authorizedAt: '2026-10-31',
  validUntil: '2027-12-31',
};

test('validates exact production scope and preserves ten-digit ranges as strings', () => {
  const parsed = parseAuthorizedRangeInput(scope, input);
  assert.equal(parsed.endNumber, '9999999999');
  for (const changed of [
    { ...input, tenantId: 'another' },
    { ...input, ecfType: 35 },
    { ...input, startNumber: '0' },
    { ...input, endNumber: '10000000000' },
    { ...input, nextNumber: '2', endNumber: '1' },
    { ...input, validUntil: '2026-99-99' },
    { ...input, extra: 'not-allowed' },
  ]) {
    assert.throws(() => parseAuthorizedRangeInput(scope, changed), FiscalContractError);
  }
  assert.throws(
    () => parseAuthorizedRangeInput({ ...scope, environment: 'certification' }, input),
    FiscalContractError,
  );
});

test('registration calls only the reviewed function and validates the idempotent acknowledgment', async () => {
  let captured: readonly string[] = [];
  const result = await registerAuthorizedRange(
    {
      query: async (sql, values) => {
        assert.match(sql, /corestack_fiscal\.register_authorized_range/);
        captured = values;
        return { rows: [{ range_id: '7', reused: false }] };
      },
    },
    scope,
    input,
  );
  assert.deepEqual(result, {
    rangeId: '7',
    registrationId: input.registrationId,
    reused: false,
    status: 'REGISTERED',
    environment: 'production',
  });
  assert.deepEqual(captured, [
    input.registrationId,
    scope.tenantId,
    scope.issuerRnc,
    '31',
    '1',
    '9999999999',
    '1',
    'DGII-PROD-1',
    '2026-10-31',
    '2027-12-31',
  ]);
});

test('invalid database acknowledgment fails closed', async () => {
  await assert.rejects(
    registerAuthorizedRange({ query: async () => ({ rows: [] }) }, scope, input),
    FiscalContractError,
  );
});

test('database range conflicts are permanent contract rejections', async () => {
  await assert.rejects(
    registerAuthorizedRange(
      {
        query: async () => {
          throw Object.assign(new Error('sanitized'), { code: '23P01' });
        },
      },
      scope,
      input,
    ),
    (error: unknown) =>
      error instanceof FiscalContractError && error.code === 'AUTHORIZED_RANGE_CONFLICT',
  );
});

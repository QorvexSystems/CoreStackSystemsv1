import assert from 'node:assert/strict';
import test from 'node:test';
import { createFiscalRegistrationClient } from '../src/registration-client.ts';
import { scope } from './fixtures.ts';

const config = {
  origin: 'https://127.0.0.1:8443',
  ca: '-----BEGIN CERTIFICATE-----synthetic-placeholder',
  bearerToken: 'synthetic_client_token_0123456789012345678901234',
  scope,
};

test('registration client rejects insecure, redirected or credential-bearing destinations', () => {
  for (const origin of [
    'http://127.0.0.1',
    'https://user:pass@example.com',
    'https://example.com/other',
    'https://example.com/?scope=other',
    'https://example.com/#fragment',
  ]) {
    assert.throws(
      () => createFiscalRegistrationClient({ ...config, origin }),
      /INVALID_FISCAL_TRANSPORT_CONFIG/,
    );
  }
  for (const patch of [
    { ca: '' },
    { bearerToken: 'weak' },
    { timeoutMs: 0 },
    { timeoutMs: 31_000 },
  ]) {
    assert.throws(
      () => createFiscalRegistrationClient({ ...config, ...patch }),
      /INVALID_FISCAL_TRANSPORT_CONFIG/,
    );
  }
  assert.throws(
    () => createFiscalRegistrationClient({
      ...config,
      scope: { ...scope, environment: 'production' as const },
    }),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
});

test('invalid fiscal payload is rejected locally before any network request', async () => {
  const send = createFiscalRegistrationClient(config);
  await assert.rejects(send({ scope: { tenantId: 'other' } }));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFiscalPreparationClient } from '../src/preparation-client.ts';
import { scope } from './fixtures.ts';

const config = {
  origin: 'https://127.0.0.1:8443',
  ca: '-----BEGIN CERTIFICATE-----synthetic',
  bearerToken: 'synthetic_client_token_0123456789012345678901234',
  scope,
};
test('preparation reader rejects unsafe transports and production configuration', () => {
  for (const patch of [
    { origin: 'http://127.0.0.1' },
    { origin: 'https://user:pass@127.0.0.1' },
    { origin: 'https://127.0.0.1/redirect' },
    { ca: '' },
    { bearerToken: 'short' },
    { timeoutMs: 0 },
    { scope: { ...scope, environment: 'production' as const } },
  ])
    assert.throws(() => createFiscalPreparationClient({ ...config, ...patch }));
});
test('preparation reader rejects untrusted identifiers before opening a socket', async () => {
  const read = createFiscalPreparationClient(config);
  for (const documentId of ['0', '../1', '9223372036854775808', '1?tenant=other'])
    await assert.rejects(read({ documentId, encf: 'E310000000001' }), /INVALID_DOCUMENT_ID/);
  await assert.rejects(read({ documentId: '1', encf: 'B0100000001' }), /INVALID_EXPECTED_ENCF/);
});

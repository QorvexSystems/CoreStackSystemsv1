import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createFiscalRegistrationServer } from '../src/http-service.ts';
const scope = {
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'precertification' as const,
};
const token = 'synthetic_rehearsal_http_test_token_012345678901234';
const connection = { query: async () => ({ rows: [] }) };
test('rehearsal hook requires explicit preview scope and activation', async () => {
  const config = {
    scope,
    bearerToken: token,
    connection,
    syntheticRehearsal: async () => ({ synthetic: true }),
  };
  delete process.env.FISCAL_SYNTHETIC_PREVIEW;
  assert.throws(() => createFiscalRegistrationServer(config), /PREVIEW_ONLY/);
  process.env.FISCAL_SYNTHETIC_PREVIEW = 'NO_FISCAL_VALIDITY';
  assert.throws(
    () =>
      createFiscalRegistrationServer({ ...config, scope: { ...scope, tenantId: 'real-tenant' } }),
    /PREVIEW_ONLY/,
  );
  assert.throws(
    () =>
      createFiscalRegistrationServer({ ...config, scope: { ...scope, environment: 'production' } }),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  delete process.env.FISCAL_SYNTHETIC_PREVIEW;
});
test('rehearsal route authenticates, rejects bodies, distinguishes read and start', async () => {
  process.env.FISCAL_SYNTHETIC_PREVIEW = 'NO_FISCAL_VALIDITY';
  const calls: unknown[] = [];
  const server = createFiscalRegistrationServer({
    scope,
    bearerToken: token,
    connection,
    syntheticRehearsal: async (id, start) => {
      calls.push({ id, start });
      return { synthetic: true, sendable: false };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/v1/documents/1/synthetic-rehearsal`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await fetch(url, { headers, method: 'POST' })).status, 200);
    assert.equal((await fetch(url, { headers, method: 'POST', body: '{}' })).status, 400);
    assert.deepEqual(calls, [
      { id: '1', start: false },
      { id: '1', start: true },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.FISCAL_SYNTHETIC_PREVIEW;
  }
});

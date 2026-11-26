import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createFiscalRegistrationServer } from '../src/http-service.ts';
import { scope } from './fixtures.ts';

test('preparation route requires auth, uses only scoped SQL and returns no-store', async () => {
  const token = 'synthetic_read_preparation_token_01234567890123456789';
  let calls = 0;
  let unavailable = false;
  const server = createFiscalRegistrationServer({
    scope,
    bearerToken: token,
    connection: {
      query: async (_sql, values) => {
        calls++;
        if (unavailable) throw new Error('private SQL details');
        return {
          rows: [
            {
              preparation:
                values[0] === '1'
                  ? {
                      documentId: '1',
                      encf: 'E310000000001',
                      state: 'PENDING',
                      attempts: 0,
                      lastErrorCode: null,
                      xml: null,
                      xmlSha256: null,
                      schemaSha256: null,
                      sendable: false,
                    }
                  : null,
            },
          ],
        };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${origin}/internal/v1/documents/1/preparation`)).status, 401);
    assert.equal(calls, 0);
    const pending = await fetch(`${origin}/internal/v1/documents/1/preparation`, { headers });
    assert.equal(pending.status, 200);
    assert.equal(pending.headers.get('cache-control'), 'no-store');
    const data = await pending.json();
    assert.equal(data.state, 'PENDING');
    assert.equal(data.schemaValidated, false);
    assert.equal(data.sendable, false);
    assert.equal(
      (await fetch(`${origin}/internal/v1/documents/2/preparation`, { headers })).status,
      404,
    );
    assert.equal(
      (await fetch(`${origin}/internal/v1/documents/9223372036854775808/preparation`, { headers }))
        .status,
      400,
    );
    assert.equal(calls, 2);
    unavailable = true;
    const failed = await fetch(`${origin}/internal/v1/documents/1/preparation`, { headers });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'PREPARATION_UNAVAILABLE' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

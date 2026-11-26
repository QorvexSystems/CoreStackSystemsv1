import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  createFiscalPreflightServer,
  createFiscalRegistrationServer,
} from '../src/http-service.ts';
import type { FiscalRegistrationConnection } from '../src/request-repository.ts';
import { scope } from './fixtures.ts';

const token = 'synthetic_registration_token_not_for_use_0123456789';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const example = async () =>
  JSON.parse(await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'));
async function withServer(
  connection: FiscalRegistrationConnection | null,
  run: (url: string) => Promise<void>,
) {
  const config = { scope, bearerToken: token };
  const server = connection
    ? createFiscalRegistrationServer({ ...config, connection })
    : createFiscalPreflightServer(config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('existing preflight cannot register; receiver rejects production and missing DB', async () => {
  await withServer(null, async (url) => {
    assert.equal(
      (
        await fetch(`${url}/internal/v1/requests`, {
          method: 'POST',
          headers,
          body: JSON.stringify(await example()),
        })
      ).status,
      404,
    );
  });
  assert.throws(
    () =>
      createFiscalRegistrationServer({
        scope: { ...scope, environment: 'production' },
        bearerToken: token,
        connection: { query: async () => ({ rows: [] }) },
      }),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  assert.throws(
    () =>
      createFiscalRegistrationServer({ scope, bearerToken: token, connection: undefined as never }),
    /MISSING_REGISTRATION_CONNECTION/,
  );
});

test('authentication and scope validation precede any persistence', async () => {
  let calls = 0;
  await withServer(
    {
      query: async () => {
        calls++;
        return { rows: [] };
      },
    },
    async (url) => {
      const input = await example();
      for (const [requestHeaders, body, status] of [
        [{ ...headers, authorization: 'Bearer wrong' }, input, 401],
        [headers, { ...input, scope }, 422],
        [headers, { ...input, issuer: { ...input.issuer, rnc: '101010641' } }, 422],
      ] as const) {
        assert.equal(
          (
            await fetch(`${url}/internal/v1/requests`, {
              method: 'POST',
              headers: requestHeaders,
              body: JSON.stringify(body),
            })
          ).status,
          status,
        );
      }
      assert.equal(calls, 0);
    },
  );
});

test('replayed request preserves canonical snapshot and operation; never reports DGII acceptance', async () => {
  const captured: string[][] = [];
  await withServer(
    {
      query: async (_sql, params) => {
        captured.push([...params]);
        return { rows: [{ document_id: '1', encf: 'E310000000001', reused: captured.length > 1 }] };
      },
    },
    async (url) => {
      for (const reused of [false, true]) {
        const response = await fetch(`${url}/internal/v1/requests`, {
          method: 'POST',
          headers,
          body: JSON.stringify(await example()),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.reused, reused);
        assert.equal(body.persisted, true);
        assert.equal(body.sendable, false);
        assert.equal(body.schemaValidated, false);
        assert.equal(body.stage, 'RESERVED');
        assert.equal(body.xml, undefined);
      }
      assert.deepEqual(captured[0], captured[1]);
      assert.equal(captured.length, 2);
    },
  );
});

test('DB errors and invalid acknowledgments are uncertain, sanitized and replayable', async () => {
  for (const query of [
    async () => {
      throw new Error('private SQL password XML details');
    },
    async () => ({ rows: [] }),
  ]) {
    await withServer({ query }, async (url) => {
      const response = await fetch(`${url}/internal/v1/requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify(await example()),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: 'REGISTRATION_UNCONFIRMED',
        retry: 'SAME_OPERATION_AND_PAYLOAD',
        sendable: false,
      });
    });
  }
});

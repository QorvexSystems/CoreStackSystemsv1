import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createFiscalPreflightServer } from '../src/http-service.ts';
import { scope } from './fixtures.ts';

const token = 'synthetic_test_token_not_for_deployment_0123456789';
async function withServer(run: (url: string) => Promise<void>) {
  const server = createFiscalPreflightServer({ scope, bearerToken: token });
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
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const example = async () =>
  JSON.parse(await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'));

test('preflight fails closed for production and weak/missing credentials', () => {
  assert.throws(
    () =>
      createFiscalPreflightServer({
        scope: { ...scope, environment: 'production' },
        bearerToken: token,
      }),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  for (const bearerToken of ['', 'change-me', 'short', 'x'.repeat(129)]) {
    assert.throws(
      () => createFiscalPreflightServer({ scope, bearerToken }),
      /INVALID_SERVICE_TOKEN/,
    );
  }
});

test('health is liveness only and fiscal input always requires credentials', async () =>
  withServer(async (url) => {
    const health = await fetch(`${url}/health/live`);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      mode: 'offline-preflight',
      sendable: false,
    });
    for (const authorization of ['', 'Bearer wrong', `Bearer ${token}x`]) {
      const response = await fetch(`${url}/internal/v1/analyze`, {
        method: 'POST',
        headers: { ...headers, authorization },
        body: '{}',
      });
      assert.equal(response.status, 401);
    }
  }));

test('authenticated analysis returns only a non-persisted result and never emits a document', async () =>
  withServer(async (url) => {
    const input = await example();
    const response = await fetch(`${url}/internal/v1/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.sendable, false);
    assert.equal(result.persisted, false);
    assert.equal(result.schemaValidated, false);
    assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.type, 31);
    assert.equal(result.request, undefined);
    assert.equal(result.encf, undefined);
  }));

test('body cannot select a different issuer or override the server fiscal scope', async () =>
  withServer(async (url) => {
    for (const input of [
      { ...(await example()), scope: { ...scope, environment: 'production' } },
      { ...(await example()), issuer: { ...(await example()).issuer, rnc: '101010641' } },
    ]) {
      const response = await fetch(`${url}/internal/v1/analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 422);
    }
  }));

test('malformed, compressed and oversized inputs and unknown routes are rejected', async () =>
  withServer(async (url) => {
    for (const [body, expected] of [
      ['{', 400],
      ['null', 400],
      ['[]', 400],
      ['x'.repeat(512 * 1024 + 1), 413],
    ] as const) {
      assert.equal(
        (await fetch(`${url}/internal/v1/analyze`, { method: 'POST', headers, body })).status,
        expected,
      );
    }
    assert.equal(
      (
        await fetch(`${url}/internal/v1/analyze`, {
          method: 'POST',
          headers: { ...headers, 'content-encoding': 'gzip' },
          body: '{}',
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await fetch(`${url}/internal/v1/analyze`, {
          method: 'POST',
          headers: { authorization: headers.authorization },
          body: '{}',
        })
      ).status,
      415,
    );
    assert.equal(
      (await fetch(`${url}/internal/v1/issue`, { method: 'POST', headers, body: '{}' })).status,
      404,
    );
  }));

test('sales draft adapter is accessible internally and still rejects another tenant', async () =>
  withServer(async (url) => {
    const input = {
      id: 'draft-1',
      revision: '1',
      operationId: 'op-1',
      tenantId: scope.tenantId,
      pricingProfile: 'ERP_NET_UNIT_PRICE_V1',
      status: 'DRAFT',
      fiscalStatus: 'NOT_APPLICABLE',
      ncf: null,
      eNcf: null,
      documentType: 'CONSUMER_ELECTRONIC_32',
      issuedOn: '2026-09-20',
      incomeType: '01',
      paymentMode: 'CASH',
      dueOn: null,
      issuer: { rnc: scope.issuerRnc, legalName: 'Synthetic issuer', address: 'Synthetic address' },
      customer: null,
      items: [
        {
          id: 'line-1',
          description: 'Synthetic good',
          kind: 'GOOD',
          quantity: '2',
          originalUnitPrice: '100',
          unitPrice: '95',
          discountTotal: '10',
          taxCategory: 'ITBIS_18',
          taxRate: '0.18',
          subtotal: '190',
          taxTotal: '34.20',
          total: '224.20',
        },
      ],
      subtotal: '190',
      discountTotal: '10',
      taxTotal: '34.20',
      total: '224.20',
    };
    const response = await fetch(`${url}/internal/v1/sales-drafts/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sendable, false);
    const rejected = await fetch(`${url}/internal/v1/sales-drafts/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...input, tenantId: 'another-tenant' }),
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error, 'ERP_TENANT_MISMATCH');
  }));

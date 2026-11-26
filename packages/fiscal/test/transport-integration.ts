import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createFiscalRegistrationClient } from '../src/registration-client.ts';
import { createFiscalPreparationClient } from '../src/preparation-client.ts';
import { createHash } from 'node:crypto';
import type { FiscalScope } from '../src/catalog.ts';

export async function testTransport(
  tls: { cert: string; key: string },
  ca: string,
  scope: FiscalScope,
  input: unknown,
) {
  let count = 0;
  let mode = 'redirect';
  const server = createServer(tls, (req, res) => {
    count++;
    req.resume();
    if (mode === 'timeout') return;
    if (mode.startsWith('read-')) {
      const xml = '<ECF>synthetic</ECF>';
      const status = mode === 'read-absent' ? 404 : mode === 'read-denied' ? 403 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      const result = {
        documentId: '1',
        encf: 'E310000000001',
        state: 'DONE',
        attempts: 1,
        lastErrorCode: null,
        xml,
        xmlSha256: createHash('sha256').update(xml).digest('hex'),
        schemaSha256: 'a'.repeat(64),
        schemaValidated: true,
        signed: false,
        sendable: false,
      };
      res.end(
        JSON.stringify({
          ...result,
          ...(mode === 'read-corrupt' ? { xml: '<changed/>' } : {}),
          ...(mode === 'read-wrong-document' ? { documentId: '2' } : {}),
          ...(mode === 'read-wrong-encf' ? { encf: 'E310000000002' } : {}),
          ...(mode === 'read-signed' ? { signed: true } : {}),
          ...(mode === 'read-wrong-validation' ? { schemaValidated: false } : {}),
        }),
      );
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(307, { Location: 'https://example.invalid/secret' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      mode === 'oversized'
        ? 'x'.repeat(9000)
        : JSON.stringify({
            documentId: '1',
            encf: 'E310000000001',
            payloadSha256: '0'.repeat(64),
            reused: false,
            stage: 'RESERVED',
            sendable: false,
            persisted: true,
            schemaValidated: false,
          }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const send = createFiscalRegistrationClient({
      origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ca,
      scope,
      bearerToken: 'synthetic_transport_token_01234567890123456789',
      timeoutMs: 500,
    });
    for (mode of ['redirect', 'wrong-digest', 'oversized', 'timeout']) {
      const before = count;
      await assert.rejects(send(input), { outcome: 'UNCONFIRMED' });
      assert.equal(count, before + 1); // no redirects, retries or duplicate POSTs
    }
    const read = createFiscalPreparationClient({
      origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ca,
      scope,
      bearerToken: 'synthetic_transport_token_01234567890123456789',
      timeoutMs: 500,
    });
    const expected = { documentId: '1', encf: 'E310000000001' };
    mode = 'read-ok';
    assert.equal((await read(expected))!.state, 'DONE');
    for (mode of [
      'read-corrupt',
      'read-wrong-document',
      'read-wrong-encf',
      'read-signed',
      'read-wrong-validation',
      'read-absent',
      'redirect',
      'timeout',
    ]) {
      const before = count;
      await assert.rejects(read(expected), { outcome: 'UNCONFIRMED' });
      assert.equal(count, before + 1);
    }
    mode = 'read-denied';
    await assert.rejects(read(expected), { outcome: 'REJECTED' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

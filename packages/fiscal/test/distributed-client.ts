import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createFiscalRegistrationClient } from '../src/registration-client.ts';
import { createFiscalPreparationClient } from '../src/preparation-client.ts';

const config = {
  origin: 'https://127.0.0.1:14082',
  ca: await readFile('/run/rehearsal.crt', 'utf8'),
  bearerToken: 'synthetic_distributed_rehearsal_token_0123456789',
  scope: {
    tenantId: 'synthetic-distributed',
    issuerRnc: '101010641',
    environment: 'precertification' as const,
  },
};
const input = JSON.parse(
  await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
);
input.issuer.rnc = config.scope.issuerRnc;
input.operationId = `distributed-${Date.now()}`;
input.source.documentId = input.operationId;
const send = createFiscalRegistrationClient(config);
const [first, retry] = await Promise.all([send(input), send(input)]);
assert.equal(first.documentId, retry.documentId);
assert.equal(first.encf, retry.encf);
assert.equal(first.reused || retry.reused, true);
const read = createFiscalPreparationClient(config);
let prepared;
for (let attempt = 0; attempt < 80; attempt++) {
  prepared = await read(first);
  if (prepared?.state === 'DONE' || prepared?.state === 'FAILED') break;
  await delay(250);
}
assert.equal(prepared?.state, 'DONE');
assert.equal(prepared.signed, false);
assert.equal(prepared.sendable, false);
assert.ok(prepared.xml?.includes('<ECF>'));
await assert.rejects(
  createFiscalPreparationClient({
    ...config,
    bearerToken: 'wrong_synthetic_distributed_token_012345678901234',
  })(first),
  { outcome: 'REJECTED' },
);
await assert.rejects(read({ ...first, encf: 'E310000000999' }), { outcome: 'UNCONFIRMED' });
console.log(
  JSON.stringify({
    result: 'PASS_DISTRIBUTED_SYNTHETIC',
    documentId: first.documentId,
    encf: first.encf,
    state: prepared.state,
    xmlSha256: prepared.xmlSha256,
    duplicate: 'same document',
    badToken: 'rejected',
    wrongDocument: 'rejected',
    signed: false,
    sendable: false,
  }),
);

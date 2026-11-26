import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFiscalPreparation } from '../src/preparation-repository.ts';

function fixture() {
  const xml = '<ECF>synthetic</ECF>';
  return {
    documentId: '1',
    encf: 'E310000000001',
    state: 'DONE',
    attempts: 1,
    lastErrorCode: null,
    xml,
    xmlSha256: createHash('sha256').update(xml).digest('hex'),
    schemaSha256: 'a'.repeat(64),
    sendable: false,
  };
}
test('reads through the scoped SQL function and verifies unsigned artifact digest', async () => {
  const result = await readFiscalPreparation(
    {
      query: async (sql, values) => {
        assert.equal(sql, 'SELECT corestack_fiscal.read_preparation($1::bigint) AS preparation');
        assert.deepEqual(values, ['1']);
        return { rows: [{ preparation: fixture() }] };
      },
    },
    '1',
  );
  assert.equal(result!.signed, false);
  assert.equal(result!.sendable, false);
  assert.equal(result!.schemaValidated, true);
});
test('missing and out-of-scope documents have the same absent result', async () => {
  assert.equal(
    await readFiscalPreparation({ query: async () => ({ rows: [{ preparation: null }] }) }, '1'),
    null,
  );
});
test('bad IDs never reach the database', async () => {
  for (const id of ['0', '-1', '1 OR 1=1', '9223372036854775808']) {
    await assert.rejects(
      readFiscalPreparation(
        {
          query: async () => {
            assert.fail();
          },
        },
        id,
      ),
      /INVALID_DOCUMENT_ID/,
    );
  }
});
test('corrupt artifact and wrong document response fail closed', async () => {
  for (const patch of [
    { xml: '<tampered/>' },
    { documentId: '2' },
    { sendable: true },
    { state: 'ACCEPTED' },
  ]) {
    await assert.rejects(
      readFiscalPreparation(
        { query: async () => ({ rows: [{ preparation: { ...fixture(), ...patch } }] }) },
        '1',
      ),
      /INVALID_PREPARATION_RESULT/,
    );
  }
});
test('pending preparation is not reported as XSD validated', async () => {
  const result = await readFiscalPreparation(
    {
      query: async () => ({
        rows: [
          {
            preparation: {
              ...fixture(),
              state: 'PENDING',
              attempts: 0,
              xml: null,
              xmlSha256: null,
              schemaSha256: null,
            },
          },
        ],
      }),
    },
    '1',
  );
  assert.equal(result!.schemaValidated, false);
  assert.equal(result!.xml, null);
});

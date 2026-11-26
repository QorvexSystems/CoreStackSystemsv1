import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { createPreviewRehearsal } from './preview-rehearsal.ts';
import { syntheticSigner } from './synthetic-signer.ts';
import { registerFiscalRequest } from '../src/request-repository.ts';
import { runPreparationOnce } from '../src/preparation-worker.ts';
import { readFiscalPreparation } from '../src/preparation-repository.ts';

const scope = {
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'precertification' as const,
};
const admin = new Client({
  host: '127.0.0.1',
  user: 'postgres',
  database: 'corestack_preview_remote',
});
const runtime = new Client({
  host: '127.0.0.1',
  user: 'preview_runtime',
  database: 'corestack_preview_remote',
});
await admin.connect();
try {
  for (const name of [
    '001_sequence_registry',
    '002_request_persistence',
    '003_preparation_worker',
    '004_delivery_queue',
  ])
    await admin.query(await readFile(new URL(`../sql/${name}.sql`, import.meta.url), 'utf8'));
  await admin.query(`CREATE ROLE preview_runtime LOGIN;
    GRANT USAGE ON SCHEMA corestack_fiscal TO preview_runtime;
    GRANT EXECUTE ON FUNCTION corestack_fiscal.register_request(text,text),corestack_fiscal.claim_preparation(),
    corestack_fiscal.complete_preparation(bigint,uuid,text,text,text,text),corestack_fiscal.fail_preparation(bigint,uuid,text),
    corestack_fiscal.read_preparation(bigint) TO preview_runtime;
    INSERT INTO corestack_fiscal.runtime_scope VALUES('preview_runtime','${scope.tenantId}','${scope.issuerRnc}','precertification');
    SELECT corestack_fiscal.register_range('${scope.tenantId}','${scope.issuerRnc}','precertification',t::smallint,1,100,'2026-01-01','2027-12-31','SYNTHETIC ONLY') FROM unnest(ARRAY[31,32]) t;`);
  await admin.query(await readFile('/fixtures/remote-rehearsal.sql', 'utf8'));
  await runtime.connect();
  const db = { query: (sql: string, values: readonly string[]) => runtime.query(sql, [...values]) };
  let engine = await createPreviewRehearsal(db, scope);
  await assert.rejects(syntheticSigner({ ...scope, environment: 'production' }, true));
  await assert.rejects(syntheticSigner({ ...scope, tenantId: 'real-tenant' }, true));
  await assert.rejects(runtime.query('SELECT * FROM corestack_fiscal.outbound_artifact'), {
    code: '42501',
  });
  assert.equal(await engine.request('99999', false), null);
  await assert.rejects(engine.request('99999', true));
  for (const type of [31, 32]) {
    const input = JSON.parse(
      await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
    );
    input.type = type;
    input.issuer.rnc = scope.issuerRnc;
    input.operationId = `preview-${type}`;
    input.source.documentId = `preview-${type}`;
    const ack = await registerFiscalRequest(db, scope, input);
    await runPreparationOnce(db, scope);
    const prepared = await readFiscalPreparation(db, ack.documentId);
    assert.equal(prepared?.state, 'DONE');
    await engine.request(ack.documentId, true);
    await engine.request(ack.documentId, true);
    await engine.cycle();
    const signedBefore = (
      await admin.query(
        'SELECT signed_ecf_sha256 FROM corestack_fiscal.outbound_artifact WHERE document_id=$1',
        [ack.documentId],
      )
    ).rows[0];
    assert.ok(signedBefore);
    // Simulate process restart: fresh signer/client and journal, same persisted queue/receipt.
    engine = await createPreviewRehearsal(db, scope);
    for (let i = 0; i < 4; i++) {
      await admin.query(
        'UPDATE corestack_fiscal.delivery_job SET available_at=clock_timestamp(); UPDATE preview_rehearsal.job SET available_at=clock_timestamp()',
      );
      await engine.cycle();
    }
    const result = (await engine.request(ack.documentId, false)) as {
      state: string;
      model: { sourceSha256: string; signedSha256: string; notice: string; qrUrl: string };
    };
    assert.equal(result.state, 'ACCEPTED');
    assert.ok(result.model);
    assert.equal(result.model.sourceSha256, prepared!.xmlSha256);
    assert.equal(result.model.signedSha256, signedBefore.signed_ecf_sha256);
    assert.ok(result.model.notice.includes('SIN VALIDEZ FISCAL'));
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM preview_rehearsal.receipt WHERE encf=$1',
          [ack.encf],
        )
      ).rows[0].n,
      1,
    );
    await engine.request(ack.documentId, true);
    await engine.cycle();
    assert.deepEqual(await engine.request(ack.documentId, false), result);
    console.log(
      `PASS E${type}: persisted source -> XMLDSig -> durable queue -> simulator -> verified RI; restart and replay stable`,
    );
  }
  assert.equal(
    (await admin.query('SELECT count(*)::int AS n FROM corestack_fiscal.sequence_reservation'))
      .rows[0].n,
    2,
  );
  console.log(
    'PASS preview-only guards, runtime least privilege, no replacement e-NCF, no DGII network',
  );
} finally {
  await runtime.end();
  await admin.end();
}

// Disposable PostgreSQL, real synthetic XMLDSig, in-process DGII simulator.
// No DGII transport or production credentials are constructed here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { syntheticSigner } from './synthetic-signer.ts';
import { registerFiscalRequest } from '../src/request-repository.ts';
import { runPreparationOnce } from '../src/preparation-worker.ts';
import { readFiscalPreparation } from '../src/preparation-repository.ts';
import { enqueueVerifiedDelivery } from '../src/delivery-enqueue.ts';
import { prepareVerifiedDelivery } from '../src/delivery-preparation.ts';
import { createDgiiClient, type DgiiTransport } from '../src/dgii-client.ts';
import { createDeliveryGateway } from '../src/delivery-gateway.ts';
import { runDeliveryOnce } from '../src/delivery-worker.ts';
import { prepareSeed } from '../src/auxiliary.ts';
import { mapFiscalRequest } from '../src/mapper.ts';
import { element } from '../src/xml.ts';

assert.equal(process.env.SYNTHETIC_DELIVERY, 'OFFLINE_ONLY');
const scope = {
  tenantId: 'offline-delivery',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const admin = new Client({ host: '127.0.0.1', user: 'postgres', database: 'postgres' });
const runtime = new Client({ host: '127.0.0.1', user: 'delivery_test', database: 'postgres' });
const signer = await syntheticSigner(scope);
try {
  await admin.connect();
  for (const file of [
    '001_sequence_registry',
    '002_request_persistence',
    '003_preparation_worker',
    '004_delivery_queue',
  ])
    await admin.query(await readFile(new URL(`../sql/${file}.sql`, import.meta.url), 'utf8'));
  await admin.query(`CREATE ROLE delivery_test LOGIN;
    GRANT USAGE ON SCHEMA corestack_fiscal TO delivery_test;
    GRANT EXECUTE ON FUNCTION corestack_fiscal.register_request(text,text),
      corestack_fiscal.claim_preparation(),corestack_fiscal.complete_preparation(bigint,uuid,text,text,text,text),
      corestack_fiscal.fail_preparation(bigint,uuid,text),corestack_fiscal.read_preparation(bigint),
      corestack_fiscal.enqueue_delivery(bigint,text,text,text,text,text,text),
      corestack_fiscal.claim_delivery(),corestack_fiscal.complete_delivery(bigint,uuid,text,text,jsonb)
      TO delivery_test;
    INSERT INTO corestack_fiscal.runtime_scope VALUES ('delivery_test','offline-delivery','101010632','precertification');
    SELECT corestack_fiscal.register_range('offline-delivery','101010632','precertification',31::smallint,1,100,'2026-01-01','2027-12-31','SYNTHETIC-OFFLINE');
    SELECT corestack_fiscal.register_range('offline-delivery','101010632','precertification',32::smallint,1,100,'2026-01-01','2027-12-31','SYNTHETIC-OFFLINE');
    INSERT INTO corestack_fiscal.delivery_control VALUES ('offline-delivery','101010632','precertification',false,clock_timestamp());`);
  await runtime.connect();
  const db = { query: (sql: string, values: readonly string[]) => runtime.query(sql, [...values]) };
  const now = Date.now();
  const seed = await prepareSeed(
    scope,
    'offline-challenge',
    new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  );
  const received = new Map<string, { trackId: string; code: number; securityCode?: string }>();
  let mode: 'ACCEPT' | 'REJECT' | 'LOSE_ACK' = 'ACCEPT';
  let posts = 0,
    authenticated = false;
  const json = (value: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(value)),
  });
  const transport: DgiiTransport = async (input) => {
    if (input.operation === 'seed')
      return { status: 200, contentType: 'application/xml', body: Buffer.from(seed.xml) };
    if (
      input.operation === 'authenticate' ||
      input.operation === 'ecf' ||
      input.operation === 'rfce'
    ) {
      assert.equal(input.method, 'POST');
      const boundary = input.headers['content-type']!.split('boundary=')[1]!;
      const body = input.body!.toString('utf8');
      const xml = body.slice(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf(`\r\n--${boundary}--`));
      if (input.operation === 'authenticate') {
        await signer.verify(scope, 'SEMILLA', xml);
        authenticated = true;
        return json({
          token: 'offline-test-token',
          expedido: new Date(now).toISOString(),
          expira: new Date(now + 3600000).toISOString(),
        });
      }
      assert.ok(authenticated);
      assert.equal(input.headers.authorization, 'Bearer offline-test-token');
      const evidence = await signer.verify(scope, input.operation === 'rfce' ? 'RFCE' : 'ECF', xml);
      assert.ok(!received.has(evidence.encf!), 'No duplicate POST allowed');
      const trackId = `offline-${++posts}`;
      received.set(evidence.encf!, {
        trackId,
        code: mode === 'REJECT' ? 2 : 1,
        securityCode: evidence.securityCode,
      });
      if (mode === 'LOSE_ACK') throw Error('SIMULATED_LOST_ACK_AFTER_ACCEPTANCE');
      if (input.operation === 'rfce')
        return json({ encf: evidence.encf, codigo: 1, secuenciaUtilizada: true });
      return json({ trackId });
    }
    assert.ok(authenticated);
    assert.equal(input.headers.authorization, 'Bearer offline-test-token');
    if (input.operation === 'trackIds') {
      const entry = received.get(input.query!.encf!);
      return json(entry ? [{ trackId: entry.trackId }] : []);
    }
    if (input.operation === 'rfceResult') {
      const encf = input.query!.ENCF!;
      const entry = received.get(encf);
      assert.ok(entry);
      assert.equal(input.query!.Cod_Seguridad_eCF, entry.securityCode);
      return json({
        rnc: scope.issuerRnc,
        encf,
        codigo: String(entry.code),
        secuenciaUtilizada: true,
      });
    }
    assert.equal(input.operation, 'result');
    const entry = [...received.entries()].find(
      ([, value]) => value.trackId === input.query!.trackid,
    );
    assert.ok(entry);
    return json({
      rnc: scope.issuerRnc,
      encf: entry[0],
      trackId: entry[1].trackId,
      codigo: entry[1].code,
      secuenciaUtilizada: true,
    });
  };
  const client = createDgiiClient(scope, transport, signer.verify, () => now);
  assert.equal(await client.seed(), seed.xml);
  await client.authenticate(await signer.sign('SEMILLA', seed.xml));
  const gateway = createDeliveryGateway(scope, client, signer.verify);
  for (const scenario of ['ACCEPT', 'REJECT', 'LOSE_ACK', 'CRASH_AFTER_POST'] as const) {
    mode = scenario === 'CRASH_AFTER_POST' ? 'ACCEPT' : scenario;
    const input = JSON.parse(
      await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
    );
    input.operationId = `offline-${scenario}`;
    input.source.documentId = `offline-${scenario}`;
    const registered = await registerFiscalRequest(db, scope, input);
    await runPreparationOnce(db, scope);
    const prepared = await readFiscalPreparation(db, registered.documentId);
    assert.equal(prepared!.state, 'DONE');
    const signed = await signer.sign('ECF', prepared!.xml!);
    await assert.rejects(signer.verify(scope, 'ECF', signed.replace('224.20', '224.21')));
    await assert.rejects(
      enqueueVerifiedDelivery(
        db,
        scope,
        registered.documentId,
        signed.replace('224.20', '224.21'),
        signed.replace('224.20', '224.21'),
        signer.bundle,
      ),
    );
    assert.equal(
      (
        await prepareVerifiedDelivery(
          db,
          scope,
          registered.documentId,
          {
            signEcf: async (requested, xml) => {
              assert.deepEqual(requested, scope);
              assert.equal(xml, prepared!.xml);
              return signed;
            },
            signConsumptionSummary: async () => {
              throw Error('UNEXPECTED_SUMMARY');
            },
          },
          signer.bundle,
        )
      ).created,
      true,
    );
    assert.equal(
      (
        await enqueueVerifiedDelivery(
          db,
          scope,
          registered.documentId,
          signed,
          signed,
          signer.bundle,
        )
      ).created,
      false,
    );
    if (scenario === 'CRASH_AFTER_POST') {
      await assert.rejects(
        runDeliveryOnce(
          {
            query: async (sql, values) => {
              if (sql.includes('complete_delivery')) throw Error('SIMULATED_PROCESS_CRASH');
              return db.query(sql, values);
            },
          },
          scope,
          gateway,
        ),
        /SIMULATED_PROCESS_CRASH/,
      );
      await admin.query(
        "UPDATE corestack_fiscal.delivery_job SET lease_until='2000-01-01' WHERE document_id=$1",
        [registered.documentId],
      );
    } else {
      assert.equal(
        (await runDeliveryOnce(db, scope, gateway)).result,
        scenario === 'LOSE_ACK' ? 'UNCONFIRMED' : 'PROCESSING',
      );
    }
    // Test clock acceleration ONLY by administrator of this disposable DB.
    await admin.query(
      "UPDATE corestack_fiscal.delivery_job SET available_at='2000-01-01' WHERE document_id=$1",
      [registered.documentId],
    );
    assert.equal(
      (await runDeliveryOnce(db, scope, gateway)).result,
      scenario === 'REJECT' ? 'REJECTED' : 'ACCEPTED',
    );
    assert.equal((await runDeliveryOnce(db, scope, gateway)).result, 'IDLE');
    await assert.rejects(runtime.query("UPDATE corestack_fiscal.delivery_job SET state='READY'"), {
      code: '42501',
    });
  }
  assert.equal(posts, 4);
  for (const summaryMode of ['ACCEPT', 'LOSE_ACK'] as const) {
    mode = summaryMode;
    const input32 = JSON.parse(
      await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8'),
    );
    input32.type = 32;
    input32.operationId = `offline-rfce-${mode}`;
    input32.source.documentId = `offline-rfce-${mode}`;
    const registered32 = await registerFiscalRequest(db, scope, input32);
    await runPreparationOnce(db, scope);
    const prepared32 = await readFiscalPreparation(db, registered32.documentId);
    assert.equal(prepared32!.state, 'DONE');
    const stamp = prepared32!.xml!.match(
      /<FechaHoraFirma>(\d{2})-(\d{2})-(\d{4}) ([^<]+)<\/FechaHoraFirma>/,
    )!;
    const mapped = mapFiscalRequest(
      scope,
      input32,
      {
        scope,
        operationId: input32.operationId,
        payloadSha256: registered32.payloadSha256,
        encf: registered32.encf,
        businessDate: input32.issuedOn,
        validUntil: '2027-12-31',
      },
      `${stamp[3]}-${stamp[2]}-${stamp[1]}T${stamp[4]}-04:00`,
    );
    const root = element('ECF', mapped.sections);
    const summaryResult = await prepareVerifiedDelivery(
      db,
      scope,
      registered32.documentId,
      {
        signEcf: (_s, xml) => signer.sign('ECF', xml),
        signConsumptionSummary: (_s, _xml, signed) => signer.summary(root, signed),
      },
      signer.bundle,
    );
    assert.equal(summaryResult.route, 'RFCE');
    assert.equal(
      (await runDeliveryOnce(db, scope, gateway)).result,
      mode === 'LOSE_ACK' ? 'UNCONFIRMED' : 'ACCEPTED',
    );
    if (mode === 'LOSE_ACK') {
      await admin.query(
        "UPDATE corestack_fiscal.delivery_job SET available_at='2000-01-01' WHERE document_id=$1",
        [registered32.documentId],
      );
      assert.equal((await runDeliveryOnce(db, scope, gateway)).result, 'ACCEPTED');
    }
  }
  assert.equal(posts, 6);
  const states = await admin.query(
    'SELECT state,count(*)::int AS count FROM corestack_fiscal.delivery_job GROUP BY state ORDER BY state',
  );
  assert.deepEqual(states.rows, [
    { state: 'ACCEPTED', count: 5 },
    { state: 'REJECTED', count: 1 },
  ]);
  const artifacts = await admin.query(
    'SELECT count(*)::int AS count FROM corestack_fiscal.outbound_artifact',
  );
  assert.equal(artifacts.rows[0].count, 6);
  console.log(
    'PASS: real XMLDSig + seed authentication + PostgreSQL queue + E31 acceptance/rejection/lost ACK/process crash + signed E32/RFCE acceptance/lost ACK; 6 POSTs, no duplicate delivery.',
  );
} finally {
  await runtime.end();
  await admin.end();
  await signer.close();
}

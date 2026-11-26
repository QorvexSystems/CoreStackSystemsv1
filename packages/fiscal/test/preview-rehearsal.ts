// TEST ONLY: persistent, in-process simulator. No DGII network transport exists.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { syntheticSigner } from './synthetic-signer.ts';
import { prepareSeed } from '../src/auxiliary.ts';
import { createDgiiClient, type DgiiTransport } from '../src/dgii-client.ts';
import { createDeliveryGateway } from '../src/delivery-gateway.ts';
import { prepareVerifiedDelivery } from '../src/delivery-preparation.ts';
import { runDeliveryOnce } from '../src/delivery-worker.ts';
import { mapFiscalRequest } from '../src/mapper.ts';
import { element, serializeXml } from '../src/xml.ts';
import { preparePrintedRepresentation } from '../src/printed-representation.ts';
import type { FiscalScope } from '../src/catalog.ts';
import type { FiscalRegistrationConnection } from '../src/request-repository.ts';

export async function createPreviewRehearsal(db: FiscalRegistrationConnection, scope: FiscalScope) {
  const signer = await syntheticSigner(scope, true);
  const query = async <T = unknown>(sql: string, values: readonly string[] = []): Promise<T> =>
    (await db.query(sql, values)).rows[0]?.value as T;
  const receipt = (encf: string, payload: unknown = null) =>
    query<{ trackId: string; code: number; securityCode: string | null } | null>(
      "SELECT preview_rehearsal.receipt($1,NULLIF($2,'')::jsonb) AS value",
      [encf, payload === null ? '' : JSON.stringify(payload)],
    );
  const json = (value: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(value)),
  });
  let seedXml = '',
    token = '',
    expires = 0;
  const transport: DgiiTransport = async (input) => {
    if (input.operation === 'seed')
      return { status: 200, contentType: 'application/xml', body: Buffer.from(seedXml) };
    if (['authenticate', 'ecf', 'rfce'].includes(input.operation)) {
      assert.equal(input.method, 'POST');
      const boundary = input.headers['content-type']!.split('boundary=')[1]!;
      const body = input.body!.toString('utf8');
      const xml = body.slice(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf(`\r\n--${boundary}--`));
      if (input.operation === 'authenticate') {
        await signer.verify(scope, 'SEMILLA', xml);
        expires = Date.now() + 3600000;
        token = 'synthetic-preview-only';
        return json({
          token,
          expedido: new Date().toISOString(),
          expira: new Date(expires).toISOString(),
        });
      }
      assert.equal(input.headers.authorization, `Bearer ${token}`);
      assert.ok(token && Date.now() < expires);
      const evidence = await signer.verify(scope, input.operation === 'rfce' ? 'RFCE' : 'ECF', xml);
      const trackId = `synthetic-${evidence.encf}`;
      await receipt(evidence.encf!, {
        trackId,
        code: 1,
        sha256: evidence.sha256,
        securityCode: evidence.securityCode ?? null,
      });
      return json(
        input.operation === 'rfce'
          ? { encf: evidence.encf, codigo: 1, secuenciaUtilizada: true }
          : { trackId },
      );
    }
    assert.ok(token && Date.now() < expires);
    assert.equal(input.headers.authorization, `Bearer ${token}`);
    const encf =
      input.operation === 'rfceResult'
        ? input.query!.ENCF!
        : input.operation === 'trackIds'
          ? input.query!.encf!
          : input.query!.trackid!.replace(/^synthetic-/, '');
    const saved = await receipt(encf);
    if (input.operation === 'trackIds') return json(saved ? [{ trackId: saved.trackId }] : []);
    assert.ok(saved);
    if (input.operation === 'rfceResult')
      assert.equal(input.query!.Cod_Seguridad_eCF, saved.securityCode);
    return json({
      rnc: scope.issuerRnc,
      encf,
      trackId: saved.trackId,
      codigo: saved.code,
      secuenciaUtilizada: true,
    });
  };
  const client = createDgiiClient(scope, transport, signer.verify);
  const gateway = createDeliveryGateway(scope, client, signer.verify);
  return {
    async cycle() {
      if (Date.now() > expires - 60000) {
        seedXml = (
          await prepareSeed(
            scope,
            'synthetic-preview-challenge',
            new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          )
        ).xml;
        await client.seed();
        await client.authenticate(await signer.sign('SEMILLA', seedXml));
      }
      const job = await query<null | {
        status: { errorCode: string | null; state: string };
        source: {
          documentId: string;
          encf: string;
          snapshotText: string;
          payloadSha256: string;
          validUntil: string | null;
          plannedSignatureAt: string;
          xml: string;
          xmlSha256: string;
          signedXml: string | null;
        };
      }>('SELECT preview_rehearsal.next_job() AS value');
      if (job && !job.status.errorCode) {
        const source = job.source;
        const saved = JSON.parse(source.snapshotText);
        assert.deepEqual(saved.scope, scope);
        const mapped = mapFiscalRequest(
          scope,
          saved.request,
          {
            scope,
            operationId: saved.request.operationId,
            payloadSha256: source.payloadSha256,
            encf: source.encf,
            businessDate: saved.request.issuedOn,
            validUntil: source.validUntil,
          },
          source.plannedSignatureAt,
        );
        const root = element('ECF', mapped.sections);
        assert.equal(serializeXml(root), source.xml);
        assert.equal(createHash('sha256').update(source.xml).digest('hex'), source.xmlSha256);
        if (!source.signedXml)
          await prepareVerifiedDelivery(
            db,
            scope,
            source.documentId,
            {
              signEcf: async (requested, xml) => {
                assert.deepEqual(requested, scope);
                return signer.sign('ECF', xml);
              },
              signConsumptionSummary: async (requested, xml, signed) => {
                assert.deepEqual(requested, scope);
                assert.equal(xml, source.xml);
                return signer.summary(root, signed);
              },
            },
            signer.bundle,
          );
        if (job.status.state === 'ACCEPTED') {
          assert.ok(source.signedXml);
          const model = await preparePrintedRepresentation(
            scope,
            root,
            source.signedXml,
            signer.printVerify,
          );
          await query('SELECT preview_rehearsal.finish($1,$2::jsonb) AS value', [
            source.documentId,
            JSON.stringify(model),
          ]);
        }
      }
      await runDeliveryOnce(db, scope, gateway);
    },
    async request(documentId: string, start: boolean) {
      assert.match(documentId, /^[1-9][0-9]{0,18}$/);
      return query(
        `SELECT preview_rehearsal.${start ? 'request' : 'status'}($1::bigint) AS value`,
        [documentId],
      );
    },
  };
}

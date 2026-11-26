import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareAceCf } from '../src/auxiliary.ts';
import { createFiscalReceiverHandler } from '../src/fiscal-receiver.ts';
import { serializeXml, element as e } from '../src/xml.ts';
import type { VerifiedIncomingXml } from '../src/receiver-xml-verifier.ts';

const scope = { tenantId: 'rivnu-certification', issuerRnc: '40220429126', environment: 'certification' as const };
const actor = '101010632';
const representedIssuer = '131888882';
const representedBuyer = '132999991';
const fixedNow = new Date('2026-10-20T22:00:00.000Z');

function multipart(xml: string, boundary = 'corestack-test-boundary') {
  return {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="xml"; filename="document.xml"\r\nContent-Type: text/xml\r\n\r\n${xml}\r\n--${boundary}--\r\n`,
  };
}

function ecfXml() {
  return serializeXml(e('ECF', [
    e('Encabezado', [
      e('Version', '1.0'),
      e('IdDoc', [e('TipoeCF', '31'), e('eNCF', 'E310000000001'), e('FechaVencimientoSecuencia', '31-12-2027'), e('TipoIngresos', '01'), e('TipoPago', '1')]),
      e('Emisor', [e('RNCEmisor', representedIssuer), e('RazonSocialEmisor', 'EMISOR SINTETICO'), e('DireccionEmisor', 'Direccion de prueba'), e('FechaEmision', '20-10-2026')]),
      e('Comprador', [e('RNCComprador', scope.issuerRnc), e('RazonSocialComprador', 'FERRETERIA RIVNU')]),
      e('Totales', [e('MontoTotal', '100.00')]),
    ]),
    e('DetallesItems', [e('Item', [e('NumeroLinea', '1'), e('IndicadorFacturacion', '4'), e('NombreItem', 'Producto'), e('IndicadorBienoServicio', '1'), e('CantidadItem', '1.00'), e('PrecioUnitarioItem', '100.0000'), e('MontoItem', '100.00')])]),
    e('FechaHoraFirma', '20-10-2026 18:00:00'),
  ]));
}

test('receiver authenticates once, requires bearer, returns signed ARECF and stores idempotently', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'receiver-test-'));
  let seedXml = '';
  const unsignedEcf = ecfXml();
  const approval = await prepareAceCf(
    { ...scope, issuerRnc: representedBuyer },
    { issuerRnc: scope.issuerRnc, buyerRnc: representedBuyer, encf: 'E310000000001', issuedOn: '2026-10-20', total: '100.00', state: 1, at: '2026-10-20T18:00:00-04:00' },
  );
  const verified = (unsignedXml: string): VerifiedIncomingXml => ({
    actorRnc: actor, certificateSha256: 'a'.repeat(64), signedSha256: 'b'.repeat(64), unsignedXml,
  });
  const handler = createFiscalReceiverHandler({ scope, evidenceRoot }, {
    now: () => fixedNow,
    signer: { sign: async (xml) => `SIGNED:${xml}` },
    verifyIncoming: async (xml) => {
      if (xml === 'signed-seed') return verified(seedXml);
      if (xml === 'signed-ecf') return verified(unsignedEcf);
      if (xml === 'signed-approval') return verified(approval.xml);
      throw Error('unexpected');
    },
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const seedResponse = await fetch(`${origin}/fe/autenticacion/api/semilla`);
    assert.equal(seedResponse.status, 200);
    seedXml = await seedResponse.text();
    assert.match(seedXml, /<SemillaModel>/);

    const seedRequest = multipart('signed-seed');
    const auth = await fetch(`${origin}/fe/autenticacion/api/ValidacionCertificado`, { method: 'POST', headers: seedRequest.headers, body: seedRequest.body });
    assert.equal(auth.status, 200);
    const token = (await auth.json() as any).token;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const replay = await fetch(`${origin}/fe/autenticacion/api/validacioncertificado`, { method: 'POST', headers: seedRequest.headers, body: seedRequest.body });
    assert.equal(replay.status, 400);

    const ecfRequest = multipart('signed-ecf');
    assert.equal((await fetch(`${origin}/fe/recepcion/api/ecf`, { method: 'POST', headers: ecfRequest.headers, body: ecfRequest.body })).status, 401);
    const accepted = await fetch(`${origin}/fe/recepcion/api/ecf`, { method: 'POST', headers: { ...ecfRequest.headers, Authorization: `Bearer ${token}` }, body: ecfRequest.body });
    assert.equal(accepted.status, 200);
    const receipt = await accepted.text();
    assert.match(receipt, /^SIGNED:<\?xml/);
    assert.match(receipt, /<RNCEmisor>131888882<\/RNCEmisor>/);
    assert.match(receipt, /<RNCComprador>40220429126<\/RNCComprador>/);
    const duplicate = await fetch(`${origin}/fe/recepcion/api/ecf`, { method: 'POST', headers: { ...ecfRequest.headers, Authorization: `Bearer ${token}` }, body: ecfRequest.body });
    assert.equal(await duplicate.text(), receipt);

    const approvalRequest = multipart('signed-approval');
    const approvalResponse = await fetch(`${origin}/fe/aprobacioncomercial/api/ecf`, { method: 'POST', headers: { ...approvalRequest.headers, Authorization: `Bearer ${token}` }, body: approvalRequest.body });
    assert.equal(approvalResponse.status, 200);
    assert.equal(await approvalResponse.text(), 'OK');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('receiver fails closed for production and does not expose arbitrary routes', async () => {
  assert.throws(() => createFiscalReceiverHandler({ scope: { ...scope, environment: 'production' }, evidenceRoot: '/tmp/nope' }, {
    signer: { sign: async (xml) => xml },
    verifyIncoming: async () => { throw Error('unused'); },
  }), /PRODUCTION_DISABLED/);
});


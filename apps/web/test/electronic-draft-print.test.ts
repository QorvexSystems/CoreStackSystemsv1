import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { readElectronicDraft, renderElectronicDraft } from '../lib/electronic-draft-print';
import { renderSyntheticFiscalQr } from '../lib/synthetic-fiscal-qr';
import { analyzeQrVersion8 } from '../lib/qr-version8';
import { printSyntheticRehearsal } from '../lib/synthetic-rehearsal-print';
import {
  assertDgiiQrCapacity,
  DgiiQrCapacityError,
  fiscalPrintFailure,
  runFiscalPrint,
} from '../lib/dgii-qr-capacity';
const require = createRequire(import.meta.url);
// Explicit test-only DOM implementation installed in the isolated test harness.
globalThis.DOMParser = require('/harness/node_modules/@xmldom/xmldom').DOMParser;
const hash = (xml: string) => createHash('sha256').update(xml).digest('hex');
const context = { documentType: 31 as const, environment: 'precertification' as const };
test('live remote rehearsal prints verified RI and independently decodable QR, using v9 when required',
  {skip:!process.env.PRINT_LIVE_REHEARSAL},()=>{
    const model=JSON.parse(readFileSync('/live/rehearsal-model.json','utf8'));
    const expected={encf:model.encf,sha256:model.sourceSha256};
    process.env.NEXT_PUBLIC_SYNTHETIC_ECF='true';
    let opened=0,printed=0,html='';
    const previous=globalThis.window;
    globalThis.window={open:()=>{opened++;return {opener:null,document:{open(){},write(value:string){html=value;},close(){}},focus(){},print(){printed++;}};}} as unknown as Window & typeof globalThis;
    try {
      printSyntheticRehearsal(model,expected);
      assert.equal(opened,1);assert.equal(printed,1);
      assert.ok(html.includes(model.signedSha256));assert.ok(html.includes('SIN VALIDEZ FISCAL'));
      const svg=Buffer.from(html.match(/data:image\/svg\+xml;base64,([^"\s]+)/)![1],'base64').toString('utf8');
      assert.equal(decodeQr(svg),model.qrUrl);
      writeFileSync('/live/rehearsal-ri.html',html,{mode:0o600});
      assert.throws(()=>printSyntheticRehearsal(model,{...expected,sha256:'0'.repeat(64)}));
      assert.throws(()=>printSyntheticRehearsal({...model,scope:{...model.scope,environment:'production'}},expected));
      const long={...model,encf:'E310000000001',qrVersion:9,qrUrl:'https://ecf.dgii.gov.do/testecf/consultatimbre?RncEmisor=101010632&RncComprador=101010641&ENCF=E310000000001&FechaEmision=22-09-2026&MontoTotal=118.00&FechaFirma=22-09-2026%2012%3A34%3A56&CodigoSeguridad=aB%2B%2F12'};
      printSyntheticRehearsal(long,{...expected,encf:long.encf});
      assert.equal(opened,2);assert.equal(printed,2);
    } finally {globalThis.window=previous;delete process.env.NEXT_PUBLIC_SYNTHETIC_ECF;}
  });
for (const [bits, prefix, digits] of [
  [1551, 0, 461],
  [1552, 2, 453],
  [1553, 5, 446],
]) {
  test(`real analyzer boundary ${bits} bits`, () => {
    const payload = 'x'.repeat(prefix) + '1'.repeat(digits);
    assert.equal(analyzeQrVersion8(payload).minimumBits, bits);
    const events: unknown[] = [];
    if (bits <= 1856) {
      const plan = assertDgiiQrCapacity(payload, context, (event) => events.push(event));
      assert.equal(plan.segments.join(''), payload);
      const React = require('react');
      const { QRCodeSVG } = require('qrcode.react');
      const { renderToStaticMarkup } = require('react-dom/server');
      const svg = renderToStaticMarkup(
        React.createElement(QRCodeSVG, {
          value: plan.segments,
          minVersion: plan.version,
          level: 'L',
          boostLevel: false,
          marginSize: 4,
          size: 228,
        }),
      );
      assert.ok(svg.includes(`viewBox="0 0 ${plan.version === 8 ? 57 : 61} ${plan.version === 8 ? 57 : 61}"`));
      assert.equal(decodeQr(svg), payload);
      assert.equal(events.length, plan.version === 9 ? 1 : 0);
    } else {
      assert.throws(
        () => assertDgiiQrCapacity(payload, context, (event) => events.push(event)),
        DgiiQrCapacityError,
      );
      assert.equal(events.length, 1);
    }
  });
}
test('canonical long E31 selects QR v9 without changing fiscal data, with redacted telemetry', async () => {
  const { buildTimbrePayload } = require('/app/packages/fiscal/src/timbre.ts');
  const input = {
    issuerRnc: '101010632',
    buyerRnc: '101010641',
    encf: 'E310000000001',
    issuedOn: '2026-09-22',
    signedAt: '2026-09-22T12:34:56-04:00',
    total: '118.00',
    securityCode: 'aB+/12',
  };
  const before = JSON.stringify(input);
  const url = buildTimbrePayload(
    { tenantId: 'synthetic', issuerRnc: input.issuerRnc, environment: 'precertification' },
    input,
  ).url;
  const events: Record<string, unknown>[] = [];
  let presented = 0;
  const outcome = await runFiscalPrint(
    async () => renderSyntheticFiscalQr(url, (event) => events.push({ ...event })),
    () => {
      presented++;
    },
  );
  assert.equal(outcome.status, 'PRINT_READY');
  assert.equal(presented, 1);
  assert.equal(JSON.stringify(input), before);
  assert.equal(events.length, 1);
  assert.deepEqual(
    Object.keys(events[0]).sort(),
    ['event', 'documentType', 'environment', 'requiredBits', 'capacityBits', 'selectedVersion', 'timestamp'].sort(),
  );
  assert.equal(events[0].requiredBits, 1616);
  assert.equal(events[0].documentType, 31);
  assert.equal(events[0].capacityBits, 1856);
  assert.equal(events[0].selectedVersion, 9);
  assert.ok(Number.isFinite(Date.parse(events[0].timestamp as string)));
  for (const secret of [
    input.issuerRnc,
    input.encf,
    input.securityCode,
    url,
    'SignatureValue',
    '<ECF>',
  ])
    assert.ok(!JSON.stringify({ events, outcome }).includes(secret));
  assert.ok(!('stack' in outcome));
});
test('maximum valid E31 uses v9; telemetry failure cannot block a valid QR', () => {
  const { buildTimbrePayload } = require('/app/packages/fiscal/src/timbre.ts');
  for (const environment of ['precertification', 'certification']) {
    const url = buildTimbrePayload(
      { tenantId: 'synthetic', issuerRnc: '40220429126', environment },
      {
        issuerRnc: '40220429126',
        buyerRnc: '40220429126',
        encf: 'E319999999999',
        issuedOn: '2026-12-31',
        signedAt: '2026-12-31T23:59:59-04:00',
        total: '9999999999999999.99',
        securityCode: '/+/+/+',
      },
    ).url;
    assert.equal(analyzeQrVersion8(url).minimumBits, 1727);
    const svg = renderSyntheticFiscalQr(url, () => { throw Error('telemetry unavailable'); });
    assert.ok(svg.includes('viewBox="0 0 61 61"'));
    assert.equal(decodeQr(svg), url);
  }
});
test('public print failure has no production diagnostics; successful print is presented once', async () => {
  const env = process.env as Record<string, string | undefined>;
  const old = env.NODE_ENV;
  try {
    env.NODE_ENV = 'production';
    const error = new DgiiQrCapacityError(context, 1857);
    assert.ok(!('detail' in fiscalPrintFailure(error)));
    assert.ok(!JSON.stringify(fiscalPrintFailure(Error('private XML'))).includes('private XML'));
    env.NODE_ENV = 'development';
    const developmentFailure = fiscalPrintFailure(error);
    assert.equal(developmentFailure.status, 'QR_CAPACITY_BLOCKED');
    assert.ok('detail' in developmentFailure);
    assert.equal(developmentFailure.detail, 'Required bits: 1857. Capacity: 1856.');
  } finally {
    if (old === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = old;
  }
  let presented = 0;
  const outcome = await runFiscalPrint(
    async () => '<html>verified test</html>',
    (html) => {
      assert.ok(html.includes('verified test'));
      presented++;
    },
  );
  assert.equal(outcome.status, 'PRINT_READY');
  assert.equal(presented, 1);
});
test('payload beyond v9-L is rejected without fallback or mutation', () => {
  const payload = 'x'.repeat(231);
  const events: Record<string, unknown>[] = [];
  assert.throws(
    () => assertDgiiQrCapacity(payload, context, (event) => events.push({...event})),
    (error: unknown) =>
      error instanceof DgiiQrCapacityError &&
      error.actualBits === 1860 &&
      error.qrVersion === 9 &&
      error.capacityBits === 1856 &&
      error.code === 'DGII_QR_V9_CAPACITY_EXCEEDED',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, 'DGII_QR_V9_CAPACITY_EXCEEDED');
});
test('QR reader rejects missing, duplicate, empty and extra query parameters', () => {
  const url =
    'https://ecf.dgii.gov.do/testecf/consultatimbre?RncEmisor=101010632&RncComprador=101010641&ENCF=E310000000001&FechaEmision=22-09-2026&MontoTotal=118.00&FechaFirma=22-09-2026%2012%3A34%3A56&CodigoSeguridad=aB%2B%2F12';
  for (const bad of [
    url.replace('&RncComprador=101010641', ''),
    url + '&rncemisor=101010632',
    url + '&extra=1',
    url.replace('RncComprador=101010641', 'RncComprador='),
    url.replace('aB%2B%2F12', 'aB+/12'),
  ])
    assert.throws(() => renderSyntheticFiscalQr(bad), /INVALID_TIMBRE_QUERY/);
});
test(
  'cryptographically verified synthetic RI model renders with a real QR image',
  {
    skip: !process.env.PRINT_SIGNED_RI_FIXTURE,
  },
  () => {
    const model = JSON.parse(readFileSync('/artifacts/synthetic-ri-model.json', 'utf8'));
    const {
      renderPrintedRepresentation,
    } = require('/app/packages/fiscal/src/printed-representation.ts');
    const svg = renderSyntheticFiscalQr(model.qrUrl);
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
    assert.equal(decodeQr(svg), model.qrUrl);
    const html = renderPrintedRepresentation(model, svg);
    assert.ok(html.includes('data:image/svg+xml;base64,'));
    assert.ok(html.includes(model.securityCode));
    assert.ok(html.includes(model.signedSha256));
    assert.ok(html.includes('SIN VALIDEZ FISCAL'));
    writeFileSync('/artifacts/synthetic-ri.html', html, { mode: 0o600 });
  },
);
test('E31 canonical long URL exceeds v8 and is encoded unchanged in v9', () => {
  const url =
    'https://ecf.dgii.gov.do/testecf/consultatimbre?rncemisor=101010632&rnccomprador=101010641&encf=E310000000001&fechaemision=22-09-2026&montototal=118.00&fechafirma=22-09-2026%2012%3A34%3A56&codigoseguridad=aB%2B%2F12';
  const result = analyzeQrVersion8(url);
  assert.equal(result.segments.join(''), url);
  assert.equal(result.minimumBits, 1616);
  assert.equal(result.capacityBits, 1552);
  assert.equal(result.fits, false);
  const events: Record<string, unknown>[] = [];
  const svg = renderSyntheticFiscalQr(url, (event) => events.push({...event}));
  assert.ok(svg.includes('viewBox="0 0 61 61"'));
  assert.equal(decodeQr(svg), url);
  assert.equal(events[0]?.event, 'DGII_QR_VERSION_9_SELECTED');
  const numeric = analyzeQrVersion8('1'.repeat(460));
  assert.ok(numeric.fits);
  assert.equal(numeric.segments.join(''), '1'.repeat(460));
});
test(
  'persisted preview XML projects into an escaped printable draft',
  {
    skip: !process.env.PRINT_PERSISTED_FIXTURE,
  },
  async () => {
    const saved = JSON.parse(readFileSync('/harness/prepared.json', 'utf8'));
    const model = await readElectronicDraft(saved.xml, saved.encf, saved.sha256);
    const html = renderElectronicDraft(model);
    assert.ok(model.lines.length > 0);
    assert.ok(html.includes(saved.encf));
    assert.ok(html.includes('SIN VALIDEZ FISCAL'));
  },
);
const encf = 'E320000000001';
const xml = `<?xml version="1.0" encoding="utf-8"?><ECF><Encabezado><IdDoc><TipoeCF>32</TipoeCF><eNCF>${encf}</eNCF></IdDoc><Emisor><RNCEmisor>101010632</RNCEmisor><RazonSocialEmisor>PRUEBA &amp; CIA</RazonSocialEmisor><DireccionEmisor>Dirección</DireccionEmisor><FechaEmision>24-09-2026</FechaEmision></Emisor><Totales><MontoGravadoTotal>100.00</MontoGravadoTotal><TotalITBIS>18.00</TotalITBIS><MontoTotal>118.00</MontoTotal></Totales></Encabezado><DetallesItems><Item><NumeroLinea>1</NumeroLinea><NombreItem>&lt;script&gt;alert(1)&lt;/script&gt;</NombreItem><CantidadItem>1.00</CantidadItem><PrecioUnitarioItem>100.00</PrecioUnitarioItem><MontoItem>100.00</MontoItem></Item></DetallesItems><FechaHoraFirma>24-09-2026 10:00:00</FechaHoraFirma></ECF>`;
test('print uses hashed XML, exact decimals and escaped content; never invents a QR/signature', async () => {
  const model = await readElectronicDraft(xml, encf, hash(xml));
  const html = renderElectronicDraft(model);
  assert.equal(model.issuer, 'PRUEBA & CIA');
  assert.ok(html.includes('SIN FIRMA — SIN VALIDEZ FISCAL'));
  assert.ok(html.includes('118.00'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes("default-src 'none'"));
});
test('hash/identity mismatch, DTD, signatures and duplicate fiscal fields are rejected', async () => {
  await assert.rejects(readElectronicDraft(xml, encf, '0'.repeat(64)));
  await assert.rejects(readElectronicDraft(xml, 'E320000000002', hash(xml)));
  for (const changed of [
    xml.replace('<ECF>', '<!DOCTYPE ECF [<!ENTITY leak SYSTEM "file:///etc/passwd">]><ECF>'),
    xml.replace('</ECF>', '<Signature>fake</Signature></ECF>'),
    xml.replace('</IdDoc>', `<eNCF>${encf}</eNCF></IdDoc>`),
    xml.replace(
      '<MontoTotal>118.00</MontoTotal>',
      '<ImpuestosAdicionales><Impuesto>10</Impuesto></ImpuestosAdicionales>',
    ),
  ])
    await assert.rejects(readElectronicDraft(changed, encf, hash(changed)));
});
test('RFCE QR renders at version 8 with quiet zone; production and capacity overflow blocked', () => {
  const url =
    'https://fc.dgii.gov.do/testecf/consultatimbrefc?rncemisor=101010632&encf=E320000000001&montototal=118.00&codigoseguridad=aB%2B%2F12';
  const svg = renderSyntheticFiscalQr(url);
  assert.ok(svg.includes('viewBox="0 0 57 57"'));
  assert.equal(decodeQr(svg), url);
  assert.throws(() => renderSyntheticFiscalQr(url.replace('/testecf/', '/ecf/')));
  assert.throws(() => renderSyntheticFiscalQr(url.replace('fc.dgii.gov.do', 'example.com')));
  assert.throws(
    () => renderSyntheticFiscalQr(url + '&oversized=' + 'x'.repeat(400)),
    /INVALID_TIMBRE_QUERY/,
  );
});
function decodeQr(svg: string): string {
  // Rasterize the library's module runs, then decode with an independent reader.
  const {
    QRCodeReader,
    BinaryBitmap,
    HybridBinarizer,
    RGBLuminanceSource,
  } = require('/harness/node_modules/@zxing/library');
  const modules = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)![1]);
  const size = modules * 4;
  const pixels = new Uint8ClampedArray(size * size).fill(255);
  const path = svg.match(/fill="#000000" d="([^"]+)"/)![1];
  for (const run of path.matchAll(/M(\d+)[ ,](\d+)\s*h(\d+)v1H\d+z/g)) {
    const [x, y, width] = run.slice(1).map(Number);
    for (let row = y * 4; row < (y + 1) * 4; row++)
      pixels.fill(0, row * size + x * 4, row * size + (x + width) * 4);
  }
  const decoded = new QRCodeReader().decode(
    new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, size, size))),
  );
  return decoded.getText();
}

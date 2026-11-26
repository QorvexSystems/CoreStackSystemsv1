import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimbrePayload, TIMBRE_ENDPOINTS, RFCE_TIMBRE_ENDPOINTS } from '../src/timbre.ts';
const scope = {
  tenantId: 'synthetic',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const input = {
  issuerRnc: scope.issuerRnc,
  encf: 'E310000000001',
  buyerRnc: '101010641',
  issuedOn: '2026-09-22',
  signedAt: '2026-09-22T12:34:56-04:00',
  total: '118.00',
  securityCode: 'aB+/12',
};
test('ECF timbre encodes security code and local signature date without ambiguity', () => {
  const out = buildTimbrePayload(scope, input);
  const url = new URL(out.url);
  assert.equal(out.qrVersion, 9);
  assert.equal(out.qrMinimumBits, 1616);
  assert.equal(url.hostname, 'ecf.dgii.gov.do');
  assert.equal(url.searchParams.get('CodigoSeguridad'), 'aB+/12');
  assert.ok(out.url.includes('%2B%2F'));
  assert.equal(url.searchParams.get('FechaFirma'), '22-09-2026 12:34:56');
  assert.ok(out.url.includes('%20'));
  assert.equal(url.searchParams.get('RncComprador'), input.buyerRnc);
});
test('E32 exact threshold routes QR to correct host and removes non-RFCE parameters', () => {
  for (const [total, host] of [
    ['249999.99', 'fc.dgii.gov.do'],
    ['250000.00', 'ecf.dgii.gov.do'],
  ]) {
    const out = buildTimbrePayload(scope, { ...input, encf: 'E320000000001', total });
    const url = new URL(out.url);
    assert.equal(url.hostname, host);
    assert.equal(url.searchParams.has('FechaEmision'), host === 'ecf.dgii.gov.do');
    if (host === 'fc.dgii.gov.do') assert.equal([...url.searchParams].length, 4);
  }
});
test('E31 has exactly seven documented fields, unchanged values and safe encoding', () => {
  const names = [
    'RncEmisor',
    'RncComprador',
    'ENCF',
    'FechaEmision',
    'MontoTotal',
    'FechaFirma',
    'CodigoSeguridad',
  ];
  for (const securityCode of [
    'ABC123',
    'abcdef',
    'ABCDEF',
    '++++++',
    '//////',
    '+/+/+/',
    'aB+/12',
  ]) {
    const url = new URL(buildTimbrePayload(scope, { ...input, securityCode }).url);
    assert.deepEqual([...url.searchParams.keys()], names);
    assert.deepEqual(
      [...url.searchParams.values()],
      [
        input.issuerRnc,
        input.buyerRnc,
        input.encf,
        '22-09-2026',
        '118.00',
        '22-09-2026 12:34:56',
        securityCode,
      ],
    );
    assert.ok(!url.search.includes('%25'));
    assert.ok(url.search.includes('FechaFirma=22-09-2026%2012%3A34%3A56'));
    assert.ok(!url.searchParams.get('FechaFirma')!.includes('T'));
  }
  for (const buyerRnc of [undefined, null, '', 'undefined', 'null'])
    assert.throws(() => buildTimbrePayload(scope, { ...input, buyerRnc } as typeof input));
});
test('endpoint map knows production without enabling production', () => {
  for (const [environment, path] of [
    ['precertification', 'testecf'],
    ['certification', 'certecf'],
    ['production', 'ecf'],
  ] as const) {
    assert.equal(TIMBRE_ENDPOINTS[environment], `https://ecf.dgii.gov.do/${path}/consultatimbre`);
    assert.equal(
      RFCE_TIMBRE_ENDPOINTS[environment],
      `https://fc.dgii.gov.do/${path}/consultatimbrefc`,
    );
    if (environment !== 'production')
      assert.ok(
        buildTimbrePayload({ ...scope, environment }, input).url.startsWith(
          TIMBRE_ENDPOINTS[environment] + '?',
        ),
      );
  }
  assert.throws(() => buildTimbrePayload({ ...scope, environment: 'production' }, input));
});
test('amounts remain exact fixed decimals and signature date has no timezone suffix', () => {
  for (const total of ['0.01', '1.00', '1.10', '118.00', '118.50', '9999999999999999.99'])
    assert.equal(
      new URL(buildTimbrePayload(scope, { ...input, total }).url).searchParams.get('MontoTotal'),
      total,
    );
  for (const signedAt of [
    '2026-09-22T12:34:56.000-04:00',
    '2026-09-22T12:34:56Z',
    '2026-09-22T25:34:56-04:00',
  ])
    assert.throws(() => buildTimbrePayload(scope, { ...input, signedAt }));
});
test('all ten document types and certification environment use fixed official roots', () => {
  for (const type of [31, 32, 33, 34, 41, 43, 44, 45, 46, 47]) {
    const out = buildTimbrePayload(
      { ...scope, environment: 'certification' },
      { ...input, encf: `E${type}0000000001` },
    );
    assert.ok(new URL(out.url).pathname.startsWith('/certecf/'));
  }
});
test('invalid identity, precision, timestamp, dates and security code rejected', () => {
  for (const patch of [
    { issuerRnc: '999999999' },
    { total: '1.001' },
    { signedAt: '2026-09-22T16:34:56Z' },
    { issuedOn: '2026-02-30' },
    { securityCode: 'ab&x=y' },
    { buyerRnc: 'bad' },
  ])
    assert.throws(() => buildTimbrePayload(scope, { ...input, ...patch }));
  assert.throws(() => buildTimbrePayload({ ...scope, environment: 'production' }, input));
});

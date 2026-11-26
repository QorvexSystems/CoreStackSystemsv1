import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  prepareAreCf,
  prepareAceCf,
  prepareAnEcf,
  prepareSeed,
  prepareRfce,
} from '../src/auxiliary.ts';
import { element as e, serializeXml } from '../src/xml.ts';
import { scope, fixture, replaceField } from './fixtures.ts';
import { normalizeAuxiliarySchema } from '../src/schema-compatibility.ts';
import { readFile } from 'node:fs/promises';
const receipt = {
  issuerRnc: '101010641',
  buyerRnc: scope.issuerRnc,
  encf: 'E310000000001',
  at: '2026-09-23T10:00:00-04:00',
};
test('auxiliary compatibility is pinned and cannot silently accept modified schemas', async () => {
  for (const name of ['acecf.xsd', 'rfce-32.xsd']) {
    const source = await readFile(new URL(`../schemas/${name}`, import.meta.url), 'utf8');
    assert.equal(normalizeAuxiliarySchema(name, source), source.replaceAll('(?:', '('));
    assert.throws(() => normalizeAuxiliarySchema(name, source + ' '), /artifact review/);
  }
});

test('ARECF accepted/rejected receipts pass real auxiliary XSD, unsigned and not sendable', async () => {
  for (const input of [
    { ...receipt, state: 0 as const },
    ...([1, 2, 3, 4] as const).map((reason) => ({ ...receipt, state: 1 as const, reason })),
  ]) {
    const out = await prepareAreCf(scope, input);
    assert.match(out.xml, /<DetalleAcusedeRecibo>/);
    assert.equal(out.signed, false);
    assert.equal(out.sendable, false);
  }
});
test('receipt enforces actor, status/reason and real calendar/timezone', async () => {
  for (const patch of [
    { reason: 1 as const },
    { state: 1 as const },
    { buyerRnc: '101010641' },
    { at: '2026-02-30T10:00:00-04:00' },
    { at: '2026-09-23T10:00:00Z' },
    { encf: 'B0100000001' },
  ])
    await assert.rejects(prepareAreCf(scope, { ...receipt, state: 0, ...patch }));
  await assert.rejects(
    prepareAreCf({ ...scope, environment: 'production' }, { ...receipt, state: 0 }),
  );
});
test('commercial acceptance/rejection validates XSD, escapes text, requires reason only for rejection', async () => {
  const base = { ...receipt, issuedOn: '2026-09-20', total: '118.00' };
  const out = await prepareAceCf(scope, {
    ...base,
    state: 2,
    rejectionReason: 'Mercancía <distinta> & averiada',
  });
  assert.match(out.xml, /&lt;distinta&gt; &amp;/);
  await prepareAceCf(scope, { ...base, state: 1 });
  await assert.rejects(prepareAceCf(scope, { ...base, state: 2 }));
  await assert.rejects(prepareAceCf(scope, { ...base, state: 1, rejectionReason: 'x' }));
  await assert.rejects(prepareAceCf(scope, { ...base, state: 1, total: '118.001' }));
});
test('ANECF computes inclusive counts, validates all ten types and rejects overlaps/inverted/mixed ranges', async () => {
  const groups = ([31, 32, 33, 34, 41, 43, 44, 45, 46, 47] as const).map((type) => ({
    type,
    ranges: [{ from: `E${type}0000000001`, to: `E${type}0000000003` }],
  }));
  const out = await prepareAnEcf(scope, { at: receipt.at, groups });
  assert.match(out.xml, /<CantidadeNCFAnulados>30</);
  for (const ranges of [
    [{ from: 'E310000000003', to: 'E310000000001' }],
    [{ from: 'E310000000001', to: 'E320000000002' }],
    [
      { from: 'E310000000001', to: 'E310000000003' },
      { from: 'E310000000003', to: 'E310000000004' },
    ],
  ])
    await assert.rejects(prepareAnEcf(scope, { at: receipt.at, groups: [{ type: 31, ranges }] }));
});
test('seed schema and input restrictions; no fake signature', async () => {
  const out = await prepareSeed(scope, 'synthetic-random-challenge', '2026-09-23T14:00:00Z');
  assert.match(out.xml, /<SemillaModel>/);
  assert.ok(!out.xml.includes('Signature'));
  await assert.rejects(prepareSeed(scope, 'x', '2026-02-30T00:00:00Z'));
});
function rfceFixture() {
  const sections = fixture(32);
  const header = sections[0]!;
  sections[0] = e(
    'Encabezado',
    (header.value as ReturnType<typeof e>[]).map((node) =>
      node.name === 'Totales'
        ? e('Totales', [e('MontoExento', '100.00'), e('MontoTotal', '100.00')])
        : node,
    ),
  );
  return e('ECF', sections);
}
test('RFCE projects E32 fields, binds source hash, validates XSD and rejects threshold/mismatched totals', async () => {
  const source = rfceFixture();
  const binding = {
    unsignedEcfSha256: createHash('sha256').update(serializeXml(source)).digest('hex'),
    securityCode: 'Ab12+/',
  };
  const out = await prepareRfce(scope, source, binding);
  assert.match(out.xml, /<RFCE>/);
  assert.ok(!out.xml.includes('DetallesItems'));
  await assert.rejects(
    prepareRfce(scope, source, { ...binding, unsignedEcfSha256: '0'.repeat(64) }),
  );
  const threshold = e(
    'ECF',
    replaceField(source.value as ReturnType<typeof e>[], 'MontoTotal', '250000.00'),
  );
  await assert.rejects(
    prepareRfce(scope, threshold, {
      ...binding,
      unsignedEcfSha256: createHash('sha256').update(serializeXml(threshold)).digest('hex'),
    }),
    /RFCE_THRESHOLD/,
  );
});

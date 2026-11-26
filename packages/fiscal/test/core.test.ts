import assert from 'node:assert/strict';
import test from 'node:test';
import { ECF_TYPES, scopeKey } from '../src/catalog.ts';
import type { EcfType, FiscalScope } from '../src/catalog.ts';
import { formatEncf, parseEncf, planReservation, assertBusinessDate } from '../src/encf.ts';
import type { AuthorizedRange } from '../src/encf.ts';
import { decimalCents, prepareEcfDraft, submissionRoute } from '../src/draft.ts';
import { element, parseSerializedXml, serializeXml } from '../src/xml.ts';
import type { XmlElement } from '../src/xml.ts';
import { fixture, replaceField, scope } from './fixtures.ts';

for (const type of ECF_TYPES) {
  test(`E${type}: first/last and above 32-bit sequence round-trip`, () => {
    for (const value of ['1', '2147483648', '9999999999']) {
      const encf = formatEncf(type, value);
      assert.equal(encf.length, 13);
      assert.deepEqual(parseEncf(encf), { type, sequence: value });
    }
  });
}

test('reject invalid numbers, unsupported types and local NCF', () => {
  for (const value of ['0', '-1', '1.5', '1e2', '10000000000', ' 1', '']) {
    assert.throws(() => formatEncf(31, value));
  }
  assert.throws(() => formatEncf(42 as EcfType, '1'));
  for (const value of ['B0100000001', 'E420000000001', 'E310000000000', 'e310000000001']) {
    assert.throws(() => parseEncf(value));
  }
});

const range: AuthorizedRange = {
  id: 'synthetic-range',
  scope,
  type: 31,
  first: '9999999998',
  last: '9999999999',
  next: '9999999998',
  validFrom: '2026-01-01',
  validUntil: '2026-12-31',
  authorizationReference: 'SYNTHETIC-TEST-ONLY',
};

test('reservation planning does not mutate state and handles exhaustion', () => {
  assert.deepEqual(planReservation(range, scope, '2026-12-31'), {
    encf: 'E319999999998',
    next: '9999999999',
    exhausted: false,
  });
  assert.equal(range.next, '9999999998');
  assert.deepEqual(planReservation({ ...range, next: '9999999999' }, scope, '2026-12-31'), {
    encf: 'E319999999999',
    next: null,
    exhausted: true,
  });
  assert.throws(() => planReservation({ ...range, next: null }, scope, '2026-12-31'));
});

test('isolate tenant, RNC, environment and validate authorization dates', () => {
  for (const changed of [
    { ...scope, tenantId: 'other' },
    { ...scope, issuerRnc: '101010641' },
    { ...scope, environment: 'precertification' as const },
  ]) {
    assert.notEqual(scopeKey(scope), scopeKey(changed));
    assert.throws(() => planReservation(range, changed, '2026-09-20'));
  }
  for (const date of ['2025-12-31', '2027-01-01', '2026-02-29', '20-09-2026']) {
    assert.throws(() => planReservation(range, scope, date));
  }
  assert.throws(() =>
    planReservation({ ...range, authorizationReference: '' }, scope, '2026-09-20'),
  );
  assert.throws(() => planReservation({ ...range, next: '1' }, scope, '2026-09-20'));
  assertBusinessDate('2028-02-29');
});

test('RFCE boundary is exact and restricted to E32', () => {
  assert.equal(submissionRoute(32, '249999.99'), 'RFCE');
  assert.equal(submissionRoute(32, '250000.00'), 'ECF');
  assert.equal(submissionRoute(32, '250000.01'), 'ECF');
  for (const type of ECF_TYPES.filter((type) => type !== 32))
    assert.equal(submissionRoute(type, '1'), 'ECF');
  assert.equal(decimalCents('9999999999999999.99'), 999999999999999999n);
  for (const value of ['NaN', 'Infinity', '-1', '1e5', '1,000', '0.001', ' 1']) {
    assert.throws(() => decimalCents(value));
  }
});

test('XML escaping preserves text and rejects unsafe trees', () => {
  assert.match(
    serializeXml(element('Name', 'A & <B> "C" \'D\'')),
    /A &amp; &lt;B&gt; "C" 'D'/,
  );
  for (const node of [
    element('Name', ''),
    element('Name', '\u0000'),
    element('Name', '\ud800'),
    element('Name', []),
    element('!DOCTYPE', 'x'),
    element('Signature', 'fake'),
    element('x:tag', 'x'),
    element('Name', 'x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    assert.throws(() => serializeXml(node));
  }
});

test('canonical XML parser round-trips generated trees and rejects general XML syntax', () => {
  const tree = element('Root', [
    element('Text', 'A & <B> "C" \'D\'\rline'),
    element('Comprador', []),
  ]);
  const xml = serializeXml(tree);
  assert.deepEqual(parseSerializedXml(xml), tree);
  for (const invalid of [
    xml.replace('<Root>', '<Root id="1">'),
    xml.replace('<Text>', '<!--x--><Text>'),
    xml.replace('&amp;', '&unknown;'),
    xml.replace('</Root>', '</Root><Other>x</Other>'),
    xml.replace('<Text>', '<Signature>fake</Signature><Text>'),
    xml.replace('<?xml version="1.0" encoding="utf-8"?>', ''),
  ])
    assert.throws(() => parseSerializedXml(invalid), /INVALID_CANONICAL_XML/);
});

test('draft fails closed on scope mismatch, invalid dates and production', async () => {
  const validator = {
    validateUnsignedEcf: async () => {
      throw new Error('Must not reach XSD');
    },
  };
  await assert.rejects(
    prepareEcfDraft({ ...scope, environment: 'production' }, 31, fixture(31), validator),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  await assert.rejects(prepareEcfDraft(scope, 32, fixture(31), validator), /do not match/);
  await assert.rejects(
    prepareEcfDraft({ ...scope, issuerRnc: '101010641' }, 31, fixture(31), validator),
    /issuer/,
  );
  await assert.rejects(
    prepareEcfDraft(scope, 31, replaceField(fixture(31), 'FechaEmision', '31-02-2026'), validator),
    /calendar/,
  );
});

test('runtime scope types, duplicate identity fields and production plans are rejected', async () => {
  assert.throws(() => scopeKey({ ...scope, issuerRnc: 101010632 } as unknown as FiscalScope));
  assert.throws(
    () => planReservation(range, { ...scope, environment: 'production' }, '2026-09-20'),
    /PRODUCTION_ACTIVATION_REQUIRED/,
  );
  const validator = {
    validateUnsignedEcf: async () => {
      throw new Error('Must not reach XSD');
    },
  };
  const sections = fixture(32);
  const header = sections[0].value as XmlElement[];
  header.push(header.find((node) => node.name === 'Emisor')!);
  await assert.rejects(prepareEcfDraft(scope, 32, sections, validator), /exactly one/);
});

test('XML complexity limits and cycles fail deterministically', () => {
  const cycle: XmlElement[] = [];
  const cyclic = element('Cycle', cycle);
  cycle.push(cyclic);
  assert.throws(() => serializeXml(cyclic), /Cyclic/);
  let nested = element('Leaf', 'value');
  for (let i = 0; i < 34; i++) nested = element('Parent', [nested]);
  assert.throws(() => serializeXml(nested), /complexity/);
  assert.throws(
    () => serializeXml({ name: undefined, value: 'value' } as unknown as XmlElement),
    /name/,
  );
});

test('async validation cannot change the captured XML or scope', async () => {
  const mutableScope = { ...scope };
  const sections = fixture(32);
  let validatedXml = '';
  const draft = await prepareEcfDraft(mutableScope, 32, sections, {
    validateUnsignedEcf: async (_type, xml) => {
      validatedXml = xml;
      mutableScope.issuerRnc = '101010641';
      sections.length = 0;
    },
  });
  assert.equal(draft.xml, validatedXml);
  assert.equal(draft.scope.issuerRnc, scope.issuerRnc);
  assert.ok(Object.isFrozen(draft));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ECF_TYPES } from '../src/catalog.ts';
import type { EcfType } from '../src/catalog.ts';
import { FiscalContractError, parseFiscalRequest, snapshotFiscalRequest } from '../src/contract.ts';
import type { FiscalRequestV1 } from '../src/contract.ts';
import { fixedDecimal, roundRatio, scaledDecimal } from '../src/decimal.ts';
import { analyzeFiscalRequest, mapFiscalRequest, prepareMappedEcfDraft } from '../src/mapper.ts';
import { formatEncf } from '../src/encf.ts';
import { element, serializeXml, textAt } from '../src/xml.ts';
import { XmllintDraftValidator } from '../src/xsd-validator.ts';
import { scope } from './fixtures.ts';

const validator = new XmllintDraftValidator();
const signatureTime = '2026-09-20T10:00:00-04:00';

test('documented E31 request example reconciles and validates against XSD', async () => {
  const input = parseFiscalRequest(
    JSON.parse(await readFile(new URL('../examples/e31-dop.json', import.meta.url), 'utf8')),
  );
  const draft = await prepareMappedEcfDraft(scope, input, binding(input), signatureTime, validator);
  assert.ok(draft.xml.includes('<MontoTotal>224.20</MontoTotal>'));
});

// Synthetic mapping cases, not the DGII-assigned RIVNU certification set.
function request(type: EcfType): FiscalRequestV1 {
  const exempt = [43, 44, 47].includes(type);
  const zero = type === 46;
  return {
    version: '1',
    operationId: `synthetic-${type}`,
    source: { documentId: `doc-${type}`, revision: '1' },
    type,
    issuedOn: '2026-09-20',
    currency: 'DOP',
    pricesIncludeTax: false,
    issuer: {
      rnc: scope.issuerRnc,
      fiscalName: 'EMISOR SINTETICO',
      address: 'Dirección de prueba',
    },
    ...(![32, 43].includes(type)
      ? {
          buyer: {
            kind: [46, 47].includes(type) ? ('FOREIGN' as const) : ('DOMESTIC' as const),
            identifier: [46, 47].includes(type) ? 'SYNTHETIC-FOREIGN' : '101010641',
            fiscalName: 'COMPRADOR SINTETICO',
          },
        }
      : {}),
    ...([31, 32, 33, 34, 44, 45, 46].includes(type) ? { incomeType: '01' as const } : {}),
    payment: { type: 1 },
    ...([33, 34].includes(type)
      ? {
          reference: {
            encf: 'E310000000100',
            issuedOn: '2026-09-19',
            code: 3 as const,
            reason: 'Ajuste sintético',
          },
        }
      : {}),
    lines: [
      {
        sourceLineId: 'line-1',
        description: 'Producto & servicio <prueba>',
        kind: [41, 47].includes(type) ? 'SERVICE' : 'GOOD',
        quantity: '1',
        unitPrice: '100',
        billingIndicator: exempt ? 4 : zero ? 3 : 1,
        discount: '0',
        ...(type === 41 ? { withholding: { itbis: '18', isr: '10' } } : {}),
        ...(type === 47 ? { withholding: { itbis: '0', isr: '27' } } : {}),
      },
    ],
    expectedTotals: {
      net: '100',
      itbis: exempt || zero ? '0' : '18',
      total: exempt || zero ? '100' : '118',
      itbisWithheld: type === 41 ? '18' : '0',
      isrWithheld: type === 41 ? '10' : type === 47 ? '27' : '0',
    },
  };
}

function binding(input: FiscalRequestV1) {
  return {
    scope,
    operationId: input.operationId,
    payloadSha256: analyzeFiscalRequest(scope, input).payloadSha256,
    encf: formatEncf(input.type, '1'),
    businessDate: input.issuedOn,
    validUntil: '2027-12-31',
  };
}

function rejectsRule(input: unknown, code: string) {
  assert.throws(
    () => analyzeFiscalRequest(scope, input),
    (error: unknown) => error instanceof FiscalContractError && error.code === code,
  );
}

for (const type of ECF_TYPES) {
  test(`mapper E${type}: typed request -> calculated totals -> real XSD unsigned draft`, async () => {
    const input = request(type);
    const draft = await prepareMappedEcfDraft(
      scope,
      input,
      binding(input),
      signatureTime,
      validator,
    );
    assert.equal(draft.type, type);
    assert.equal(draft.sendable, false);
    assert.equal(draft.mappingProfile, 'DOP_BASIC_V1');
    assert.equal(draft.payloadSha256, snapshotFiscalRequest(scope, input).payloadSha256);
    assert.ok(draft.outstandingChecks.includes('FISCAL_BUSINESS_RULES'));
    assert.ok(draft.xml.includes('Producto &amp; servicio &lt;prueba&gt;'));
    assert.ok(!draft.xml.includes('<Signature'));
    assert.ok(Object.isFrozen(draft.source));
    if (type === 32) assert.ok(draft.xml.includes('<Comprador></Comprador>'));
    if (type === 47) assert.ok(!draft.xml.includes('TotalITBISRetenido'));
  });
}

test('fixed-point precision, overflow, half-up boundaries and malformed decimals', () => {
  assert.equal(fixedDecimal(scaledDecimal('9999999999999999.9999', 4), 4), '9999999999999999.9999');
  assert.equal(roundRatio(5n, 10n), 1n);
  assert.equal(roundRatio(4n, 10n), 0n);
  assert.equal(roundRatio(15n, 10n), 2n);
  for (const value of [
    1,
    '1e2',
    'NaN',
    'Infinity',
    '-1',
    '01',
    '1,00',
    '.1',
    '1.001',
    '10000000000000000',
    null,
  ]) {
    assert.throws(() => scaledDecimal(value, 2));
  }
  assert.throws(() => fixedDecimal(10n ** 18n, 2));
  assert.throws(() => roundRatio(-1n, 1n));
});

test('canonical hash normalizes decimals/key order and binds scope/source revision', () => {
  const input = request(31);
  const initial = snapshotFiscalRequest(scope, input);
  const equivalent = {
    ...Object.fromEntries(Object.entries(input).reverse()),
    lines: [{ ...input.lines[0], quantity: '1.00', unitPrice: '100.0000' }],
  };
  assert.equal(snapshotFiscalRequest(scope, equivalent).payloadSha256, initial.payloadSha256);
  assert.notEqual(
    snapshotFiscalRequest({ ...scope, tenantId: 'other' }, input).payloadSha256,
    initial.payloadSha256,
  );
  assert.notEqual(
    snapshotFiscalRequest({ ...scope, environment: 'precertification' }, input).payloadSha256,
    initial.payloadSha256,
  );
  assert.notEqual(
    snapshotFiscalRequest(scope, { ...input, source: { ...input.source, revision: '2' } })
      .payloadSha256,
    initial.payloadSha256,
  );
  assert.ok(Object.isFrozen(initial.request.lines[0]));
});

test('strict contract rejects unknown fields, extra fiscal features, JS numbers and invalid scopes', () => {
  const input = request(31);
  for (const invalid of [
    { ...input, tenantId: 'injected' },
    { ...input, rawXml: '<ECF/>' },
    { ...input, globalDiscount: '10' },
    { ...input, issuer: { ...input.issuer, operationalName: 'wrong name' } },
    { ...input, lines: [{ ...input.lines[0], additionalTaxes: [] }] },
  ]) {
    rejectsRule(invalid, 'UNKNOWN_OR_UNSUPPORTED_FIELD');
  }
  rejectsRule({ ...input, currency: 'USD' }, 'UNSUPPORTED_VALUE');
  rejectsRule({ ...input, pricesIncludeTax: true }, 'UNSUPPORTED_VALUE');
  rejectsRule({ ...input, lines: [{ ...input.lines[0], unitPrice: 100 }] }, 'INVALID_DECIMAL');
  rejectsRule({ ...input, issuer: { ...input.issuer, rnc: '101010641' } }, 'ISSUER_SCOPE_MISMATCH');
  assert.throws(
    () => analyzeFiscalRequest({ ...scope, environment: 'production' }, input),
    /PRODUCTION_DISABLED/,
  );
  rejectsRule({ ...input, lines: [input.lines[0], input.lines[0]] }, 'DUPLICATE_LINE');
  rejectsRule({ ...input, lines: new Array(1001).fill(input.lines[0]) }, 'INVALID_LINE_COUNT');
  rejectsRule({ ...input, issuedOn: '2026-02-30' }, 'INVALID_DATE');
});

test('all totals must reconcile and discounts cannot exceed the exact line product', () => {
  const input = request(31);
  for (const key of Object.keys(input.expectedTotals)) {
    rejectsRule(
      { ...input, expectedTotals: { ...input.expectedTotals, [key]: '999.99' } },
      'TOTAL_MISMATCH',
    );
  }
  rejectsRule(
    { ...input, lines: [{ ...input.lines[0], discount: '100.01' }] },
    'DISCOUNT_EXCEEDS_LINE',
  );
});

test('aggregate tax rounding does not sum already rounded per-line taxes', async () => {
  const input: FiscalRequestV1 = {
    ...request(31),
    lines: [1, 2].map((i) => ({
      ...request(31).lines[0],
      sourceLineId: `line-${i}`,
      unitPrice: '0.025',
    })),
    expectedTotals: {
      net: '0.06',
      itbis: '0.01',
      total: '0.07',
      itbisWithheld: '0',
      isrWithheld: '0',
    },
  };
  const draft = await prepareMappedEcfDraft(scope, input, binding(input), signatureTime, validator);
  assert.ok(draft.xml.includes('<TotalITBIS1>0.01</TotalITBIS1>'));
  assert.equal((draft.xml.match(/<MontoItem>0.03<\/MontoItem>/g) ?? []).length, 2);
});

test('mixed rates, exempt lines and explicit amount subdiscounts map in XSD order', async () => {
  const input: FiscalRequestV1 = {
    ...request(31),
    lines: [
      { ...request(31).lines[0], sourceLineId: 'a', discount: '10' },
      { ...request(31).lines[0], sourceLineId: 'b', billingIndicator: 2 },
      { ...request(31).lines[0], sourceLineId: 'c', billingIndicator: 3 },
      { ...request(31).lines[0], sourceLineId: 'd', billingIndicator: 4 },
    ],
    expectedTotals: {
      net: '390',
      itbis: '32.20',
      total: '422.20',
      itbisWithheld: '0',
      isrWithheld: '0',
    },
  };
  const draft = await prepareMappedEcfDraft(scope, input, binding(input), signatureTime, validator);
  assert.ok(draft.xml.includes('<MontoGravadoTotal>290.00</MontoGravadoTotal>'));
  assert.ok(draft.xml.includes('<MontoExento>100.00</MontoExento>'));
  assert.ok(
    draft.xml.includes(
      '<TipoSubDescuento>$</TipoSubDescuento><MontoSubDescuento>10.00</MontoSubDescuento>',
    ),
  );
});

test('document-specific indicators and mandatory withholding are enforced beyond XSD', () => {
  for (const type of [43, 44, 47] as const) {
    const input = request(type);
    rejectsRule(
      { ...input, lines: [{ ...input.lines[0], billingIndicator: 1 }] },
      'EXEMPT_REQUIRED',
    );
  }
  rejectsRule(
    { ...request(46), lines: [{ ...request(46).lines[0], billingIndicator: 4 }] },
    'ZERO_RATE_REQUIRED',
  );
  for (const type of [41, 47] as const) {
    const { withholding: _unused, ...line } = request(type).lines[0];
    rejectsRule({ ...request(type), lines: [line] }, 'WITHHOLDING_REQUIRED');
  }
  rejectsRule(
    {
      ...request(31),
      lines: [{ ...request(31).lines[0], withholding: { itbis: '19', isr: '0' } }],
    },
    'EXCESS_ITBIS_WITHHOLDING',
  );
  rejectsRule(
    { ...request(32), lines: [{ ...request(32).lines[0], withholding: { itbis: '0', isr: '0' } }] },
    'WITHHOLDING_NOT_APPLICABLE',
  );
});

test('E32 identity threshold and RFCE route use total including ITBIS', async () => {
  for (const total of ['249999.99', '250000.00']) {
    const input: FiscalRequestV1 = {
      ...request(32),
      lines: [{ ...request(32).lines[0], billingIndicator: 4, unitPrice: total }],
      expectedTotals: { net: total, itbis: '0', total, itbisWithheld: '0', isrWithheld: '0' },
    };
    if (total === '249999.99') {
      const draft = await prepareMappedEcfDraft(
        scope,
        input,
        binding(input),
        signatureTime,
        validator,
      );
      assert.equal(draft.plannedSubmissionRoute, 'RFCE');
    } else {
      rejectsRule(input, 'BUYER_REQUIRED_THRESHOLD');
      const identified = { ...input, buyer: request(31).buyer };
      const draft = await prepareMappedEcfDraft(
        scope,
        identified,
        binding(identified),
        signatureTime,
        validator,
      );
      assert.equal(draft.plannedSubmissionRoute, 'ECF');
    }
  }
});

test('credit-note reference, 30-day boundary and zero-valued text corrections', async () => {
  const input = request(34);
  rejectsRule({ ...input, reference: undefined }, 'REFERENCE_REQUIRED');
  rejectsRule(
    { ...input, reference: { ...input.reference, issuedOn: '2026-09-21' } },
    'FUTURE_REFERENCE',
  );
  const at30: FiscalRequestV1 = {
    ...input,
    reference: { ...input.reference!, issuedOn: '2026-08-21' },
  };
  const mapped = mapFiscalRequest(scope, at30, binding(at30), signatureTime);
  assert.equal(
    textAt(element('ECF', mapped.sections), 'Encabezado', 'IdDoc', 'IndicadorNotaCredito'),
    '0',
  );
  rejectsRule(
    { ...at30, reference: { ...at30.reference!, issuedOn: '2026-08-20' } },
    'LATE_TAX_CREDIT_NOT_SUPPORTED_PROFILE',
  );
  rejectsRule(
    { ...input, reference: { ...input.reference!, code: 2 } },
    'TEXT_CORRECTION_MUST_BE_ZERO',
  );
  const zero: FiscalRequestV1 = {
    ...input,
    reference: { ...input.reference!, code: 2 },
    lines: [{ ...input.lines[0], unitPrice: '0' }],
    expectedTotals: { net: '0', itbis: '0', total: '0', itbisWithheld: '0', isrWithheld: '0' },
  };
  await prepareMappedEcfDraft(scope, zero, binding(zero), signatureTime, validator);
});

test('reservation binds tenant/environment/operation/hash/date/type and rejects expired ranges', () => {
  const input = request(31);
  const original = binding(input);
  for (const changed of [
    { ...original, scope: { ...scope, tenantId: 'other' } },
    { ...original, scope: { ...scope, environment: 'precertification' as const } },
    { ...original, operationId: 'other' },
    { ...original, payloadSha256: 'a'.repeat(64) },
    { ...original, businessDate: '2026-09-19' },
    { ...original, encf: 'E320000000001' },
  ]) {
    assert.throws(
      () => mapFiscalRequest(scope, input, changed, signatureTime),
      /RESERVATION_BINDING_MISMATCH/,
    );
  }
  assert.throws(
    () => mapFiscalRequest(scope, input, { ...original, validUntil: '2026-09-19' }, signatureTime),
    /EXPIRED_SEQUENCE/,
  );
  assert.throws(
    () => mapFiscalRequest(scope, input, { ...original, validUntil: null }, signatureTime),
    /SEQUENCE_EXPIRY_REQUIRED/,
  );
  assert.throws(
    () => mapFiscalRequest(scope, input, original, '2026-09-20T10:00:00Z'),
    /INVALID_SIGNATURE_TIME/,
  );
  assert.throws(
    () => mapFiscalRequest(scope, input, original, '2026-09-19T10:00:00-04:00'),
    /SIGNATURE_BEFORE_ISSUANCE/,
  );
});

test('untrusted objects/accessors are rejected and parsed input is detached/frozen', () => {
  let read = false;
  const input = request(31);
  const malicious = {
    ...input,
    get lines() {
      read = true;
      return input.lines;
    },
  };
  assert.throws(() => parseFiscalRequest(malicious), /UNKNOWN_OR_UNSUPPORTED_FIELD/);
  assert.equal(read, false);
  const parsed = parseFiscalRequest(input);
  assert.notEqual(parsed.lines, input.lines);
  assert.ok(Object.isFrozen(parsed.issuer));
  assert.throws(() => serializeXml(element('RandomEmptyNode', [])));
});

test('buyer, income and credit payment requirements fail before any reservation', () => {
  rejectsRule({ ...request(31), buyer: undefined }, 'DOMESTIC_BUYER_REQUIRED');
  rejectsRule({ ...request(44), buyer: undefined }, 'BUYER_REQUIRED_PROFILE');
  rejectsRule({ ...request(43), buyer: request(31).buyer }, 'BUYER_NOT_APPLICABLE');
  rejectsRule({ ...request(47), buyer: request(31).buyer }, 'FOREIGN_BUYER_REQUIRED');
  rejectsRule({ ...request(31), incomeType: undefined }, 'INCOME_TYPE_REQUIRED');
  rejectsRule({ ...request(43), incomeType: '01' }, 'INCOME_TYPE_NOT_APPLICABLE');
  rejectsRule({ ...request(31), payment: { type: 2 } }, 'CREDIT_DUE_DATE_REQUIRED');
  rejectsRule(
    { ...request(31), payment: { type: 2, dueOn: '2026-09-19' } },
    'CREDIT_DUE_DATE_REQUIRED',
  );
  rejectsRule(
    { ...request(31), payment: { type: 1, dueOn: '2026-09-21' } },
    'CASH_DUE_DATE_NOT_APPLICABLE',
  );
  rejectsRule(
    { ...request(43), payment: { type: 2, dueOn: '2026-09-21' } },
    'CREDIT_NOT_SUPPORTED_PROFILE',
  );
});

test('credit payments, E41 exempt goods and late exempt credit notes validate structurally', async () => {
  const credit: FiscalRequestV1 = { ...request(31), payment: { type: 2, dueOn: '2026-10-20' } };
  const goods: FiscalRequestV1 = {
    ...request(41),
    lines: [
      {
        ...request(41).lines[0],
        kind: 'GOOD',
        billingIndicator: 4,
        withholding: { itbis: '0', isr: '0' },
      },
    ],
    expectedTotals: { net: '100', itbis: '0', total: '100', itbisWithheld: '0', isrWithheld: '0' },
  };
  const late: FiscalRequestV1 = {
    ...request(34),
    reference: { ...request(34).reference!, issuedOn: '2026-08-20' },
    lines: [{ ...request(34).lines[0], billingIndicator: 4 }],
    expectedTotals: goods.expectedTotals,
  };
  for (const input of [credit, goods, late]) {
    const draft = await prepareMappedEcfDraft(
      scope,
      input,
      binding(input),
      signatureTime,
      validator,
    );
    if (input === credit)
      assert.ok(draft.xml.includes('<FechaLimitePago>20-10-2026</FechaLimitePago>'));
    if (input === goods) {
      assert.ok(draft.xml.includes('<MontoITBISRetenido>0.00</MontoITBISRetenido>'));
      assert.ok(!draft.xml.includes('<MontoISRRetenido>'));
    }
    if (input === late)
      assert.ok(draft.xml.includes('<IndicadorNotaCredito>1</IndicadorNotaCredito>'));
  }
});

test('schema-level decimal bounds are also enforced on calculated products and totals', () => {
  const input = request(31);
  assert.throws(
    () =>
      analyzeFiscalRequest(scope, {
        ...input,
        lines: [
          {
            ...input.lines[0],
            quantity: '9999999999999999.99',
            unitPrice: '9999999999999999.9999',
          },
        ],
      }),
    /outside the supported range/,
  );
  rejectsRule({ ...input, lines: [{ ...input.lines[0], quantity: '0' }] }, 'NONPOSITIVE_QUANTITY');
});

test('mapped XML/source identity is immutable across asynchronous validation', async () => {
  const mutable = structuredClone(request(31)) as {
    -readonly [K in keyof FiscalRequestV1]: FiscalRequestV1[K];
  };
  const reservation = binding(mutable);
  let captured = '';
  const draft = await prepareMappedEcfDraft(scope, mutable, reservation, signatureTime, {
    validateUnsignedEcf: async (type, xml) => {
      captured = xml;
      mutable.source = { documentId: 'changed', revision: '999' };
      mutable.lines = [];
      await validator.validateUnsignedEcf(type, xml);
    },
  });
  assert.equal(draft.xml, captured);
  assert.equal(draft.source.documentId, 'doc-31');
  assert.equal(draft.payloadSha256, reservation.payloadSha256);
});

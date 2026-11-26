import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DocumentType,
  FiscalDocumentPurpose,
  FiscalIssuanceMode,
  InvoiceDocumentType,
} from '@qorvex/database';
import {
  buildFiscalCustomerSnapshot,
  buildInlineFiscalCustomerSnapshot,
  fiscalDocumentTypeMatchesPurpose,
  mapFiscalDocumentType,
  readFiscalCustomerSnapshot,
  resolveCheckoutDocumentType,
  resolveFiscalDocumentType,
} from '../src/modules/fiscal-documents/fiscal-document';
import type { UsableFiscalIdentity } from '../src/modules/fiscal-documents/fiscal-document';

// Synthetic verification evidence; no registry lookup or actual authorization.
function verifiedIdentity(): UsableFiscalIdentity {
  return {
    outcome: 'VERIFIED',
    documentType: DocumentType.RNC,
    documentNumber: '1-01-85004-3',
    fiscalName: '  Razón Social de Prueba SRL  ',
    registryStatus: 'ACTIVO',
    source: 'SYNTHETIC_TEST',
    sourceUpdatedAt: new Date('2026-09-19T12:00:00.000Z'),
    verifiedAt: new Date('2026-09-20T10:00:00-04:00'),
  };
}

test('maps purpose and issuer mode to the four supported invoice document types', () => {
  assert.equal(
    mapFiscalDocumentType(FiscalDocumentPurpose.CONSUMER, FiscalIssuanceMode.LOCAL_NCF),
    InvoiceDocumentType.CONSUMER_02,
  );
  assert.equal(
    mapFiscalDocumentType(FiscalDocumentPurpose.FISCAL_CREDIT, FiscalIssuanceMode.LOCAL_NCF),
    InvoiceDocumentType.FISCAL_CREDIT_01,
  );
  assert.equal(
    mapFiscalDocumentType(FiscalDocumentPurpose.CONSUMER, FiscalIssuanceMode.ELECTRONIC_ECF),
    InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
  );
  assert.equal(
    mapFiscalDocumentType(FiscalDocumentPurpose.FISCAL_CREDIT, FiscalIssuanceMode.ELECTRONIC_ECF),
    InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
  );
});

test('routes checkout documents from the issuance family fixed by Order Taking', () => {
  assert.equal(
    resolveCheckoutDocumentType(
      FiscalDocumentPurpose.CONSUMER,
      FiscalIssuanceMode.ELECTRONIC_ECF,
    ),
    InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
  );
  assert.equal(
    resolveCheckoutDocumentType(
      FiscalDocumentPurpose.FISCAL_CREDIT,
      FiscalIssuanceMode.ELECTRONIC_ECF,
    ),
    InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
  );
  assert.equal(
    resolveCheckoutDocumentType(FiscalDocumentPurpose.CONSUMER, FiscalIssuanceMode.LOCAL_NCF),
    InvoiceDocumentType.CONSUMER_02,
  );
  assert.equal(
    resolveCheckoutDocumentType(
      FiscalDocumentPurpose.FISCAL_CREDIT,
      FiscalIssuanceMode.LOCAL_NCF,
    ),
    InvoiceDocumentType.FISCAL_CREDIT_01,
  );
});

test('resolves electronic invoicing after the production pipeline is activated', () => {
  assert.equal(
    resolveFiscalDocumentType(FiscalDocumentPurpose.CONSUMER, FiscalIssuanceMode.ELECTRONIC_ECF),
    InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
  );
  assert.equal(
    resolveFiscalDocumentType(FiscalDocumentPurpose.CONSUMER, FiscalIssuanceMode.LOCAL_NCF),
    InvoiceDocumentType.CONSUMER_02,
  );
});

test('matches each concrete fiscal document only to its persisted purpose', () => {
  assert.equal(
    fiscalDocumentTypeMatchesPurpose(
      FiscalDocumentPurpose.CONSUMER,
      InvoiceDocumentType.CONSUMER_02,
    ),
    true,
  );
  assert.equal(
    fiscalDocumentTypeMatchesPurpose(
      FiscalDocumentPurpose.FISCAL_CREDIT,
      InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
    ),
    true,
  );
  assert.equal(
    fiscalDocumentTypeMatchesPurpose(
      FiscalDocumentPurpose.CONSUMER,
      InvoiceDocumentType.FISCAL_CREDIT_01,
    ),
    false,
  );
  assert.equal(
    fiscalDocumentTypeMatchesPurpose(
      FiscalDocumentPurpose.FISCAL_CREDIT,
      InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
    ),
    false,
  );
});

test('normalizes a valid Dominican fiscal customer and rejects invalid or generic identities', () => {
  const snapshot = buildFiscalCustomerSnapshot(
    {
      id: 'customer-1',
      name: 'Cliente Fiscal',
      documentType: DocumentType.RNC,
      documentNumber: '1-01-85004-3',
    },
    false,
  );

  assert.deepEqual(snapshot, {
    id: 'customer-1',
    name: 'Cliente Fiscal',
    documentType: DocumentType.RNC,
    documentNumber: '101850043',
  });
  assert.deepEqual(readFiscalCustomerSnapshot(snapshot), snapshot);
  assert.equal(
    buildFiscalCustomerSnapshot(
      {
        id: 'customer-2',
        name: 'Consumidor',
        documentType: DocumentType.CONSUMER_FINAL,
        documentNumber: null,
      },
      true,
    ),
    null,
  );
  assert.equal(
    buildFiscalCustomerSnapshot(
      {
        id: 'customer-3',
        name: 'RNC incorrecto',
        documentType: DocumentType.RNC,
        documentNumber: '123456789',
      },
      false,
    ),
    null,
  );
});

test('accepts passport only for identified consumer flows, never for fiscal credit', () => {
  const foreignCustomer = {
    id: 'customer-foreign',
    name: 'Cliente Extranjero',
    documentType: DocumentType.PASSPORT,
    documentNumber: 'PA1234567',
  };

  assert.equal(buildFiscalCustomerSnapshot(foreignCustomer, false), null);
  assert.deepEqual(buildFiscalCustomerSnapshot(foreignCustomer, true), foreignCustomer);
});

test('builds and reads a one-time fiscal identity without a Customer id', () => {
  const identity = verifiedIdentity();
  const snapshot = buildInlineFiscalCustomerSnapshot('  Cliente de la orden  ', identity);

  assert.deepEqual(snapshot, {
    id: null,
    name: 'Razón Social de Prueba SRL',
    operationalName: 'Cliente de la orden',
    documentType: DocumentType.RNC,
    documentNumber: '101850043',
    verification: {
      outcome: 'VERIFIED',
      source: 'SYNTHETIC_TEST',
      sourceUpdatedAt: '2026-09-19T12:00:00.000Z',
      verifiedAt: '2026-09-20T14:00:00.000Z',
      registryStatus: 'ACTIVO',
    },
  });
  assert.deepEqual(readFiscalCustomerSnapshot(snapshot), snapshot);
  identity.fiscalName = 'Cambio posterior';
  assert.equal(snapshot?.name, 'Razón Social de Prueba SRL');
});

test('reads historical fiscal snapshots without inventing verification evidence', () => {
  assert.deepEqual(
    readFiscalCustomerSnapshot({
      name: 'Snapshot histórico sin id',
      documentType: DocumentType.RNC,
      documentNumber: '101850043',
    }),
    {
      id: null,
      name: 'Snapshot histórico sin id',
      documentType: DocumentType.RNC,
      documentNumber: '101850043',
    },
  );
});

test('inline snapshot rejects missing names and invalid or unsupported documents', () => {
  for (const name of [null, undefined, '', '   ']) {
    assert.equal(buildInlineFiscalCustomerSnapshot(name, verifiedIdentity()), null);
  }
  for (const invalid of [
    { ...verifiedIdentity(), fiscalName: '   ' },
    { ...verifiedIdentity(), documentNumber: '' },
    { ...verifiedIdentity(), documentNumber: '123456789' },
    { ...verifiedIdentity(), documentType: DocumentType.PASSPORT },
    { ...verifiedIdentity(), documentType: DocumentType.CONSUMER_FINAL },
  ]) {
    assert.equal(
      buildInlineFiscalCustomerSnapshot('Nombre operativo', invalid as UsableFiscalIdentity),
      null,
    );
  }
});

test('inline snapshot preserves an already authorized manual override without relabeling it', () => {
  // The caller authorizes/consumes the override; this helper only snapshots its evidence.
  const identity: UsableFiscalIdentity = {
    ...verifiedIdentity(),
    outcome: 'MANUAL_OVERRIDE',
    source: 'MANUAL_OVERRIDE',
    sourceUpdatedAt: null,
    verifiedAt: '2026-09-20T14:00:00.000Z',
    registryStatus: null,
    overrideId: 'synthetic-override-1',
  };
  const snapshot = buildInlineFiscalCustomerSnapshot('Cliente ocasional', identity);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.verification, {
    outcome: 'MANUAL_OVERRIDE',
    source: 'MANUAL_OVERRIDE',
    sourceUpdatedAt: null,
    verifiedAt: '2026-09-20T14:00:00.000Z',
    registryStatus: null,
    overrideId: 'synthetic-override-1',
  });
  assert.deepEqual(readFiscalCustomerSnapshot(snapshot), snapshot);
});

test('snapshot reader never promotes malformed evidence to verified identity', () => {
  const snapshot = buildInlineFiscalCustomerSnapshot('Cliente ocasional', verifiedIdentity());
  assert.ok(snapshot?.verification);
  const { verification, ...withoutVerification } = snapshot;
  for (const invalid of [
    { ...verification, outcome: 'UNVERIFIED' },
    { ...verification, source: '   ' },
    { ...verification, verifiedAt: 'invalid-date' },
    { ...verification, sourceUpdatedAt: 'invalid-date' },
    { ...verification, overrideId: '' },
  ]) {
    assert.deepEqual(
      readFiscalCustomerSnapshot({ ...snapshot, verification: invalid }),
      withoutVerification,
    );
  }
});

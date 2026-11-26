import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CreditApprovalStatus,
  CustomerStatus,
  DocumentType,
  FiscalDocumentPurpose,
  FiscalIssuanceMode,
  InvoiceDocumentType,
  PaymentMethod,
  Prisma,
  Role,
  SalePaymentMode,
  SalesOrderDestination,
  SalesOrderStatus,
} from '@qorvex/database';
import type { AuthenticatedUser } from '../src/common/types/authenticated-request';
import {
  normalizeDominicanDocument,
  validateDominicanDocument,
} from '../src/common/utils/dominican-documents';
import { PosService } from '../src/modules/pos/pos.service';

const tenantId = 'tenant-rivnu';
const cashierId = 'cashier-1';
const cashSessionId = 'cash-session-1';
const verificationTimestamp = new Date().toISOString();

function verifiedInlineFiscalSnapshot(verifiedAt = verificationTimestamp) {
  return {
    id: null,
    name: 'Razón Social Verificada DGII',
    operationalName: 'Cliente Ocasional',
    documentType: DocumentType.RNC,
    documentNumber: '101850043',
    verification: {
      outcome: 'VERIFIED',
      source: 'DGII_OFFICIAL',
      sourceUpdatedAt: '2026-08-20T12:00:00.000Z',
      verifiedAt,
      registryStatus: 'ACTIVO',
    },
  };
}

function cashierUser(): AuthenticatedUser {
  return {
    id: cashierId,
    email: 'caja@rivnu.local',
    name: 'Caja',
    status: 'ACTIVE',
    memberships: [
      {
        id: 'membership-1',
        tenantId,
        role: Role.CASHIER,
        status: 'ACTIVE',
        canUsePos: true,
        canOpenCashSession: true,
        canCloseCashSession: true,
        canApplyDiscount: false,
        canCancelInvoice: false,
        canVoidInvoice: false,
        canAdjustInventory: false,
        canManageProducts: false,
        canManageEmployees: false,
        canViewReports: false,
        canManageFiscalSequences: false,
        canViewCashLogs: false,
        canReprintReceipt: false,
        canTakeOrders: false,
      },
    ],
  } as AuthenticatedUser;
}

test('RIVNU E31 accepts and freezes a verified cédula without reserving a fiscal number', async () => {
  const h = createHarness();
  const updated = await h.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
    fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
    invoiceDocumentType: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
    documentType: DocumentType.CEDULA,
    documentNumber: '001-1391820-5',
  });
  const snapshot = updated.fiscalCustomerSnapshot as { documentType: string; documentNumber: string; verification: { source: string } };
  assert.equal(snapshot.documentType, 'CEDULA');
  assert.equal(snapshot.documentNumber, '00113918205');
  assert.equal(snapshot.verification.source, 'DGII_OFFICIAL');
  assert.equal(h.calls.reserveCalls(), 0);
});

type HarnessOptions = {
  successfulCheckout?: boolean;
  lockOrder?: boolean;
  sessionOpen?: boolean;
  claimUpdateCount?: number;
  order?: Record<string, unknown>;
  customer?: Record<string, unknown> | null;
};

function createHarness(options: HarnessOptions = {}) {
  const baseOrder = {
    id: 'order-1',
    tenantId,
    orderNumber: 'ORD-1',
    destination: SalesOrderDestination.CASH_SALE,
    status: SalesOrderStatus.IN_CASHIER,
    invoiceId: null,
    claimedById: cashierId,
    claimedCashSessionId: cashSessionId,
    claimExpiresAt: new Date(Date.now() + 60_000),
    paymentMode: SalePaymentMode.CASH,
    customerId: null,
    clientName: 'Cliente Ocasional',
    creditApproval: null,
    subtotal: new Prisma.Decimal(100),
    taxTotal: new Prisma.Decimal(18),
    discountTotal: new Prisma.Decimal(0),
    total: new Prisma.Decimal(118),
    items: [
      {
        productId: 'product-1',
        sku: 'SKU-1',
        barcode: null,
        description: 'Producto',
        quantity: new Prisma.Decimal(1),
        unit: 'UNIT',
        reservedQuantity: 1,
        unitPrice: new Prisma.Decimal(100),
        discountTotal: new Prisma.Decimal(0),
        taxCategory: 'ITBIS_18',
        taxRate: new Prisma.Decimal('0.18'),
        taxTotal: new Prisma.Decimal(18),
        subtotal: new Prisma.Decimal(100),
        total: new Prisma.Decimal(118),
        product: {
          id: 'product-1',
          trackInventory: false,
        },
      },
    ],
    fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
    fiscalDocumentTypeSnapshot: InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
    fiscalCustomerSnapshot: null,
    ...options.order,
  };
  const rawValues: unknown[][] = [];
  const customerQueries: unknown[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const invoiceCreates: Array<Record<string, unknown>> = [];
  const invoiceUpdates: Array<Record<string, unknown>> = [];
  const executeRawCalls: unknown[][] = [];
  const paymentWrites: unknown[] = [];
  const cashWrites: unknown[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const availabilityChecks: Array<{ tenantId: string; documentType: InvoiceDocumentType }> = [];
  const salesOrderUpdateManyCalls: Array<Record<string, unknown>> = [];
  let reserveCalls = 0;
  let localSaleReserveCalls = 0;
  let rawCall = 0;
  let latestInvoice: Record<string, unknown> | null = null;

  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      rawValues.push(values);
      rawCall += 1;
      if (rawCall === 1) {
        return options.lockOrder === false ? [] : [{ id: baseOrder.id }];
      }
      return [{ id: cashSessionId }];
    },
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      executeRawCalls.push(values);
      return 1;
    },
    salesOrder: {
      updateMany: async (args: Record<string, unknown>) => {
        salesOrderUpdateManyCalls.push(args);
        return { count: options.claimUpdateCount ?? 1 };
      },
      findFirst: async () => baseOrder,
      findUniqueOrThrow: async () => baseOrder,
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { ...baseOrder, ...args.data };
      },
    },
    cashSession: {
      findFirst: async () =>
        options.sessionOpen === false
          ? null
          : { id: cashSessionId, cashRegister: { name: 'Test', location: 'Test' } },
    },
    invoice: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        invoiceCreates.push(data);
        const now = new Date();
        const lines =
          (data.items as { create?: Array<Record<string, unknown>> } | undefined)?.create ?? [];
        latestInvoice = {
          id: 'invoice-test',
          createdAt: now,
          updatedAt: now,
          ...data,
          fiscalCustomerSnapshot:
            data.fiscalCustomerSnapshot === Prisma.JsonNull ? null : data.fiscalCustomerSnapshot,
          items: lines.map((line, index) => ({
            id: `invoice-line-${index + 1}`,
            invoiceId: 'invoice-test',
            ...line,
          })),
          customer: null,
          payments: [],
          electronicDocument: null,
        };
        return latestInvoice;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        invoiceUpdates.push(data);
        latestInvoice = { ...latestInvoice, ...data, updatedAt: new Date() };
        return latestInvoice;
      },
      findUniqueOrThrow: async () => latestInvoice ?? { id: 'invoice-test', ...invoiceCreates[0] },
    },
    payment: { create: async (args: unknown) => {paymentWrites.push(args);return {};} },
    cashMovement: { create: async (args: unknown) => {cashWrites.push(args);return {};} },
    employeeActivityLog: { createMany: async () => ({ count: 3 }) },
    customer: {
      findFirst: async (args: unknown) => {
        customerQueries.push(args);
        return options.customer ?? null;
      },
    },
    tenant: {
      findUnique: async () => ({
        id: tenantId,
        fiscalIssuanceMode: FiscalIssuanceMode.LOCAL_NCF,
        rnc: '101850043',
        legalName: 'Ferretería RIVNU SRL',
        commercialName: 'Ferretería RIVNU',
        address: 'La Vega',
        phone: '8095550101',
        email: 'facturacion@rivnu.local',
        branding: { logoUrl: null },
      }),
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return args.data;
      },
    },
    fiscalSequence: {
      fields: { endNumber: 'endNumber' },
    },
    localSaleSequence: {
      upsert: async () => {
        localSaleReserveCalls += 1;
        return { nextNumber: BigInt(localSaleReserveCalls + 1) };
      },
    },
  };

  const prisma = {
    employeeProfile: {
      findFirst: async () => ({ id: 'employee-1' }),
    },
    $transaction: async <T>(operation: (client: typeof tx) => Promise<T>) => operation(tx),
  };
  const fiscalSequences = {
    assertElectronicAvailable: async (selectedTenantId: string, ecfType: 31 | 32) => {
      availabilityChecks.push({
        tenantId: selectedTenantId,
        documentType:
          ecfType === 31
            ? InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31
            : InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
      });
    },
    assertAvailable: async (
      _tx: unknown,
      selectedTenantId: string,
      documentType: InvoiceDocumentType,
    ) => {
      availabilityChecks.push({ tenantId: selectedTenantId, documentType });
    },
    reserve: async () => {
      reserveCalls += 1;
      if (options.successfulCheckout)
        return {
          id: 'synthetic-sequence',
          ncf: 'B0200000001',
          validUntil: new Date('2027-12-31'),
          authorizationNumber: 'SYNTHETIC',
        };
      throw new Error('reserve must not run while confirming fiscal details');
    },
  };
  const taxIdentities = {
    requireUsableIdentity: async (input: {
      documentType: 'RNC' | 'CEDULA';
      documentNumber: string;
      overrideId?: string | null;
    }) => {
      if (!validateDominicanDocument(input.documentType, input.documentNumber)) {
        throw new BadRequestException('La identidad fiscal indicada no es válida.');
      }
      const checkedAt = new Date(verificationTimestamp);
      return {
        outcome: 'VERIFIED' as const,
        documentType: input.documentType,
        documentNumber: normalizeDominicanDocument(input.documentNumber),
        fiscalName: 'Razón Social Verificada DGII',
        registryStatus: 'ACTIVO',
        source: 'DGII_OFFICIAL' as const,
        sourceUpdatedAt: new Date('2026-08-20T12:00:00.000Z'),
        checkedAt,
      };
    },
    toVerificationSnapshot: (identity: {
      documentType: 'RNC' | 'CEDULA';
      documentNumber: string;
      fiscalName: string;
      registryStatus: string;
      source: 'DGII_OFFICIAL';
      sourceUpdatedAt: Date;
      checkedAt: Date;
    }) => ({
      outcome: 'VERIFIED' as const,
      documentType: identity.documentType,
      documentNumber: identity.documentNumber,
      fiscalName: identity.fiscalName,
      registryStatus: identity.registryStatus,
      source: identity.source,
      sourceUpdatedAt: identity.sourceUpdatedAt.toISOString(),
      verifiedAt: identity.checkedAt.toISOString(),
    }),
  };

  return {
    service: new PosService(prisma as never, fiscalSequences as never, taxIdentities as never),
    calls: {
      rawValues,
      customerQueries,
      updates,
      invoiceCreates,
      invoiceUpdates,
      executeRawCalls,
      paymentWrites,
      cashWrites,
      audits,
      availabilityChecks,
      salesOrderUpdateManyCalls,
      reserveCalls: () => reserveCalls,
      localSaleReserveCalls: () => localSaleReserveCalls,
    },
  };
}

for (const documentType of [InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
  InvoiceDocumentType.CONSUMER_ELECTRONIC_32,InvoiceDocumentType.LOCAL_SALE_NOTE]) {
  test(`dispatch wake for ${documentType} happens only after a successful commit`,async()=>{
    const h=createHarness();let wakes=0,commit!:()=>void;
    const invoice={id:'synthetic-invoice',documentType};
    Object.assign(h.service,{fiscalDispatch:{wake:()=>{wakes++;}},
      runSerializable:()=>new Promise(resolve=>{commit=()=>resolve(invoice);})});
    const sale=h.service.completeSale(tenantId,cashierUser(),{orderId:'order-1',paymentMethod:PaymentMethod.CARD});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(wakes,0);commit();assert.equal(await sale,invoice);
    assert.equal(wakes,documentType===InvoiceDocumentType.LOCAL_SALE_NOTE?0:1);
  });
}
test('a rolled-back checkout never wakes the sender',async()=>{
  const h=createHarness();let wakes=0;
  Object.assign(h.service,{fiscalDispatch:{wake:()=>{wakes++;}},
    runSerializable:async()=>{throw Error('SYNTHETIC_ROLLBACK');}});
  await assert.rejects(h.service.completeSale(tenantId,cashierUser(),{
    orderId:'order-1',paymentMethod:PaymentMethod.CARD}),/SYNTHETIC_ROLLBACK/);
  assert.equal(wakes,0);
});
test('a wake failure never turns a committed payment into a failed checkout response',async()=>{
  const h=createHarness();const invoice={id:'synthetic-invoice',documentType:InvoiceDocumentType.CONSUMER_ELECTRONIC_32};
  Object.assign(h.service,{fiscalDispatch:{wake:()=>{throw Error('SYNTHETIC_WAKE_FAILURE');}},
    logger:{warn:()=>{}},runSerializable:async()=>invoice});
  assert.equal(await h.service.completeSale(tenantId,cashierUser(),{
    orderId:'order-1',paymentMethod:PaymentMethod.CARD}),invoice);
});

test('consumer confirmation preserves the e-CF family selected in Order Taking', async () => {
  const harness = createHarness({
    order: { fiscalDocumentTypeSnapshot: InvoiceDocumentType.CONSUMER_ELECTRONIC_32 },
  });
  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    { fiscalPurpose: FiscalDocumentPurpose.CONSUMER },
  );
  assert.equal(updated.fiscalDocumentTypeSnapshot, InvoiceDocumentType.CONSUMER_ELECTRONIC_32);
  assert.deepEqual(harness.calls.availabilityChecks, [
    { tenantId, documentType: InvoiceDocumentType.CONSUMER_ELECTRONIC_32 },
  ]);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('Caja can select a local sale note from an electronically prepared order', async () => {
  const harness = createHarness();
  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    {
      fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
      invoiceDocumentType: InvoiceDocumentType.LOCAL_SALE_NOTE,
    },
  );

  assert.equal(updated.fiscalDocumentTypeSnapshot, InvoiceDocumentType.LOCAL_SALE_NOTE);
  assert.equal(harness.calls.availabilityChecks.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('Caja rejects legacy B01/B02 document choices', async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
      invoiceDocumentType: InvoiceDocumentType.CONSUMER_02,
    }),
    /Nota de venta, E32 o E31/i,
  );
  assert.equal(harness.calls.availabilityChecks.length, 0);
  assert.equal(harness.calls.updates.length, 0);
});

test('electronic fiscal credit confirmation prepares verified identity and validates E31', async () => {
  const harness = createHarness({
    order: { fiscalDocumentTypeSnapshot: InvoiceDocumentType.CONSUMER_ELECTRONIC_32 },
  });
  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      documentType: DocumentType.RNC,
      documentNumber: '1-01-85004-3',
    },
  );
  assert.equal(updated.fiscalDocumentTypeSnapshot, InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31);
  assert.deepEqual(harness.calls.availabilityChecks, [
    { tenantId, documentType: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 },
  ]);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('legacy B02 checkout is rejected without consuming a fiscal sequence', async () => {
  const harness = createHarness({
    successfulCheckout: true,
    order: { fiscalDocumentTypeSnapshot: InvoiceDocumentType.CONSUMER_02 },
  });

  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      cashSessionId,
      paymentMethod: PaymentMethod.CASH,
      amountReceived: 118,
    }),
    /Nota de venta, E32 o E31/i,
  );

  assert.equal(harness.calls.invoiceCreates.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.localSaleReserveCalls(), 0);
});

test('cash consumer checkout rejects E32 before creating fiscal or sale records', async () => {
  const harness = createHarness({ successfulCheckout: true });
  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      cashSessionId,
      paymentMethod: PaymentMethod.CASH,
      amountReceived: 118,
    }),
    /efectivo.*Nota de venta o E31/i,
  );

  assert.equal(harness.calls.invoiceCreates.length, 0);
  assert.equal(harness.calls.availabilityChecks.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.localSaleReserveCalls(), 0);
});

test('local sale note checkout consumes only the internal reference sequence', async () => {
  const harness = createHarness({
    successfulCheckout: true,
    order: { fiscalDocumentTypeSnapshot: InvoiceDocumentType.LOCAL_SALE_NOTE },
  });

  const invoice = await harness.service.completeSale(tenantId, cashierUser(), {
    orderId: 'order-1',
    cashSessionId,
    paymentMethod: PaymentMethod.CASH,
    amountReceived: 118,
  });

  assert.equal(invoice.documentType, InvoiceDocumentType.LOCAL_SALE_NOTE);
  assert.equal(invoice.invoiceNumber, 'RIV-0000000001');
  assert.equal(invoice.ncf, null);
  assert.equal(invoice.eNcf, null);
  assert.equal(invoice.fiscalStatus, 'NOT_APPLICABLE');
  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.localSaleReserveCalls(), 1);
});

test('card checkout rejects a local sale note before reserving its internal reference', async () => {
  const harness = createHarness({
    successfulCheckout: true,
    order: { fiscalDocumentTypeSnapshot: InvoiceDocumentType.LOCAL_SALE_NOTE },
  });

  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      cashSessionId,
      paymentMethod: PaymentMethod.CARD,
      amountReceived: 118,
    }),
    /tarjeta.*E32 o E31/i,
  );

  assert.equal(harness.calls.invoiceCreates.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.localSaleReserveCalls(), 0);
});

test('electronic checkout commits one immutable fiscal request without consuming a local NCF', async () => {
  const harness = createHarness({
    order: {
      fiscalDocumentTypeSnapshot: InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
      items: [
        {
          productId: 'product-1',
          sku: 'SKU-1',
          barcode: null,
          description: 'Producto fiscal',
          quantity: new Prisma.Decimal(1),
          unit: 'UNIT',
          reservedQuantity: 1,
          unitPrice: new Prisma.Decimal(100),
          originalUnitPrice: null,
          fiscalItemKind: 'GOOD',
          discountTotal: new Prisma.Decimal(0),
          taxCategory: 'ITBIS_18',
          taxRate: new Prisma.Decimal('0.18'),
          taxTotal: new Prisma.Decimal(18),
          subtotal: new Prisma.Decimal(100),
          total: new Prisma.Decimal(118),
          product: { id: 'product-1', trackInventory: false },
        },
      ],
    },
  });

  const invoice = await harness.service.completeSale(tenantId, cashierUser(), {
    orderId: 'order-1',
    cashSessionId,
    paymentMethod: PaymentMethod.CARD,
    amountReceived: 118,
  });

  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.executeRawCalls.length, 1);
  assert.equal(harness.calls.invoiceCreates[0].ncf, null);
  assert.equal(harness.calls.invoiceCreates[0].eNcf, null);
  assert.equal(harness.calls.invoiceUpdates[0].status, 'PENDING_ECF');
  assert.equal(harness.calls.invoiceUpdates[0].fiscalStatus, 'PENDING_SEQUENCE');
  assert.equal(invoice.status, 'PENDING_ECF');
});

for (const description of ['x'.repeat(81), 'Producto\u0001inválido', 'Producto\uD800inválido']) {
  test('invalid fiscal text stops checkout before payment, cash movement or dispatch insertion', async () => {
    const h = createHarness({order:{items:[{
      productId:'product-1',sku:'SKU-1',barcode:null,description,quantity:new Prisma.Decimal(1),unit:'UNIT',
      reservedQuantity:1,unitPrice:new Prisma.Decimal(100),originalUnitPrice:new Prisma.Decimal(100),
      fiscalItemKind:'GOOD',discountTotal:new Prisma.Decimal(0),taxCategory:'ITBIS_18',taxRate:new Prisma.Decimal('0.18'),
      taxTotal:new Prisma.Decimal(18),subtotal:new Prisma.Decimal(100),total:new Prisma.Decimal(118),
      product:{id:'product-1',trackInventory:false},
    }]}});
    await assert.rejects(h.service.completeSale(tenantId,cashierUser(),{
      orderId:'order-1',cashSessionId,paymentMethod:PaymentMethod.CARD,amountReceived:118,
    }),/Datos fiscales inválidos/);
    assert.equal(h.calls.paymentWrites.length,0);
    assert.equal(h.calls.cashWrites.length,0);
    assert.equal(h.calls.executeRawCalls.length,0);
    assert.equal(h.calls.invoiceUpdates.length,0);
  });
}

test('checkout persists original price and classification from the order, not the current catalogue', async () => {
  const harness = createHarness({
    successfulCheckout: true,
    order: {
      items: [
        {
          productId: 'product-1',
          sku: null,
          barcode: null,
          description: 'Original',
          quantity: new Prisma.Decimal(1),
          unit: 'UNIT',
          reservedQuantity: 0,
          unitPrice: new Prisma.Decimal(100),
          originalUnitPrice: new Prisma.Decimal(125),
          fiscalItemKind: 'GOOD',
          discountTotal: new Prisma.Decimal(25),
          taxCategory: 'ITBIS_18',
          taxRate: new Prisma.Decimal('0.18'),
          taxTotal: new Prisma.Decimal(18),
          subtotal: new Prisma.Decimal(100),
          total: new Prisma.Decimal(118),
          product: {
            id: 'product-1',
            trackInventory: false,
            fiscalItemKind: 'SERVICE',
            salePrice: new Prisma.Decimal(999),
          },
        },
      ],
      discountTotal: new Prisma.Decimal(25),
    },
  });
  await harness.service.completeSale(tenantId, cashierUser(), {
    orderId: 'order-1',
    cashSessionId,
    paymentMethod: PaymentMethod.CARD,
    amountReceived: 118,
  });
  const line = (
    harness.calls.invoiceCreates[0].items as {
      create: Array<{ originalUnitPrice: Prisma.Decimal; fiscalItemKind: string }>;
    }
  ).create[0];
  assert.equal(line.originalUnitPrice.toString(), '125');
  assert.equal(line.fiscalItemKind, 'GOOD');
});

test('POS fiscal update scopes the order lock to the selected tenant', async () => {
  const harness = createHarness({ lockOrder: false });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'foreign-order', {
      fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
      customerId: null,
    }),
    NotFoundException,
  );

  assert.deepEqual(harness.calls.rawValues[0], ['foreign-order', tenantId]);
  assert.equal(harness.calls.updates.length, 0);
});

test('POS fiscal update requires the cashier that owns the live claim', async () => {
  const harness = createHarness({
    order: { claimedById: 'cashier-2' },
  });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
      customerId: null,
    }),
    ForbiddenException,
  );

  assert.equal(harness.calls.updates.length, 0);
  assert.equal(harness.calls.availabilityChecks.length, 0);
});

test('POS fiscal update rejects an expired claim or a closed cashier session', async () => {
  const expired = createHarness({
    order: { claimExpiresAt: new Date(Date.now() - 1_000) },
  });
  await assert.rejects(
    expired.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
      customerId: null,
    }),
    BadRequestException,
  );

  const closedSession = createHarness({ sessionOpen: false });
  await assert.rejects(
    closedSession.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
      customerId: null,
    }),
    BadRequestException,
  );

  assert.equal(expired.calls.updates.length, 0);
  assert.equal(closedSession.calls.updates.length, 0);
});

test('POS fiscal update cannot replace the customer approved for a credit sale', async () => {
  const harness = createHarness({
    order: {
      paymentMode: SalePaymentMode.CREDIT,
      customerId: 'approved-customer',
      creditApproval: {
        status: CreditApprovalStatus.APPROVED,
        customerId: 'approved-customer',
      },
    },
  });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      customerId: 'different-customer',
    }),
    BadRequestException,
  );

  assert.equal(harness.calls.customerQueries.length, 0);
  assert.equal(harness.calls.updates.length, 0);
});

test('POS fiscal update looks up the persisted order customer inside the active tenant', async () => {
  const harness = createHarness({
    customer: null,
    order: { customerId: 'customer-from-another-tenant' },
  });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
    }),
    NotFoundException,
  );

  assert.deepEqual(harness.calls.customerQueries[0], {
    where: {
      id: 'customer-from-another-tenant',
      tenantId,
    },
  });
  assert.equal(harness.calls.updates.length, 0);
});

test('POS fiscal update does not derive B01 identity from a Customer MANUAL_ENTRY', async () => {
  const customer = {
    id: 'fiscal-customer',
    tenantId,
    name: 'Cliente Fiscal',
    documentType: DocumentType.RNC,
    documentNumber: '101850043',
    status: CustomerStatus.ACTIVE,
    taxIdentityVerification: {
      outcome: 'UNVERIFIED_MANUAL',
      documentType: DocumentType.RNC,
      documentNumber: '101850043',
      fiscalName: 'Cliente Fiscal Introducido Manualmente',
      registryOutcome: 'NOT_FOUND',
      registryStatus: 'NO ENCONTRADO EN EL PADRÓN DGII',
      source: 'MANUAL_ENTRY',
      sourceUpdatedAt: '2026-08-20T12:00:00.000Z',
      registryCheckedAt: '2026-08-21T12:00:00.000Z',
      recordedAt: '2026-08-21T12:00:00.000Z',
    },
  };
  const harness = createHarness({ customer, order: { customerId: customer.id } });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      customerId: customer.id,
    }),
    (error: unknown) => {
      assert.equal(error instanceof BadRequestException, true);
      assert.match((error as BadRequestException).message, /digitar un RNC o cédula válida/i);
      return true;
    },
  );

  assert.equal(harness.calls.customerQueries.length, 1);
  assert.equal(harness.calls.updates.length, 0);
  assert.equal(harness.calls.availabilityChecks.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS fiscal update captures one-time E31 identity from the order without creating a Customer', async () => {
  const harness = createHarness();

  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      customerId: null,
      documentType: DocumentType.RNC,
      documentNumber: '1-01-85004-3',
    },
  );

  assert.equal(updated.customerId, null);
  assert.equal(updated.fiscalDocumentTypeSnapshot, InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31);
  assert.equal(harness.calls.customerQueries.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
  assert.deepEqual(harness.calls.updates[0].fiscalCustomerSnapshot, verifiedInlineFiscalSnapshot());
  assert.deepEqual(harness.calls.availabilityChecks, [
    { tenantId, documentType: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 },
  ]);
  const fiscalAuditMetadata = harness.calls.audits[0].metadata as Record<string, unknown>;
  assert.equal(fiscalAuditMetadata.fiscalIdentitySource, 'DGII_OFFICIAL');
  assert.equal(fiscalAuditMetadata.customerNameSource, 'VERIFIED_FISCAL_IDENTITY');
  assert.equal(fiscalAuditMetadata.customerDocumentLast4, '0043');
  assert.equal(JSON.stringify(harness.calls.audits[0]).includes('101850043'), false);
});

test('POS fiscal update preserves a recurrent cash customer while using independent inline identity', async () => {
  const customer = {
    id: 'recurrent-customer',
    tenantId,
    name: 'Nombre guardado distinto',
    documentType: DocumentType.CONSUMER_FINAL,
    documentNumber: null,
    status: CustomerStatus.ACTIVE,
  };
  const harness = createHarness({ customer, order: { customerId: customer.id } });

  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      documentType: DocumentType.RNC,
      documentNumber: '101850043',
    },
  );

  assert.equal(updated.customerId, customer.id);
  assert.equal(Object.hasOwn(harness.calls.updates[0], 'customerId'), false);
  assert.deepEqual(harness.calls.updates[0].fiscalCustomerSnapshot, verifiedInlineFiscalSnapshot());
});

test('POS prepares anonymous E32 consumer selection below the identity threshold', async () => {
  const harness = createHarness({
    order: { subtotal: new Prisma.Decimal('249999.99') },
  });

  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    { fiscalPurpose: FiscalDocumentPurpose.CONSUMER, customerId: null },
  );

  assert.equal(updated.fiscalPurpose, FiscalDocumentPurpose.CONSUMER);
  assert.equal(updated.fiscalDocumentTypeSnapshot, InvoiceDocumentType.CONSUMER_ELECTRONIC_32);
  assert.equal(harness.calls.updates[0].fiscalCustomerSnapshot, Prisma.JsonNull);
  assert.deepEqual(harness.calls.availabilityChecks, [
    { tenantId, documentType: InvoiceDocumentType.CONSUMER_ELECTRONIC_32 },
  ]);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS keeps the E32 choice independently of the later payment method', async () => {
  const harness = createHarness({
    order: { subtotal: new Prisma.Decimal('250000.00') },
  });

  await harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
    fiscalPurpose: FiscalDocumentPurpose.CONSUMER,
    customerId: null,
  });

  assert.equal(harness.calls.updates.length, 1);
  assert.deepEqual(harness.calls.availabilityChecks, [
    { tenantId, documentType: InvoiceDocumentType.CONSUMER_ELECTRONIC_32 },
  ]);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS fiscal update requires the order name for a one-time B01 identity', async () => {
  const harness = createHarness({ order: { clientName: null } });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      customerId: null,
      documentType: DocumentType.RNC,
      documentNumber: '101850043',
    }),
    (error: unknown) => {
      assert.equal(error instanceof BadRequestException, true);
      assert.match((error as BadRequestException).message, /orden debe tener el nombre/i);
      return true;
    },
  );

  assert.equal(harness.calls.updates.length, 0);
  assert.equal(harness.calls.availabilityChecks.length, 0);
});

test('POS fiscal update keeps the approved credit debtor while using inline B01 identity', async () => {
  const approvedCustomer = {
    id: 'approved-customer',
    tenantId,
    name: 'Deudor guardado',
    documentType: DocumentType.CONSUMER_FINAL,
    documentNumber: null,
    status: CustomerStatus.ACTIVE,
  };
  const harness = createHarness({
    customer: approvedCustomer,
    order: {
      paymentMode: SalePaymentMode.CREDIT,
      customerId: approvedCustomer.id,
      creditApproval: {
        status: CreditApprovalStatus.APPROVED,
        customerId: approvedCustomer.id,
      },
    },
  });

  const updated = await harness.service.updateOrderFiscalDetails(
    tenantId,
    cashierUser(),
    'order-1',
    {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      customerId: approvedCustomer.id,
      documentType: DocumentType.RNC,
      documentNumber: '101850043',
    },
  );

  assert.equal(updated.customerId, approvedCustomer.id);
  assert.equal(Object.hasOwn(harness.calls.updates[0], 'customerId'), false);
  assert.deepEqual(harness.calls.updates[0].fiscalCustomerSnapshot, verifiedInlineFiscalSnapshot());
  const creditAuditMetadata = harness.calls.audits[0].metadata as Record<string, unknown>;
  assert.equal(creditAuditMetadata.fiscalIdentitySource, 'DGII_OFFICIAL');
  assert.equal(creditAuditMetadata.customerNameSource, 'VERIFIED_FISCAL_IDENTITY');
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS fiscal update rejects an invalid B01 identity before checking or consuming a sequence', async () => {
  const harness = createHarness({
    customer: {
      id: 'invalid-customer',
      tenantId,
      name: 'Cliente inválido',
      documentType: DocumentType.RNC,
      documentNumber: '123456789',
      status: CustomerStatus.ACTIVE,
    },
    order: { customerId: 'invalid-customer' },
  });

  await assert.rejects(
    harness.service.updateOrderFiscalDetails(tenantId, cashierUser(), 'order-1', {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      customerId: 'invalid-customer',
      documentType: DocumentType.RNC,
      documentNumber: '123456789',
    }),
    BadRequestException,
  );

  assert.equal(harness.calls.availabilityChecks.length, 0);
  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.updates.length, 0);
});

test('POS checkout handles an explicit null legacy customer without a TypeError', async () => {
  const harness = createHarness({
    order: {
      customerId: 'persisted-customer',
    },
  });

  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      paymentMethod: PaymentMethod.CARD,
      customerId: null,
    } as never),
    (error: unknown) => {
      assert.equal(error instanceof TypeError, false);
      assert.equal(error instanceof BadRequestException, true);
      assert.match(
        (error as BadRequestException).message,
        /fixed by the sales order and cannot be changed/i,
      );
      return true;
    },
  );

  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS checkout repairs a legacy product classification and enters the E31 pipeline', async () => {
  const harness = createHarness({
    order: {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      fiscalDocumentTypeSnapshot: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
      fiscalCustomerSnapshot: verifiedInlineFiscalSnapshot(),
    },
  });

  const invoice = await harness.service.completeSale(tenantId, cashierUser(), {
    orderId: 'order-1',
    paymentMethod: PaymentMethod.CASH,
  } as never);

  assert.equal(harness.calls.reserveCalls(), 0);
  assert.equal(harness.calls.executeRawCalls.length, 1);
  assert.equal(invoice.status, 'PENDING_ECF');
});

test('POS checkout rejects an expired E31 identity before creating a fiscal request', async () => {
  const staleVerifiedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  const harness = createHarness({
    order: {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      fiscalDocumentTypeSnapshot: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
      fiscalCustomerSnapshot: verifiedInlineFiscalSnapshot(staleVerifiedAt),
    },
  });

  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      paymentMethod: PaymentMethod.CASH,
    } as never),
    (error: unknown) => {
      assert.equal(error instanceof BadRequestException, true);
      assert.match((error as BadRequestException).message, /validación fiscal.*venció/i);
      return true;
    },
  );

  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS checkout cannot reclaim an expired order with its prior fiscal snapshot', async () => {
  const harness = createHarness({
    claimUpdateCount: 0,
    order: {
      claimExpiresAt: new Date(Date.now() - 1_000),
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      fiscalDocumentTypeSnapshot: InvoiceDocumentType.FISCAL_CREDIT_01,
      fiscalCustomerSnapshot: verifiedInlineFiscalSnapshot(),
    },
  });

  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      paymentMethod: PaymentMethod.CASH,
    } as never),
    BadRequestException,
  );

  const claimWhere = harness.calls.salesOrderUpdateManyCalls[0].where as Record<string, unknown>;
  assert.equal(claimWhere.status, SalesOrderStatus.IN_CASHIER);
  assert.equal(claimWhere.claimedById, cashierId);
  assert.equal(claimWhere.claimedCashSessionId, cashSessionId);
  assert.deepEqual(Object.keys(claimWhere.claimExpiresAt as object), ['gt']);
  assert.equal(harness.calls.reserveCalls(), 0);
});

test('POS checkout rejects pending E31 identity before creating a fiscal request', async () => {
  const harness = createHarness({
    order: {
      fiscalPurpose: FiscalDocumentPurpose.FISCAL_CREDIT,
      fiscalDocumentTypeSnapshot: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
      fiscalCustomerSnapshot: null,
    },
  });

  await assert.rejects(
    harness.service.completeSale(tenantId, cashierUser(), {
      orderId: 'order-1',
      paymentMethod: PaymentMethod.CASH,
    } as never),
    (error: unknown) => {
      assert.equal(error instanceof BadRequestException, true);
      assert.match((error as BadRequestException).message, /E31 requiere/i);
      return true;
    },
  );

  assert.equal(harness.calls.reserveCalls(), 0);
});

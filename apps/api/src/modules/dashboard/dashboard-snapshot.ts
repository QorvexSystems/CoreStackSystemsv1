import {
  Prisma,
  Invoice,
  SalesOrder,
  Product,
  FiscalSequence,
  CashMovement,
  EmployeeActivityLog,
  AuditLog,
  ReturnRequest,
  PurchaseOrder,
  CorporateOrderUnit,
  InvoiceItem,
} from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';

type Name = { name: string };
type AmountSum<K extends string> = { _sum: Record<K, Prisma.Decimal | null> };
type InvoiceRef = Pick<Invoice, 'id' | 'invoiceNumber' | 'total'>;
type CashRow = Pick<
  CashMovement,
  'id' | 'type' | 'amount' | 'method' | 'reason' | 'reference' | 'createdAt'
>;
type ProductionOrder = Pick<
  SalesOrder,
  | 'id'
  | 'orderNumber'
  | 'clientName'
  | 'invoiceId'
  | 'total'
  | 'productionStage'
  | 'exceptionStatus'
  | 'promisedAt'
  | 'priority'
  | 'source'
  | 'requiresProduction'
  | 'designApprovedAt'
  | 'qualityApprovedAt'
  | 'deliveryMethod'
  | 'isCorporate'
  | 'deliveredAt'
> & { corporateUnits: Pick<CorporateOrderUnit, 'status' | 'deliveredAt'>[] };
export type DashboardSnapshot = {
  paymentsForMonth: AmountSum<'total'>;
  paymentsForToday: AmountSum<'total'>;
  returnsMonth: AmountSum<'refundAmount'>;
  returnsToday: AmountSum<'refundAmount'>;
  pendingReturnsAggregate: AmountSum<'refundAmount'>;
  invoiceStatusCounts: { status: Invoice['status']; _count: { _all: number } }[];
  activeCustomers: number;
  activeEmployees: number;
  openCashSessionDetails: {
    id: string;
    openingAmount: Prisma.Decimal;
    openedAt: Date;
    cashRegister: Name;
    openedBy: Name;
    movements: Pick<CashMovement, 'type' | 'amount' | 'method'>[];
  }[];
  orderStatusCounts: {
    status: SalesOrder['status'];
    destination: SalesOrder['destination'];
    _count: { _all: number };
  }[];
  completedOrdersToday: number;
  completedReturns: number;
  pendingReturns: number;
  recentInvoices: (Pick<
    Invoice,
    'id' | 'invoiceNumber' | 'status' | 'total' | 'issuedAt' | 'createdAt'
  > & { customer: Name | null; issuedBy: Name | null })[];
  recentReturns: (Pick<
    ReturnRequest,
    'id' | 'status' | 'reason' | 'refundAmount' | 'createdAt' | 'completedAt'
  > & {
    invoice: InvoiceRef;
    requestedBy: Name;
    approvedBy: Name | null;
    rejectedBy: Name | null;
  })[];
  recentCashMovements: (CashRow & {
    user: Name;
    invoice: InvoiceRef | null;
    cashSession: { cashRegister: Name };
  })[];
  recentEmployeeLogs: (Pick<
    EmployeeActivityLog,
    'id' | 'action' | 'entity' | 'entityId' | 'amount' | 'createdAt'
  > & { user: Name; invoice: InvoiceRef | null })[];
  fiscalSequences: FiscalSequence[];
  productsForStock: (Pick<
    Product,
    'id' | 'name' | 'sku' | 'stock' | 'reservedStock' | 'minStock' | 'trackInventory'
  > & { category: Name | null })[];
  paymentsForSeries: Pick<Invoice, 'issuedAt' | 'total'>[];
  returnsForSeries: Pick<ReturnRequest, 'completedAt' | 'refundAmount'>[];
  quotationSalesInCashier: Pick<SalesOrder, 'total'>[];
  completedQuotationSalesToday: Pick<SalesOrder, 'total'>[];
  receivableInvoicesForAccounting: Pick<Invoice, 'balance' | 'dueDate'>[];
  payableInvoicesForAccounting: Pick<Invoice, 'balance' | 'dueDate'>[];
  purchaseOrdersForAccounting: (Pick<PurchaseOrder, 'status' | 'expectedDeliveryDate'> & {
    supplierInvoice: { id: string } | null;
  })[];
  awaitingReceiptCount: number;
  draftReceiptsCount: number;
  draftReceiptItemsForAccounting: {
    quantityInvoiced: Prisma.Decimal;
    quantityReceived: Prisma.Decimal;
  }[];
  pendingCreditApprovals: AmountSum<'financedAmount'> & { _count: { _all: number } };
  creditApprovalsExceedingLimit: number;
  recentAuditActivity: (Pick<AuditLog, 'id' | 'action' | 'entity' | 'entityId' | 'createdAt'> & {
    user: Name | null;
  })[];
  cashMovementsToday: Pick<CashMovement, 'type' | 'amount' | 'method'>[];
  invoicesToday: number;
  productionOrders: ProductionOrder[];
  channelInvoicesThisMonth: {
    total: Prisma.Decimal;
    salesOrder: Pick<SalesOrder, 'source'> | null;
  }[];
  collections: AmountSum<'amount'>;
  channelReturns: {
    refundAmount: Prisma.Decimal;
    invoice: { salesOrder: Pick<SalesOrder, 'source'> | null };
  }[];
};

const list = (query: Prisma.Sql) =>
  Prisma.sql`COALESCE((SELECT jsonb_agg(rows) FROM (${query}) rows), '[]'::jsonb)`;
const count = (query: Prisma.Sql) => Prisma.sql`(SELECT count(*)::int FROM (${query}) rows)`;
const revenue = Prisma.sql`('ISSUED','PAID','PARTIALLY_PAID','PENDING_ECF','ACCEPTED','CREDITED')`;
const payable = Prisma.sql`('PENDING','PARTIALLY_PAID','PAID')`;

/** JSON timestamps from PostgreSQL are UTC without a suffix; never interpret them in server local time. */
export function hydrateDashboardSnapshot(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => hydrateDashboardSnapshot(item));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, hydrateDashboardSnapshot(item, name)]),
    );
  if (
    [
      'total',
      'amount',
      'balance',
      'openingAmount',
      'refundAmount',
      'financedAmount',
      'quantityReceived',
      'quantityInvoiced',
      'price',
    ].includes(key)
  ) {
    return new Prisma.Decimal(value as string | number);
  }
  if (
    typeof value === 'string' &&
    (key.endsWith('At') || key.endsWith('Date') || key === 'validUntil')
  ) {
    return new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(value) ? value : value + 'Z');
  }
  return value;
}

export async function loadDashboardSnapshot(
  prisma: PrismaService,
  tenantId: string,
  dates: {
    todayStart: Date;
    tomorrowStart: Date;
    monthStart: Date;
    nextMonthStart: Date;
    seriesStart: Date;
  },
): Promise<DashboardSnapshot> {
  const { todayStart, tomorrowStart, monthStart, nextMonthStart, seriesStart } = dates;
  const monthInvoices = Prisma.sql`SELECT * FROM invoices WHERE status IN ${revenue} AND "issuedAt" >= ${monthStart} AND "issuedAt" < ${nextMonthStart}`;
  const todayInvoices = Prisma.sql`SELECT * FROM invoices WHERE status IN ${revenue} AND "issuedAt" >= ${todayStart} AND "issuedAt" < ${tomorrowStart}`;
  const monthReturns = Prisma.sql`SELECT * FROM returns WHERE status = 'COMPLETED' AND "completedAt" >= ${monthStart} AND "completedAt" < ${nextMonthStart}`;
  const todayReturns = Prisma.sql`SELECT * FROM returns WHERE status = 'COMPLETED' AND "completedAt" >= ${todayStart} AND "completedAt" < ${tomorrowStart}`;
  const sum = (query: Prisma.Sql, column: 'total' | 'refundAmount' | 'amount') =>
    Prisma.sql`(SELECT jsonb_build_object('_sum', jsonb_build_object(${column}::text, sum(rows.${Prisma.raw('"' + column + '"')}))) FROM (${query}) rows)`;
  const rows = await prisma.$queryRaw<{ snapshot: unknown }[]>(Prisma.sql`
    WITH invoices AS (SELECT * FROM "Invoice" WHERE "tenantId" = ${tenantId}),
    orders AS (SELECT * FROM "SalesOrder" WHERE "tenantId" = ${tenantId}),
    returns AS (SELECT * FROM "ReturnRequest" WHERE "tenantId" = ${tenantId})
    SELECT jsonb_build_object(
      'paymentsForMonth', ${sum(monthInvoices, 'total')},
      'paymentsForToday', ${sum(todayInvoices, 'total')},
      'returnsMonth', ${sum(monthReturns, 'refundAmount')},
      'returnsToday', ${sum(todayReturns, 'refundAmount')},
      'pendingReturnsAggregate', ${sum(Prisma.sql`SELECT * FROM returns WHERE status = 'REQUESTED'`, 'refundAmount')},
      'invoiceStatusCounts', ${list(Prisma.sql`SELECT status, jsonb_build_object('_all', count(*)) AS "_count" FROM invoices GROUP BY status ORDER BY status`)},
      'activeCustomers', ${count(Prisma.sql`SELECT 1 FROM "Customer" WHERE "tenantId" = ${tenantId} AND status = 'ACTIVE'`)},
      'activeEmployees', ${count(Prisma.sql`SELECT 1 FROM "EmployeeProfile" WHERE "tenantId" = ${tenantId} AND status = 'ACTIVE'`)},
      'openCashSessionDetails', ${list(Prisma.sql`
        SELECT s.id, s."openingAmount", s."openedAt", jsonb_build_object('name', cr.name) AS "cashRegister",
          jsonb_build_object('name', u.name) AS "openedBy",
          ${list(Prisma.sql`SELECT m.type, m.amount, m.method FROM "CashMovement" m WHERE m."cashSessionId" = s.id AND m."tenantId" = ${tenantId}`)} AS movements
        FROM "CashSession" s JOIN "CashRegister" cr ON cr.id = s."cashRegisterId" JOIN "User" u ON u.id = s."openedById"
        WHERE s."tenantId" = ${tenantId} AND s.status = 'OPEN' ORDER BY s."openedAt" DESC`)},
      'orderStatusCounts', ${list(Prisma.sql`SELECT status, destination, jsonb_build_object('_all', count(*)) AS "_count" FROM orders GROUP BY status, destination ORDER BY status, destination`)},
      'completedOrdersToday', ${count(Prisma.sql`SELECT 1 FROM orders WHERE status = 'COMPLETED' AND "completedAt" >= ${todayStart} AND "completedAt" < ${tomorrowStart}`)},
      'completedReturns', ${count(Prisma.sql`SELECT 1 FROM returns WHERE status = 'COMPLETED'`)},
      'pendingReturns', ${count(Prisma.sql`SELECT 1 FROM returns WHERE status = 'REQUESTED'`)},
      'recentInvoices', ${list(Prisma.sql`
        SELECT i.id, i."invoiceNumber", i.status, i.total, i."issuedAt", i."createdAt",
          (SELECT jsonb_build_object('name', c.name) FROM "Customer" c WHERE c.id = i."customerId") AS customer,
          (SELECT jsonb_build_object('name', u.name) FROM "User" u WHERE u.id = i."issuedById") AS "issuedBy"
        FROM invoices i ORDER BY i."createdAt" DESC LIMIT 5`)},
      'recentReturns', ${list(Prisma.sql`
        SELECT r.id, r.status, r.reason, r."refundAmount", r."createdAt", r."completedAt",
          jsonb_build_object('id', i.id, 'invoiceNumber', i."invoiceNumber", 'total', i.total) AS invoice,
          jsonb_build_object('name', u.name) AS "requestedBy",
          (SELECT jsonb_build_object('name', a.name) FROM "User" a WHERE a.id = r."approvedById") AS "approvedBy",
          (SELECT jsonb_build_object('name', a.name) FROM "User" a WHERE a.id = r."rejectedById") AS "rejectedBy"
        FROM returns r JOIN invoices i ON i.id = r."invoiceId" JOIN "User" u ON u.id = r."requestedById"
        ORDER BY r."createdAt" DESC LIMIT 6`)},
      'recentCashMovements', ${list(Prisma.sql`
        SELECT m.id, m.type, m.amount, m.method, m.reason, m.reference, m."createdAt", jsonb_build_object('name', u.name) AS "user",
          (SELECT jsonb_build_object('id', i.id, 'invoiceNumber', i."invoiceNumber", 'total', i.total) FROM invoices i WHERE i.id = m."invoiceId") AS invoice,
          jsonb_build_object('cashRegister', jsonb_build_object('name', cr.name)) AS "cashSession"
        FROM "CashMovement" m JOIN "User" u ON u.id = m."userId" JOIN "CashSession" s ON s.id = m."cashSessionId" JOIN "CashRegister" cr ON cr.id = s."cashRegisterId"
        WHERE m."tenantId" = ${tenantId} ORDER BY m."createdAt" DESC LIMIT 8`)},
      'recentEmployeeLogs', ${list(Prisma.sql`
        SELECT l.id, l.action, l.entity, l."entityId", l.amount, l."createdAt", jsonb_build_object('name', u.name) AS "user",
          (SELECT jsonb_build_object('id', i.id, 'invoiceNumber', i."invoiceNumber", 'total', i.total) FROM invoices i WHERE i.id = l."invoiceId") AS invoice
        FROM "EmployeeActivityLog" l JOIN "User" u ON u.id = l."userId" WHERE l."tenantId" = ${tenantId} ORDER BY l."createdAt" DESC LIMIT 8`)},
      'fiscalSequences', ${list(Prisma.sql`SELECT * FROM "FiscalSequence" WHERE "tenantId" = ${tenantId} AND "documentType" IN ('FISCAL_CREDIT_01','CONSUMER_02') AND status IN ('ACTIVE','EXHAUSTED','EXPIRED') ORDER BY "documentType", "createdAt" DESC`)},
      'productsForStock', ${list(Prisma.sql`
        SELECT p.id, p.name, p.sku, p.stock, p."reservedStock", p."minStock", p."trackInventory",
          (SELECT jsonb_build_object('name', c.name) FROM "ProductCategory" c WHERE c.id = p."categoryId") AS category
        FROM "Product" p WHERE p."tenantId" = ${tenantId} AND p.status = 'ACTIVE' AND p."inventoryDestination" = 'SALES_INVENTORY' ORDER BY p.stock`)},
      'paymentsForSeries', ${list(Prisma.sql`SELECT "issuedAt", total FROM invoices WHERE status IN ${revenue} AND "issuedAt" >= ${seriesStart}`)},
      'returnsForSeries', ${list(Prisma.sql`SELECT "completedAt", "refundAmount" FROM returns WHERE status = 'COMPLETED' AND "completedAt" >= ${seriesStart}`)},
      'quotationSalesInCashier', ${list(Prisma.sql`SELECT total FROM orders WHERE destination = 'CASH_SALE' AND "orderNumber" LIKE 'COT-%' AND status IN ('SENT_TO_CASHIER','IN_CASHIER')`)},
      'completedQuotationSalesToday', ${list(Prisma.sql`SELECT total FROM orders WHERE "orderNumber" LIKE 'COT-%' AND status = 'COMPLETED' AND "completedAt" >= ${todayStart} AND "completedAt" < ${tomorrowStart}`)},
      'receivableInvoicesForAccounting', ${list(Prisma.sql`SELECT balance, "dueDate" FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED','VOIDED','VOID','REJECTED') AND balance > 0`)},
      'payableInvoicesForAccounting', ${list(Prisma.sql`SELECT balance, "dueDate" FROM "SupplierInvoice" WHERE "tenantId" = ${tenantId} AND status IN ${payable} AND balance > 0`)},
      'purchaseOrdersForAccounting', ${list(Prisma.sql`
        SELECT p.status, p."expectedDeliveryDate", (SELECT jsonb_build_object('id', i.id) FROM "SupplierInvoice" i WHERE i."purchaseOrderId" = p.id AND i."tenantId" = ${tenantId}) AS "supplierInvoice"
        FROM "PurchaseOrder" p WHERE p."tenantId" = ${tenantId}`)},
      'awaitingReceiptCount', ${count(Prisma.sql`SELECT 1 FROM "SupplierInvoice" i WHERE i."tenantId" = ${tenantId} AND i.status IN ${payable} AND NOT EXISTS (SELECT 1 FROM "GoodsReceipt" g WHERE g."supplierInvoiceId" = i.id AND g."tenantId" = ${tenantId} AND g.status = 'CONFIRMED')`)},
      'draftReceiptsCount', ${count(Prisma.sql`SELECT 1 FROM "GoodsReceipt" WHERE "tenantId" = ${tenantId} AND status = 'DRAFT'`)},
      'draftReceiptItemsForAccounting', ${list(Prisma.sql`SELECT i."quantityInvoiced", i."quantityReceived" FROM "GoodsReceiptItem" i JOIN "GoodsReceipt" g ON g.id = i."goodsReceiptId" WHERE i."tenantId" = ${tenantId} AND g.status = 'DRAFT' AND i."differenceAccepted" = false`)},
      'pendingCreditApprovals', (SELECT jsonb_build_object('_count', jsonb_build_object('_all', count(*)), '_sum', jsonb_build_object('financedAmount', sum("financedAmount"))) FROM "CreditSaleApproval" WHERE "tenantId" = ${tenantId} AND status = 'PENDING'),
      'creditApprovalsExceedingLimit', ${count(Prisma.sql`SELECT 1 FROM "CreditSaleApproval" WHERE "tenantId" = ${tenantId} AND status = 'PENDING' AND "exceedsCreditLimit" = true`)},
      'recentAuditActivity', ${list(Prisma.sql`SELECT l.id, l.action, l.entity, l."entityId", l."createdAt", (SELECT jsonb_build_object('name', u.name) FROM "User" u WHERE u.id = l."userId") AS "user" FROM "AuditLog" l WHERE l."tenantId" = ${tenantId} ORDER BY l."createdAt" DESC LIMIT 6`)},
      'cashMovementsToday', ${list(Prisma.sql`SELECT type, amount, method FROM "CashMovement" WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${todayStart} AND "createdAt" < ${tomorrowStart}`)},
      'invoicesToday', ${count(todayInvoices)},
      'productionOrders', ${list(Prisma.sql`
        SELECT o.id, o."orderNumber", o."clientName", o."invoiceId", o.total, o."productionStage", o."exceptionStatus", o."promisedAt", o.priority, o.source, o."requiresProduction", o."designApprovedAt", o."qualityApprovedAt", o."deliveryMethod", o."isCorporate", o."deliveredAt",
          ${list(Prisma.sql`SELECT c.status, c."deliveredAt" FROM "CorporateOrderUnit" c WHERE c."salesOrderId" = o.id AND c."tenantId" = ${tenantId}`)} AS "corporateUnits"
        FROM orders o WHERE o.destination = 'CASH_SALE' AND o.status NOT IN ('CANCELLED','DRAFT')`)},
      'channelInvoicesThisMonth', ${list(Prisma.sql`SELECT i.total, (SELECT jsonb_build_object('source', o.source) FROM orders o WHERE o."invoiceId" = i.id) AS "salesOrder" FROM (${monthInvoices}) i`)},
      'collections', ${sum(Prisma.sql`SELECT amount FROM "Payment" WHERE "tenantId" = ${tenantId} AND status = 'COMPLETED' AND "paidAt" >= ${monthStart} AND "paidAt" < ${nextMonthStart}`, 'amount')},
      'channelReturns', ${list(Prisma.sql`SELECT r."refundAmount", jsonb_build_object('salesOrder', (SELECT jsonb_build_object('source', o.source) FROM orders o WHERE o."invoiceId" = r."invoiceId")) AS invoice FROM (${monthReturns}) r`)}
    ) AS snapshot
  `);
  return hydrateDashboardSnapshot(rows[0].snapshot) as DashboardSnapshot;
}

export type ProductSalesSnapshot = {
  products: (Pick<Product, 'id' | 'name' | 'sku' | 'brand' | 'unit' | 'price' | 'barcode'> & {
    category: { id: string; name: string } | null;
  })[];
  invoiceItems: (Pick<
    InvoiceItem,
    'invoiceId' | 'productId' | 'sku' | 'barcode' | 'quantity' | 'total'
  > & {
    invoice: Pick<Invoice, 'issuedAt' | 'createdAt'>;
    returnRequestItems: { quantity: Prisma.Decimal; total: Prisma.Decimal }[];
  })[];
};

export async function loadProductSalesSnapshot(
  prisma: PrismaService,
  tenantId: string,
  salesSince: Date,
): Promise<ProductSalesSnapshot> {
  const rows = await prisma.$queryRaw<{ snapshot: unknown }[]>(Prisma.sql`
    SELECT jsonb_build_object(
      'products', ${list(Prisma.sql`
        SELECT p.id, p.name, p.sku, p.brand, p.unit, p.price, p.barcode,
          (SELECT jsonb_build_object('id', c.id, 'name', c.name) FROM "ProductCategory" c WHERE c.id = p."categoryId") AS category
        FROM "Product" p WHERE p."tenantId" = ${tenantId} AND p.status = 'ACTIVE' AND p."inventoryDestination" = 'SALES_INVENTORY' ORDER BY p.name`)},
      'invoiceItems', ${list(Prisma.sql`
        SELECT l."invoiceId", l."productId", l.sku, l.barcode, l.quantity::text AS quantity, l.total,
          jsonb_build_object('issuedAt', i."issuedAt", 'createdAt', i."createdAt") AS invoice,
          ${list(Prisma.sql`SELECT r.quantity::text AS quantity, r.total FROM "ReturnRequestItem" r JOIN "ReturnRequest" q ON q.id = r."returnRequestId" WHERE r."invoiceItemId" = l.id AND q."tenantId" = ${tenantId} AND q.status = 'COMPLETED'`)} AS "returnRequestItems"
        FROM "InvoiceItem" l JOIN "Invoice" i ON i.id = l."invoiceId"
        WHERE i."tenantId" = ${tenantId} AND i.status IN ${revenue} AND i."issuedAt" >= ${salesSince}`)}
    ) AS snapshot
  `);
  const result = hydrateDashboardSnapshot(rows[0].snapshot) as ProductSalesSnapshot;
  for (const item of result.invoiceItems) {
    item.quantity = new Prisma.Decimal(item.quantity);
    for (const returned of item.returnRequestItems)
      returned.quantity = new Prisma.Decimal(returned.quantity);
  }
  return result;
}

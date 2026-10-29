import { Prisma } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';

// The board needs one row per order; its nested details are assembled in PostgreSQL
// so a remote database needs one round trip instead of one per relation.
export async function loadProductionBoard(
  prisma: PrismaService,
  tenantId: string,
  factoryOnly = false,
) {
  const recent = new Date(Date.now() - 7 * 86400000);
  const factoryFilter = factoryOnly
    ? Prisma.sql`AND "requiresProduction" = true AND "productionStage" IN ('WAITING', 'FACTORY')`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<{ order: Record<string, unknown> }[]>(Prisma.sql`
    SELECT jsonb_build_object(
      'id', o.id,
      'orderNumber', o."orderNumber",
      'clientName', o."clientName",
      'status', o.status,
      'source', o.source,
      'productionStage', o."productionStage",
      'exceptionStatus', o."exceptionStatus",
      'priority', o.priority,
      'promisedAt', o."promisedAt",
      'requiresProduction', o."requiresProduction",
      'designApprovedAt', o."designApprovedAt",
      'qualityApprovedAt', o."qualityApprovedAt",
      'productionNotes', o."productionNotes",
      'deliveredAt', o."deliveredAt",
      'isCorporate', o."isCorporate",
      'deliveryMethod', o."deliveryMethod",
      'dispatchLocation', o."dispatchLocation",
      'deliveryAddress', o."deliveryAddress",
      'deliveryPhone', o."deliveryPhone",
      'invoiceId', o."invoiceId",
      'total', o.total::text,
      'createdAt', o."createdAt",
      'customer', (SELECT jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone)
                   FROM "Customer" c WHERE c.id = o."customerId"),
      'invoice', (SELECT jsonb_build_object('id', i.id, 'invoiceNumber', i."invoiceNumber")
                  FROM "Invoice" i WHERE i.id = o."invoiceId"),
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', i.id,
          'productId', i."productId",
          'sku', i.sku,
          'barcode', i.barcode,
          'description', i.description,
          'quantity', i.quantity::text,
          'personalization', i.personalization,
          'product', (SELECT jsonb_build_object(
            'id', p.id, 'name', p.name, 'sku', p.sku, 'barcode', p.barcode,
            'unit', p.unit, 'kind', p.kind, 'material', p.material,
            'measurement', p.measurement, 'imageUrl', p."imageUrl",
            'status', p.status, 'minStock', p."minStock",
            'category', (SELECT jsonb_build_object('id', c.id, 'name', c.name)
                         FROM "ProductCategory" c WHERE c.id = p."categoryId")
          ) FROM "Product" p WHERE p.id = i."productId")
        ) ORDER BY i.description)
        FROM "SalesOrderItem" i WHERE i."salesOrderId" = o.id
      ), '[]'::jsonb),
      'workflowEvents', COALESCE((
        SELECT jsonb_agg(e.row ORDER BY e."createdAt" DESC)
        FROM (
          SELECT w."createdAt", jsonb_build_object(
            'id', w.id, 'createdAt', w."createdAt", 'fromStage', w."fromStage",
            'toStage', w."toStage", 'note', w.note,
            'changedBy', (SELECT jsonb_build_object('name', u.name)
                          FROM "User" u WHERE u.id = w."changedById")
          ) AS row
          FROM "OrderWorkflowEvent" w
          WHERE w."salesOrderId" = o.id
          ORDER BY w."createdAt" DESC LIMIT 20
        ) e
      ), '[]'::jsonb),
      'corporateUnits', COALESCE((
        SELECT jsonb_agg(to_jsonb(c) ORDER BY c."createdAt")
        FROM "CorporateOrderUnit" c WHERE c."salesOrderId" = o.id
      ), '[]'::jsonb)
    ) AS "order"
    FROM (
      SELECT * FROM "SalesOrder"
      WHERE "tenantId" = ${tenantId}
        AND destination = 'CASH_SALE'
        AND "isExpress" = false
        AND status <> 'DRAFT'
        ${factoryFilter}
        AND (
          (status <> 'CANCELLED' AND "productionStage" <> 'DELIVERED')
          OR "deliveredAt" >= ${recent}
          OR "cancelledAt" >= ${recent}
        )
      ORDER BY priority DESC, "promisedAt" ASC, "createdAt" ASC
      LIMIT 1000
    ) o
    ORDER BY o.priority DESC, o."promisedAt" ASC, o."createdAt" ASC
  `);
  return rows.map(({ order }) => normalizeDates(order));
}

function normalizeDates(value: unknown, key = ''): any {
  if (Array.isArray(value)) return value.map((item) => normalizeDates(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, normalizeDates(item, field)]),
    );
  }
  if (value !== null && (key === 'total' || key === 'quantity')) {
    return new Prisma.Decimal(value as string | number).toString();
  }
  if (typeof value === 'string' && (key.endsWith('At') || key.endsWith('Date'))) {
    return new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(value) ? value : value + 'Z');
  }
  return value;
}

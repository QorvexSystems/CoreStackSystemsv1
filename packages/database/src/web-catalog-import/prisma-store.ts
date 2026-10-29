// Adaptador Prisma del ImportStore. Solo se construye con una URL ya validada por assertIsolatedTarget.
// Usa el cliente generado directamente (no los servicios del API), por lo que no se dispara ninguna
// sincronización con Shopify ni se encola ningún InventorySyncJob.
import { Prisma, PrismaClient } from '../../generated/client';
import type { ExistingState, ImportStore, ImportTx, ProductCreate, WebProductCreate } from './importer';
import type { ImportPlan } from './plan';

const json = (value: unknown) => (value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue));
const TRANSACTION = { maxWait: 10_000, timeout: 120_000 };

function txAdapter(tx: Prisma.TransactionClient): ImportTx {
  return {
    async createWebProduct(data: WebProductCreate) {
      const created = await tx.webProduct.create({
        data: {
          ...data,
          options: json(data.options),
          personalizationOptions: json(data.personalizationOptions),
          imageManifest: json(data.imageManifest),
        },
        select: { id: true },
      });
      return created;
    },
    async createProducts(rows: ProductCreate[]) {
      if (rows.length === 0) return;
      await tx.product.createMany({ data: rows.map((row) => ({ ...row, webOptions: json(row.webOptions) })) });
    },
    countInventorySyncJobs: (tenantId: string) => tx.inventorySyncJob.count({ where: { tenantId } }),
  };
}

export function createPrismaStore(url: string): ImportStore & { disconnect(): Promise<void> } {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  return {
    async findTenantId(slug) {
      return (await prisma.tenant.findUnique({ where: { slug }, select: { id: true } }))?.id ?? null;
    },
    async loadExisting(tenantId: string, plan: ImportPlan): Promise<ExistingState> {
      const [webProducts, products] = await Promise.all([
        prisma.webProduct.findMany({
          where: {
            tenantId,
            OR: [
              { legacyEcommerceId: { in: plan.groups.map((g) => g.legacyEcommerceId) } },
              { slug: { in: plan.groups.map((g) => g.slug) } },
            ],
          },
          select: { id: true, legacyEcommerceId: true, slug: true, importSourceSha256: true },
        }),
        prisma.product.findMany({
          where: {
            tenantId,
            OR: [
              { legacyEcommerceVariantId: { in: plan.products.map((p) => p.legacyEcommerceVariantId) } },
              { sku: { in: plan.skuMapping.map((m) => m.candidateSku) } },
            ],
          },
          select: { id: true, sku: true, price: true, webProductId: true, legacyEcommerceVariantId: true },
        }),
      ]);
      const state: ExistingState = { webProducts: new Map(), slugOwners: new Map(), products: new Map(), skuOwners: new Map() };
      for (const w of webProducts) {
        state.webProducts.set(w.legacyEcommerceId, { id: w.id, importSourceSha256: w.importSourceSha256 });
        state.slugOwners.set(w.slug, w.legacyEcommerceId);
      }
      for (const p of products) {
        if (p.legacyEcommerceVariantId) {
          state.products.set(p.legacyEcommerceVariantId, { id: p.id, sku: p.sku, price: p.price.toFixed(2), webProductId: p.webProductId });
        }
        if (p.sku) state.skuOwners.set(p.sku, p.legacyEcommerceVariantId);
      }
      return state;
    },
    countInventorySyncJobs: (tenantId) => prisma.inventorySyncJob.count({ where: { tenantId } }),
    transaction: (work) => prisma.$transaction((tx) => work(txAdapter(tx)), TRANSACTION),
    disconnect: () => prisma.$disconnect(),
  };
}

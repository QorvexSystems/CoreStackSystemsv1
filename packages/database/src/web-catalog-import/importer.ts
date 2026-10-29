// Ejecución idempotente y transaccional del plan. Solo conoce la interfaz ImportStore: no importa Prisma, ni
// servicios del API, ni nada de Shopify. Escribe únicamente WebProduct y Product (sin movimientos de inventario,
// sin InventorySyncJob, sin publicación).
import { detectSkuCollisions } from './sku-policy';
import type { ImportPlan, ProductPlan, WebProductPlan } from './plan';

export type WebProductCreate = Omit<WebProductPlan, 'variantIds'> & { tenantId: string; published: false };

export type ProductCreate = {
  tenantId: string;
  webProductId: string;
  name: string;
  sku: string;
  originalSku: string | null;
  /** Solo los SKU originales sin cambio nacen aprobados; los candidatos (generados, desambiguados o normalizados) quedan pendientes. */
  skuApprovedAt: Date | null;
  legacyEcommerceVariantId: string;
  legacyShopifyVariantId: string;
  price: string;
  webOptions: ProductPlan['webOptions'];
  // Valores técnicos de un registro sin disponibilidad verificada; no son un conteo físico ni se publican.
  status: 'INACTIVE';
  stock: 0;
  reservedStock: 0;
  webAvailability: 'UNDECIDED';
};

export type ExistingState = {
  webProducts: Map<string, { id: string; importSourceSha256: string | null }>; // por legacyEcommerceId
  slugOwners: Map<string, string>; // slug -> legacyEcommerceId
  products: Map<string, { id: string; sku: string | null; price: string; webProductId: string | null }>; // por legacyEcommerceVariantId
  skuOwners: Map<string, string | null>; // sku -> legacyEcommerceVariantId del dueño (null si no es del catálogo web)
};

export interface ImportTx {
  createWebProduct(data: WebProductCreate): Promise<{ id: string }>;
  createProducts(rows: ProductCreate[]): Promise<void>;
  countInventorySyncJobs(tenantId: string): Promise<number>;
}

export interface ImportStore {
  findTenantId(slug: string): Promise<string | null>;
  loadExisting(tenantId: string, plan: ImportPlan): Promise<ExistingState>;
  countInventorySyncJobs(tenantId: string): Promise<number>;
  transaction<T>(work: (tx: ImportTx) => Promise<T>): Promise<T>;
}

export type Conflict = { kind: 'GROUP' | 'VARIANT'; id: string; reason: string };
export type ImportMode = 'dry-run' | 'isolated' | 'remote-authorized';
export type ImportStatus = 'INVALID_INPUT' | 'DRY_RUN_OK' | 'ABORTED_CONFLICTS' | 'NO_CHANGES' | 'APPLIED' | 'FAILED';

export type ImportReport = {
  mode: ImportMode;
  status: ImportStatus;
  sourceSha256: string;
  tenantSlug: string;
  groups: { planned: number; create: number; unchanged: number; conflict: number };
  variants: { planned: number; create: number; unchanged: number; conflict: number };
  sku: ImportPlan['skuSummary'] & { collisions: number; approvedForRealDatabase: false };
  conflicts: Conflict[];
  errors: string[];
  warnings: string[];
  safety: {
    shopifyCalls: 0;
    inventoryMovementsCreated: 0;
    inventorySyncJobsDelta: number;
    priceTransformations: 0;
    groupsPublished: 0;
    unitsCopied: 0;
  };
  actions: { kind: 'GROUP' | 'VARIANT'; id: string; action: 'CREATE' | 'UNCHANGED' | 'CONFLICT' }[];
};

function baseReport(plan: ImportPlan, mode: ImportMode, sourceSha256: string, tenantSlug: string): ImportReport {
  return {
    mode,
    status: 'DRY_RUN_OK',
    sourceSha256,
    tenantSlug,
    groups: { planned: plan.groups.length, create: 0, unchanged: 0, conflict: 0 },
    variants: { planned: plan.products.length, create: 0, unchanged: 0, conflict: 0 },
    sku: { ...plan.skuSummary, collisions: 0, approvedForRealDatabase: false },
    conflicts: [],
    errors: [...plan.errors],
    warnings: [...plan.warnings],
    safety: {
      shopifyCalls: 0,
      inventoryMovementsCreated: 0,
      inventorySyncJobsDelta: 0,
      priceTransformations: 0,
      groupsPublished: 0,
      unitsCopied: 0,
    },
    actions: [],
  };
}

export type RunOptions = {
  mode: ImportMode;
  tenantSlug: string;
  sourceSha256: string;
  /** Obligatorio en modo isolated. En dry-run es opcional: con almacén se compara contra el estado existente (solo lectura). */
  store?: ImportStore;
};

export async function runImport(plan: ImportPlan, options: RunOptions): Promise<ImportReport> {
  const report = baseReport(plan, options.mode, options.sourceSha256, options.tenantSlug);
  if (plan.errors.length) return { ...report, status: 'INVALID_INPUT' };
  if (options.mode !== 'dry-run' && !options.store) throw new Error(`El modo ${options.mode} requiere un almacén de datos`);

  const store = options.store;
  let tenantId: string | null = null;
  let existing: ExistingState = { webProducts: new Map(), slugOwners: new Map(), products: new Map(), skuOwners: new Map() };
  if (store) {
    tenantId = await store.findTenantId(options.tenantSlug);
    if (!tenantId) return { ...report, status: 'FAILED', errors: [...report.errors, `Tenant inexistente: ${options.tenantSlug}`] };
    existing = await store.loadExisting(tenantId, plan);
  }

  const groupStatus = new Map<string, 'CREATE' | 'UNCHANGED'>();
  for (const group of plan.groups) {
    const found = existing.webProducts.get(group.legacyEcommerceId);
    const slugOwner = existing.slugOwners.get(group.slug);
    if (found) {
      if (found.importSourceSha256 === group.importSourceSha256) {
        groupStatus.set(group.legacyEcommerceId, 'UNCHANGED');
        report.groups.unchanged += 1;
        report.actions.push({ kind: 'GROUP', id: group.legacyEcommerceId, action: 'UNCHANGED' });
      } else {
        report.groups.conflict += 1;
        report.conflicts.push({ kind: 'GROUP', id: group.legacyEcommerceId, reason: 'EXISTS_WITH_DIFFERENT_CONTENT' });
        report.actions.push({ kind: 'GROUP', id: group.legacyEcommerceId, action: 'CONFLICT' });
      }
    } else if (slugOwner && slugOwner !== group.legacyEcommerceId) {
      report.groups.conflict += 1;
      report.conflicts.push({ kind: 'GROUP', id: group.legacyEcommerceId, reason: `SLUG_TAKEN:${group.slug}` });
      report.actions.push({ kind: 'GROUP', id: group.legacyEcommerceId, action: 'CONFLICT' });
    } else {
      groupStatus.set(group.legacyEcommerceId, 'CREATE');
      report.groups.create += 1;
      report.actions.push({ kind: 'GROUP', id: group.legacyEcommerceId, action: 'CREATE' });
    }
  }

  const collisions = detectSkuCollisions(plan.skuMapping, existing.skuOwners);
  report.sku.collisions = collisions.length;
  const collided = new Map<string, string>();
  for (const c of collisions) collided.set(c.variantId, `SKU_${c.reason}:${c.candidateSku}`);

  const variantsToCreate: ProductPlan[] = [];
  for (const product of plan.products) {
    const id = product.legacyEcommerceVariantId;
    const found = existing.products.get(id);
    let conflict = collided.get(id) ?? null;
    if (found) {
      const group = existing.webProducts.get(product.groupLegacyId);
      const same = found.sku === product.sku && found.price === product.price && group !== undefined && found.webProductId === group.id;
      if (same) {
        report.variants.unchanged += 1;
        report.actions.push({ kind: 'VARIANT', id, action: 'UNCHANGED' });
        continue;
      }
      conflict = conflict ?? 'EXISTS_WITH_DIFFERENT_CONTENT';
    }
    if (!conflict && groupStatus.get(product.groupLegacyId) === undefined) conflict = 'GROUP_IN_CONFLICT';
    if (conflict) {
      report.variants.conflict += 1;
      report.conflicts.push({ kind: 'VARIANT', id, reason: conflict });
      report.actions.push({ kind: 'VARIANT', id, action: 'CONFLICT' });
    } else {
      report.variants.create += 1;
      variantsToCreate.push(product);
      report.actions.push({ kind: 'VARIANT', id, action: 'CREATE' });
    }
  }

  if (report.conflicts.length) return { ...report, status: 'ABORTED_CONFLICTS' };
  if (options.mode === 'dry-run') return report;
  if (!store || !tenantId) throw new Error('Estado inconsistente: falta almacén o tenant');
  if (report.groups.create === 0 && variantsToCreate.length === 0) return { ...report, status: 'NO_CHANGES' };

  const jobsBefore = await store.countInventorySyncJobs(tenantId);
  const tenant = tenantId;
  try {
    await store.transaction(async (tx) => {
      const ids = new Map<string, string>();
      for (const group of plan.groups) {
        if (groupStatus.get(group.legacyEcommerceId) !== 'CREATE') continue;
        const { variantIds: _variantIds, ...data } = group;
        void _variantIds;
        const created = await tx.createWebProduct({ ...data, tenantId: tenant, published: false });
        ids.set(group.legacyEcommerceId, created.id);
      }
      for (const group of plan.groups) {
        if (!ids.has(group.legacyEcommerceId)) {
          const current = existing.webProducts.get(group.legacyEcommerceId);
          if (current) ids.set(group.legacyEcommerceId, current.id);
        }
      }
      await tx.createProducts(
        variantsToCreate.map((p) => ({
          tenantId: tenant,
          webProductId: ids.get(p.groupLegacyId) as string,
          name: p.name,
          sku: p.sku,
          originalSku: p.originalSku,
          skuApprovedAt: p.skuRule === 'UNCHANGED' ? new Date() : null,
          legacyEcommerceVariantId: p.legacyEcommerceVariantId,
          legacyShopifyVariantId: p.legacyShopifyVariantId,
          price: p.price,
          webOptions: p.webOptions,
          status: 'INACTIVE',
          stock: 0,
          reservedStock: 0,
          webAvailability: 'UNDECIDED',
        })),
      );
      const jobsAfter = await tx.countInventorySyncJobs(tenant);
      if (jobsAfter !== jobsBefore) throw new Error('La importación generó tareas InventorySyncJob: se revierte');
    });
  } catch (error) {
    return { ...report, status: 'FAILED', errors: [...report.errors, (error as Error).message] };
  }
  return { ...report, status: 'APPLIED' };
}

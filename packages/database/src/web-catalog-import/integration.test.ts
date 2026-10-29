// Prueba de integración contra una base PostgreSQL LOCAL y aislada. Se omite si el entorno no pasa assertIsolatedTarget.
// Cada escenario usa su propio tenant de prueba para no alterar el tenant principal `unique-personalizado`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PrismaClient } from '../../generated/client';
import { assertIsolatedTarget } from './guard';
import { runImport, type ImportStore } from './importer';
import { buildPlan } from './plan';
import { createPrismaStore } from './prisma-store';

const EXPORT_DIR = process.env.ECOMMERCE_EXPORT_DIR ?? '__sin_definir__' /* ruta a data/exports/erp-catalog del e-commerce; sin ella estas pruebas se omiten */;
const catalogPath = join(EXPORT_DIR, 'catalog.normalized.json');
let url: string | null = null;
let reason = '';
try {
  url = assertIsolatedTarget(process.env);
} catch (error) {
  reason = (error as Error).message.split('\n')[0];
}
const skip = !url ? `sin base aislada (${reason})` : !existsSync(catalogPath) ? 'catálogo no disponible' : false;
const catalog = () => JSON.parse(readFileSync(catalogPath, 'utf8'));

const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : (null as unknown as PrismaClient);
const created: string[] = [];
async function newTenant(label: string) {
  const slug = `etl-it-${label}-${Date.now()}`;
  const tenant = await prisma.tenant.create({ data: { name: `Prueba ${label}`, slug } });
  created.push(tenant.id);
  return { id: tenant.id, slug };
}
const counts = async (tenantId: string) => ({
  groups: await prisma.webProduct.count({ where: { tenantId } }),
  products: await prisma.product.count({ where: { tenantId } }),
  movements: await prisma.inventoryMovement.count({ where: { tenantId } }),
  jobs: await prisma.inventorySyncJob.count({ where: { tenantId } }),
});
const ZERO = { groups: 0, products: 0, movements: 0, jobs: 0 };
const importInto = (slug: string, plan: ReturnType<typeof buildPlan>, store: ImportStore) =>
  runImport(plan, { mode: 'isolated', tenantSlug: slug, sourceSha256: 'it', store });

test('integración PostgreSQL local', { skip }, async (t) => {
  const store = createPrismaStore(url as string);
  const plan = buildPlan(catalog());
  assert.deepEqual(plan.errors, []);

  await t.test('importación completa y NO_CHANGES al repetir', async () => {
    const tenant = await newTenant('main');
    const first = await importInto(tenant.slug, plan, store);
    assert.equal(first.status, 'APPLIED');
    assert.deepEqual(await counts(tenant.id), { groups: 174, products: 312, movements: 0, jobs: 0 });
    const stamp = await prisma.product.aggregate({ where: { tenantId: tenant.id }, _max: { updatedAt: true }, _count: true });
    const second = await importInto(tenant.slug, plan, store);
    assert.equal(second.status, 'NO_CHANGES');
    assert.deepEqual([second.groups.unchanged, second.variants.unchanged, second.groups.create, second.variants.create], [174, 312, 0, 0]);
    assert.deepEqual(await counts(tenant.id), { groups: 174, products: 312, movements: 0, jobs: 0 });
    const after = await prisma.product.aggregate({ where: { tenantId: tenant.id }, _max: { updatedAt: true }, _count: true });
    assert.deepEqual(after, stamp, 'ninguna fila modificada en el reintento');
  });

  await t.test('rollback: fallo controlado tras insertar todo deja 0 filas', async () => {
    const tenant = await newTenant('rollback');
    const failing: ImportStore = {
      ...store,
      findTenantId: (slug) => store.findTenantId(slug),
      loadExisting: (id, p) => store.loadExisting(id, p),
      countInventorySyncJobs: (id) => store.countInventorySyncJobs(id),
      transaction: (work) =>
        store.transaction(async (tx) => {
          const result = await work(tx);
          throw new Error('fallo controlado antes del commit');
          return result;
        }),
    };
    const report = await importInto(tenant.slug, plan, failing);
    assert.equal(report.status, 'FAILED');
    assert.match(report.errors.join(' '), /fallo controlado/);
    assert.deepEqual(await counts(tenant.id), ZERO);
  });

  await t.test('rollback: la restricción única de la base aborta a mitad y no queda nada parcial', async () => {
    const tenant = await newTenant('race');
    // Simula una carrera: el SKU del último candidato lo toma otro registro después de la lectura previa.
    const last = plan.skuMapping[plan.skuMapping.length - 1].candidateSku;
    await prisma.product.create({ data: { tenantId: tenant.id, name: 'Ocupa el SKU', sku: last, price: '1.00' } });
    const stale: ImportStore = { ...store, loadExisting: async () => ({ webProducts: new Map(), slugOwners: new Map(), products: new Map(), skuOwners: new Map() }),
      findTenantId: (slug) => store.findTenantId(slug), countInventorySyncJobs: (id) => store.countInventorySyncJobs(id), transaction: (work) => store.transaction(work) };
    const report = await importInto(tenant.slug, plan, stale);
    assert.equal(report.status, 'FAILED');
    assert.match(report.errors.join(' '), /Unique constraint/, 'el fallo proviene de la restricción de la base');
    assert.deepEqual(await counts(tenant.id), { ...ZERO, products: 1 }, 'solo queda el registro previo, ni grupos ni variantes parciales');
  });

  await t.test('conflictos: SKU ocupado, slug, ID histórico, grupo inválido y precio inválido no escriben nada', async () => {
    const sku = await newTenant('sku');
    await prisma.product.create({ data: { tenantId: sku.id, name: 'Ocupa', sku: plan.skuMapping[0].candidateSku, price: '5.00' } });
    const r1 = await importInto(sku.slug, plan, store);
    assert.equal(r1.status, 'ABORTED_CONFLICTS');
    assert.ok(r1.conflicts.some((c) => c.reason.startsWith('SKU_EXISTS_IN_TARGET')));
    assert.deepEqual(await counts(sku.id), { ...ZERO, products: 1 });

    const slug = await newTenant('slug');
    await prisma.webProduct.create({ data: { tenantId: slug.id, legacyEcommerceId: 'OTRO', slug: plan.groups[0].slug, name: 'x', options: [], publicationIntent: 'active' } });
    const r2 = await importInto(slug.slug, plan, store);
    assert.equal(r2.status, 'ABORTED_CONFLICTS');
    assert.ok(r2.conflicts.some((c) => c.reason.startsWith('SLUG_TAKEN')));
    assert.deepEqual(await counts(slug.id), { ...ZERO, groups: 1 });

    const hist = await newTenant('hist');
    await prisma.product.create({ data: { tenantId: hist.id, name: 'Ya importado', sku: 'OTRO-SKU', price: '9.00', legacyEcommerceVariantId: plan.products[0].legacyEcommerceVariantId } });
    const r3 = await importInto(hist.slug, plan, store);
    assert.equal(r3.status, 'ABORTED_CONFLICTS');
    assert.deepEqual(await counts(hist.id), { ...ZERO, products: 1 });

    const dup = catalog();
    dup.products[1].variants[0].legacyShopifyId = dup.products[0].variants[0].legacyShopifyId;
    const invalidGroup = catalog();
    invalidGroup.products[2].variants[0].id = 'UP-P-9999-V01';
    const badPrice = catalog();
    badPrice.products[3].variants[0].price = 10.123;
    for (const [name, data, pattern] of [
      ['dup', dup, /ID histórico de variante duplicado/],
      ['group', invalidGroup, /no pertenece al grupo/],
      ['price', badPrice, /inválido/],
    ] as const) {
      const tenant = await newTenant(name);
      const bad = buildPlan(data);
      assert.ok(bad.errors.some((e) => pattern.test(e)), `${name}: ${bad.errors.join('|')}`);
      assert.equal((await importInto(tenant.slug, bad, store)).status, 'INVALID_INPUT');
      assert.deepEqual(await counts(tenant.id), ZERO);
    }
  });

  await t.test('restricciones de la base: únicos, FK compuesta y RESTRICT', async () => {
    const a = await newTenant('fk-a');
    const b = await newTenant('fk-b');
    const wp = await prisma.webProduct.create({ data: { tenantId: a.id, legacyEcommerceId: 'G1', slug: 'g1', name: 'g', options: [], publicationIntent: 'active' } });
    const base = { tenantId: a.id, name: 'p', price: '1.00' };
    await prisma.product.create({ data: { ...base, sku: 'S1', legacyEcommerceVariantId: 'V1', webProductId: wp.id } });
    await assert.rejects(prisma.product.create({ data: { ...base, sku: 'S1' } }), /Unique constraint/, 'SKU único por tenant');
    await assert.rejects(prisma.product.create({ data: { ...base, sku: 'S2', legacyEcommerceVariantId: 'V1' } }), /Unique constraint/, 'ID histórico único por tenant');
    await assert.rejects(prisma.webProduct.create({ data: { tenantId: a.id, legacyEcommerceId: 'G1', slug: 'g2', name: 'g', options: [], publicationIntent: 'x' } }), /Unique constraint/);
    await assert.rejects(prisma.webProduct.create({ data: { tenantId: a.id, legacyEcommerceId: 'G2', slug: 'g1', name: 'g', options: [], publicationIntent: 'x' } }), /Unique constraint/, 'slug único por tenant');
    await assert.rejects(prisma.product.create({ data: { tenantId: b.id, name: 'p', price: '1.00', sku: 'S9', webProductId: wp.id } }), /Foreign key/, 'un Product no puede apuntar a un grupo de otro tenant');
    await assert.rejects(prisma.webProduct.delete({ where: { id: wp.id } }), /Foreign key|violate/i, 'RESTRICT: no se borra un grupo con variantes');
    // El mismo SKU y los mismos IDs históricos sí pueden existir en otro tenant.
    await prisma.product.create({ data: { tenantId: b.id, name: 'p', price: '1.00', sku: 'S1', legacyEcommerceVariantId: 'V1' } });
    // Producto previo del ERP (sin campos web) sigue siendo válido y admite movimientos.
    const legacy = await prisma.product.create({ data: { tenantId: a.id, name: 'previo', price: '10.00', sku: 'PREVIO', stock: 3 } });
    assert.equal(legacy.webProductId, null);
    await prisma.inventoryMovement.create({ data: { tenantId: a.id, productId: legacy.id, type: 'INITIAL_STOCK', quantity: 3 } });
  });

  await prisma.$transaction([
    prisma.inventoryMovement.deleteMany({ where: { tenantId: { in: created } } }),
    prisma.product.deleteMany({ where: { tenantId: { in: created } } }),
    prisma.webProduct.deleteMany({ where: { tenantId: { in: created } } }),
    prisma.tenant.deleteMany({ where: { id: { in: created } } }),
  ]);
  await store.disconnect();
  await prisma.$disconnect();
});

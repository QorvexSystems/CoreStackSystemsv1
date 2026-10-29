import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertIsolatedTarget, ISOLATED_CONFIRMATION } from './guard';
import { runImport, type ExistingState, type ImportStore, type ProductCreate, type WebProductCreate } from './importer';
import { buildPlan, money } from './plan';
import { detectSkuCollisions, normalizeSku, resolveSkus } from './sku-policy';

const here = __dirname;
const EXPORT_DIR = process.env.ECOMMERCE_EXPORT_DIR ?? '__sin_definir__' /* ruta a data/exports/erp-catalog del e-commerce; sin ella estas pruebas se omiten */;
const realCatalogPath = join(EXPORT_DIR, 'catalog.normalized.json');
const realCatalog = existsSync(realCatalogPath) ? JSON.parse(readFileSync(realCatalogPath, 'utf8')) : null;

// ---------- Catálogo sintético ----------
function synthetic(groups = 3) {
  const products = Array.from({ length: groups }, (_, i) => {
    const gid = `UP-P-${String(i + 1).padStart(4, '0')}`;
    const variants = [1, 2].map((n) => ({
      id: `${gid}-V0${n}`,
      legacyShopifyId: 5000 + i * 10 + n,
      sku: n === 1 ? `SKU-${i + 1}` : '',
      title: n === 1 ? 'Dorado' : 'Plateado',
      options: [{ name: 'Color', value: n === 1 ? 'Dorado' : 'Plateado' }],
      price: 100 * (i + 1) + n,
      compareAtPrice: null,
      currency: 'DOP',
      imageId: n === 1 ? `${gid}-I01` : null,
      status: 'active',
    }));
    return {
      id: gid,
      legacyShopifyId: 900 + i,
      slug: `producto-${i + 1}`,
      name: `Producto ${i + 1}`,
      description: 'd',
      descriptionHtml: '<p>d</p>',
      category: 'Cadenas',
      options: [{ name: 'Color', values: ['Dorado', 'Plateado'] }],
      personalizationOptions: null,
      currency: 'DOP',
      status: 'active',
      images: [{ id: `${gid}-I01`, src: `/catalog/products/${gid}/a.webp`, width: 10, height: 10, sha256: 'ab', alt: null, legacyShopifyId: 1, legacySourceUrl: null, variantIds: [`${gid}-V01`] }],
      variants,
    };
  });
  return { meta: { currency: 'DOP', productCount: groups, variantCount: groups * 2 }, products };
}
const small = { expectedGroups: 3, expectedVariants: 6 };

// ---------- Almacén en memoria con las mismas restricciones únicas que el esquema ----------
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class FakeStore implements ImportStore {
  tenants = new Map([['unique-personalizado', 'tenant-1']]);
  webProducts: Row[] = [];
  products: Row[] = [];
  inventoryMovements: Row[] = [];
  inventorySyncJobs: Row[] = [];
  writes = 0;
  failAfterProducts = false;
  private seq = 0;
  async findTenantId(slug: string) {
    return this.tenants.get(slug) ?? null;
  }
  async countInventorySyncJobs() {
    return this.inventorySyncJobs.length;
  }
  async loadExisting(tenantId: string): Promise<ExistingState> {
    const state: ExistingState = { webProducts: new Map(), slugOwners: new Map(), products: new Map(), skuOwners: new Map() };
    for (const w of this.webProducts.filter((r) => r.tenantId === tenantId)) {
      state.webProducts.set(w.legacyEcommerceId, { id: w.id, importSourceSha256: w.importSourceSha256 });
      state.slugOwners.set(w.slug, w.legacyEcommerceId);
    }
    for (const p of this.products.filter((r) => r.tenantId === tenantId)) {
      if (p.legacyEcommerceVariantId) state.products.set(p.legacyEcommerceVariantId, { id: p.id, sku: p.sku, price: p.price, webProductId: p.webProductId });
      if (p.sku) state.skuOwners.set(p.sku, p.legacyEcommerceVariantId ?? null);
    }
    return state;
  }
  async transaction<T>(work: (tx: any) => Promise<T>): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const snapshot = { w: [...this.webProducts], p: [...this.products] };
    const tx = {
      createWebProduct: async (data: WebProductCreate) => {
        if (this.webProducts.some((r) => r.tenantId === data.tenantId && (r.legacyEcommerceId === data.legacyEcommerceId || r.slug === data.slug))) throw new Error('unique WebProduct');
        const row = { ...data, id: `w${++this.seq}` };
        this.webProducts.push(row);
        this.writes += 1;
        return { id: row.id };
      },
      createProducts: async (rows: ProductCreate[]) => {
        for (const data of rows) {
          if (this.products.some((r) => r.tenantId === data.tenantId && (r.sku === data.sku || r.legacyEcommerceVariantId === data.legacyEcommerceVariantId))) throw new Error('unique Product');
          if (!this.webProducts.some((w) => w.id === data.webProductId && w.tenantId === data.tenantId)) throw new Error('FK webProduct');
          this.products.push({ ...data, id: `p${++this.seq}` });
          this.writes += 1;
        }
        if (this.failAfterProducts) throw new Error('fallo inyectado');
      },
      countInventorySyncJobs: async () => this.inventorySyncJobs.length,
    };
    try {
      return await work(tx);
    } catch (error) {
      this.webProducts = snapshot.w;
      this.products = snapshot.p;
      throw error;
    }
  }
}
const run = (plan: ReturnType<typeof buildPlan>, store?: FakeStore, mode: 'dry-run' | 'isolated' = 'isolated') =>
  runImport(plan, { mode, tenantSlug: 'unique-personalizado', sourceSha256: 'src', store });

// ---------- Política de SKUs ----------
test('SKUs: reglas, determinismo y detección de colisiones después de generar', () => {
  assert.equal(normalizeSku(' a-pin_beis 1p '), 'A-PIN-BEIS-1P');
  const rows = [
    { variantId: 'UP-P-0040-V02', groupId: 'UP-P-0040', legacyVariantId: '1', originalSku: null },
    { variantId: 'UP-P-0040-V03', groupId: 'UP-P-0040', legacyVariantId: '2', originalSku: 'A-CA-NG13' },
    { variantId: 'UP-P-0041-V01', groupId: 'UP-P-0041', legacyVariantId: '3', originalSku: 'A-CA-NG13' },
    { variantId: 'UP-P-0042-V01', groupId: 'UP-P-0042', legacyVariantId: '4', originalSku: 'a_b' },
    { variantId: 'UP-P-0043-V01', groupId: 'UP-P-0043', legacyVariantId: '5', originalSku: 'OK-1' },
  ];
  const mapping = resolveSkus(rows);
  assert.deepEqual(mapping.map((m) => [m.candidateSku, m.rule]), [
    ['UP-0040-02', 'GENERATED_FOR_MISSING'],
    ['A-CA-NG13-0040', 'DISAMBIGUATED_DUPLICATE'],
    ['A-CA-NG13-0041', 'DISAMBIGUATED_DUPLICATE'],
    ['A-B', 'NORMALIZED'],
    ['OK-1', 'UNCHANGED'],
  ]);
  assert.ok(mapping.every((m) => m.approvedForRealDatabase === false && m.originalSku === rows.find((r) => r.variantId === m.variantId)!.originalSku));
  assert.deepEqual(resolveSkus(rows), mapping);
  assert.deepEqual(detectSkuCollisions(mapping), []);
  assert.equal(detectSkuCollisions(mapping, new Map([['OK-1', 'otra-variante']]))[0].reason, 'EXISTS_IN_TARGET_FOR_OTHER_VARIANT');
  assert.deepEqual(detectSkuCollisions(mapping, new Map([['OK-1', 'UP-P-0043-V01']])), [], 'el mismo dueño es un reintento, no una colisión');
  const forced = resolveSkus([...rows, { variantId: 'UP-P-0099-V01', groupId: 'UP-P-0099', legacyVariantId: '9', originalSku: 'UP-0040-02' }]);
  assert.equal(detectSkuCollisions(forced).filter((c) => c.reason === 'DUPLICATE_CANDIDATE').length, 2, 'un candidato generado que choca con un SKU vigente se detecta');
});

// ---------- Catálogo real (si está disponible) ----------
test('catálogo real: 174 grupos, 312 variantes, SKUs 122/162/20/8 sin colisiones, precios intactos', { skip: realCatalog ? false : 'catálogo del e-commerce no disponible' }, () => {
  const before = JSON.stringify(realCatalog);
  const plan = buildPlan(realCatalog);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.groups.length, 174);
  assert.equal(plan.products.length, 312);
  assert.deepEqual(plan.skuSummary, { UNCHANGED: 122, GENERATED_FOR_MISSING: 162, DISAMBIGUATED_DUPLICATE: 20, NORMALIZED: 8 });
  assert.deepEqual(detectSkuCollisions(plan.skuMapping), []);
  assert.equal(new Set(plan.products.map((p) => p.sku)).size, 312);
  const source = new Map<string, any>(realCatalog.products.flatMap((g: any) => g.variants.map((v: any) => [v.id, v]))); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const p of plan.products) {
    const v = source.get(p.legacyEcommerceVariantId);
    assert.equal(Number(p.price), v.price, `precio intacto ${p.legacyEcommerceVariantId}`);
    assert.equal(p.originalSku, v.sku || null, 'SKU original conservado');
  }
  assert.equal(plan.products.filter((p) => p.webOptions.compareAtPrice !== null).length, 2);
  assert.equal(plan.groups.reduce((n, g) => n + g.imageManifest.length, 0), 780, 'manifiesto completo de imágenes');
  assert.equal(JSON.stringify(realCatalog), before, 'el catálogo de entrada no se modifica');
  assert.deepEqual(buildPlan(realCatalog), plan, 'determinista');
});

test('catálogo real: el mapping coincide con sku-proposal.csv del e-commerce', { skip: existsSync(join(EXPORT_DIR, 'sku-proposal.csv')) && realCatalog ? false : 'propuesta no disponible' }, () => {
  const csv = readFileSync(join(EXPORT_DIR, 'sku-proposal.csv'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const proposals = new Map(csv.slice(1).map((line) => {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    return [cells[0], cells[5]] as const;
  }));
  const plan = buildPlan(realCatalog);
  const changed = plan.skuMapping.filter((m) => m.rule !== 'UNCHANGED');
  assert.equal(changed.length, proposals.size);
  for (const m of changed) assert.equal(m.candidateSku, proposals.get(m.variantId), m.variantId);
});

// ---------- Validación ----------
test('validación: conteos, relaciones, precios y rutas inseguras fallan sin redondear', () => {
  assert.deepEqual(buildPlan(synthetic(), small).errors, []);
  assert.ok(buildPlan(synthetic(2)).errors.some((e) => e.includes('174')), 'conteo distinto de 174');
  assert.throws(() => money('10.123'));
  assert.throws(() => money('1e3'));
  assert.equal(money(950), '950.00');
  assert.equal(money('1599.5'), '1599.50');

  const badPrice = synthetic(); badPrice.products[0].variants[0].price = 10.123;
  assert.ok(buildPlan(badPrice, small).errors.some((e) => e.includes('inválido')));
  const brokenImage = synthetic(); brokenImage.products[1].variants[0].imageId = 'UP-P-0002-I99';
  assert.ok(buildPlan(brokenImage, small).errors.some((e) => e.includes('imagen inexistente')));
  const unsafe = synthetic(); unsafe.products[0].images[0].src = '/catalog/../secret.png';
  assert.ok(buildPlan(unsafe, small).errors.some((e) => e.includes('no segura')));
  const dupSlug = synthetic(); dupSlug.products[1].slug = dupSlug.products[0].slug;
  assert.ok(buildPlan(dupSlug, small).errors.some((e) => e.includes('slug duplicado')));
  const badOption = synthetic(); badOption.products[0].variants[0].options = [{ name: 'Color', value: 'Verde' }];
  assert.ok(buildPlan(badOption, small).errors.some((e) => e.includes('opción no declarada')));
  const dupLegacy = synthetic(); dupLegacy.products[1].variants[0].legacyShopifyId = dupLegacy.products[0].variants[0].legacyShopifyId;
  assert.ok(buildPlan(dupLegacy, small).errors.some((e) => e.includes('ID histórico de variante duplicado')));
  const foreignVariant = synthetic(); foreignVariant.products[0].images[0].variantIds = ['UP-P-0002-V01'];
  assert.ok(buildPlan(foreignVariant, small).errors.some((e) => e.includes('no son del grupo')));
});

test('entrada inválida: no hay escrituras y el estado es INVALID_INPUT', async () => {
  const store = new FakeStore();
  const report = await run(buildPlan(synthetic(2), small), store);
  assert.equal(report.status, 'INVALID_INPUT');
  assert.equal(store.writes, 0);
});

// ---------- Importación ----------
test('dry-run no abre almacén ni escribe; con almacén solo lee', async () => {
  const plan = buildPlan(synthetic(), small);
  const sinAlmacen = await run(plan, undefined, 'dry-run');
  assert.equal(sinAlmacen.status, 'DRY_RUN_OK');
  assert.deepEqual([sinAlmacen.groups.create, sinAlmacen.variants.create], [3, 6]);
  const store = new FakeStore();
  const conAlmacen = await run(plan, store, 'dry-run');
  assert.equal(conAlmacen.status, 'DRY_RUN_OK');
  assert.equal(store.writes, 0);
  await assert.rejects(() => run(plan, undefined, 'isolated'), /almacén/);
});

test('importación aislada: relaciones, valores técnicos, sin publicar, sin stock, sin movimientos ni Shopify', async () => {
  const store = new FakeStore();
  const plan = buildPlan(synthetic(), small);
  const report = await run(plan, store);
  assert.equal(report.status, 'APPLIED');
  assert.equal(store.webProducts.length, 3);
  assert.equal(store.products.length, 6);
  assert.ok(store.webProducts.every((w) => w.published === false && w.tenantId === 'tenant-1' && w.legacyShopifyProductId));
  for (const p of store.products) {
    assert.equal(p.status, 'INACTIVE');
    assert.equal(p.stock, 0);
    assert.equal(p.reservedStock, 0);
    assert.equal(p.webAvailability, 'UNDECIDED');
    assert.ok(store.webProducts.some((w) => w.id === p.webProductId));
    assert.equal(p.shopifyVariantId, undefined);
    assert.equal(p.shopifyProductId, undefined);
    assert.ok(p.legacyShopifyVariantId && p.legacyEcommerceVariantId);
    assert.equal(p.taxRate, undefined, 'la política fiscal no se toca');
    assert.equal(p.salePrice, undefined);
  }
  assert.equal(store.inventoryMovements.length, 0);
  assert.equal(store.inventorySyncJobs.length, 0);
  assert.deepEqual(report.safety, { shopifyCalls: 0, inventoryMovementsCreated: 0, inventorySyncJobsDelta: 0, priceTransformations: 0, groupsPublished: 0, unitsCopied: 0 });
  assert.equal(store.products.find((p) => p.legacyEcommerceVariantId === 'UP-P-0002-V01')!.price, '201.00');
  assert.equal(store.webProducts[0].imageManifest.length, 1);
});

test('idempotente: repetir no duplica; un fallo a mitad revierte todo y el reintento funciona', async () => {
  const store = new FakeStore();
  const plan = buildPlan(synthetic(), small);
  store.failAfterProducts = true;
  const failed = await run(plan, store);
  assert.equal(failed.status, 'FAILED');
  assert.equal(store.webProducts.length + store.products.length, 0, 'rollback completo');
  store.failAfterProducts = false;
  assert.equal((await run(plan, store)).status, 'APPLIED');
  const again = await run(plan, store);
  assert.equal(again.status, 'NO_CHANGES');
  assert.deepEqual([again.groups.unchanged, again.variants.unchanged], [3, 6]);
  assert.equal(store.products.length, 6);
  assert.equal(store.webProducts.length, 3);
});

test('conflictos: SKU ajeno, contenido distinto y slug tomado abortan sin escribir', async () => {
  const plan = buildPlan(synthetic(), small);

  const skuTaken = new FakeStore();
  skuTaken.products.push({ id: 'old', tenantId: 'tenant-1', sku: 'SKU-1', legacyEcommerceVariantId: null, price: '1.00', webProductId: null });
  const r1 = await run(plan, skuTaken);
  assert.equal(r1.status, 'ABORTED_CONFLICTS');
  assert.ok(r1.conflicts.some((c) => c.reason.includes('SKU_EXISTS_IN_TARGET_FOR_OTHER_VARIANT')));
  assert.equal(skuTaken.writes, 0);

  const slugTaken = new FakeStore();
  slugTaken.webProducts.push({ id: 'old', tenantId: 'tenant-1', legacyEcommerceId: 'OTRO', slug: 'producto-1', importSourceSha256: 'x' });
  assert.ok((await run(plan, slugTaken)).conflicts.some((c) => c.reason.startsWith('SLUG_TAKEN')));

  const changed = new FakeStore();
  await run(plan, changed);
  const mutated = synthetic(); mutated.products[0].name = 'Nombre cambiado';
  const r3 = await run(buildPlan(mutated, small), changed);
  assert.equal(r3.status, 'ABORTED_CONFLICTS');
  assert.ok(r3.conflicts.some((c) => c.reason === 'EXISTS_WITH_DIFFERENT_CONTENT'));

  const priceChanged = new FakeStore();
  await run(plan, priceChanged);
  priceChanged.products[0].price = '999.00';
  assert.equal((await run(plan, priceChanged)).status, 'ABORTED_CONFLICTS', 'un precio distinto en el destino no se sobrescribe');

  const noTenant = new FakeStore();
  noTenant.tenants.clear();
  assert.equal((await run(plan, noTenant)).status, 'FAILED');
});

test('si aparecen InventorySyncJob durante la importación, se revierte', async () => {
  const store = new FakeStore();
  const original = store.transaction.bind(store);
  store.transaction = (async (work: any) => original(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const patched = { ...tx, createProducts: async (rows: ProductCreate[]) => { await tx.createProducts(rows); store.inventorySyncJobs.push({ id: 'j1' }); } };
    return work(patched);
  })) as typeof store.transaction;
  const report = await run(buildPlan(synthetic(), small), store);
  assert.equal(report.status, 'FAILED');
  assert.match(report.errors.join(' '), /InventorySyncJob/);
  assert.equal(store.products.length, 0);
});

// ---------- Guardas de seguridad ----------
test('guard: solo acepta una base local de prueba con confirmación explícita', () => {
  const ok = { DATABASE_URL: 'postgresql://u:p@localhost:5432/unique_test', WEB_CATALOG_IMPORT_ISOLATED: ISOLATED_CONFIRMATION };
  assert.equal(assertIsolatedTarget(ok), ok.DATABASE_URL);
  const bad = (env: Record<string, string | undefined>, pattern: RegExp) => assert.throws(() => assertIsolatedTarget({ ...ok, ...env }), pattern);
  bad({ WEB_CATALOG_IMPORT_ISOLATED: undefined }, /WEB_CATALOG_IMPORT_ISOLATED/);
  bad({ DATABASE_URL: undefined }, /DATABASE_URL no está definida/);
  bad({ DATABASE_URL: 'postgresql://u:p@db.abcd.supabase.co:5432/postgres' }, /servicio gestionado/);
  bad({ DATABASE_URL: 'postgresql://u:p@aws-0-us.pooler.supabase.com:6543/postgres' }, /host debe ser localhost/);
  bad({ DATABASE_URL: 'postgresql://u:p@10.0.0.5:5432/unique_test' }, /localhost/);
  bad({ DATABASE_URL: 'postgresql://u:p@localhost:5432/postgres' }, /nombre de la base/);
  bad({ DATABASE_URL: 'postgresql://u:p@localhost:5432/unique_personalizado' }, /nombre de la base/);
  bad({ DIRECT_URL: 'postgresql://u:p@db.x.supabase.co:5432/test' }, /DIRECT_URL/);
  bad({ DATABASE_URL: 'mysql://u:p@localhost/test' }, /PostgreSQL/);
  bad({ DATABASE_URL: 'esto no es una url' }, /URL válida/);
});

// ---------- Análisis estático ----------
test('el código del importador no puede alcanzar Shopify, servicios del API ni la cola de inventario', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const raw = readFileSync(join(here, file), 'utf8');
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/apps\/api|ProductsService|ShopifyService|syncProduct|https?:\/\/|fetch\(|axios/.test(source), `${file}: referencia prohibida`);
    assert.ok(!/inventorySyncJob\.(create|update|upsert|delete)/i.test(source), `${file}: escribe InventorySyncJob`);
    assert.ok(!/inventoryMovement\./.test(source), `${file}: escribe movimientos de inventario`);
    assert.ok(!/dotenv|["'`]\.env/.test(source), `${file}: lee .env`);
    assert.ok(!/\b(prisma|tx)\.\w+\.(update|upsert|delete|deleteMany|updateMany)\(/.test(source), `${file}: modifica o borra registros`);
  }
});

test('la migración es solo aditiva y no toca facturas, órdenes ni inventario', () => {
  const dir = resolve(here, '../../prisma/migrations');
  const migration = readdirSync(dir).filter((d) => d.endsWith('_web_catalog_grouping'));
  assert.equal(migration.length, 1);
  const sql = readFileSync(join(dir, migration[0], 'migration.sql'), 'utf8');
  const statements = sql.replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE|SET NULL)/g, '');
  assert.ok(!/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b|ALTER COLUMN|SET NOT NULL|\bINSERT\b/i.test(statements), 'sin sentencias destructivas ni de datos');
  const touched = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(touched)].sort(), ['Product', 'WebProduct']);
  assert.ok(!/Invoice|SalesOrder|InventoryMovement|InventorySyncJob|ReturnRequest/.test(sql));
  assert.ok(!/stock/i.test(sql.match(/CREATE TABLE "WebProduct"[\s\S]*?\);/)![0]), 'WebProduct no tiene existencias');
});

test('aprobación de SKU: solo los SKU originales sin cambio nacen aprobados; los candidatos quedan pendientes', async () => {
  const store = new FakeStore();
  assert.equal((await run(buildPlan(synthetic(), small), store)).status, 'APPLIED');
  const withOriginal = store.products.filter((p) => p.originalSku);
  const generated = store.products.filter((p) => !p.originalSku);
  assert.ok(withOriginal.length === 3 && withOriginal.every((p) => p.skuApprovedAt instanceof Date));
  assert.ok(generated.length === 3 && generated.every((p) => p.skuApprovedAt === null));
});

test('todas las migraciones de la integración son aditivas y no tocan datos históricos', () => {
  const dir = resolve(here, '../../prisma/migrations');
  const names = readdirSync(dir).filter((d) => /_(web_catalog_grouping|channel_nonce|web_catalog_sku_approval)$/.test(d));
  assert.equal(names.length, 3);
  for (const name of names) {
    const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8').replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE|SET NULL)/g, '');
    assert.ok(!/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|INSERT)\b|ALTER COLUMN|SET NOT NULL/i.test(sql), `${name}: sentencia no aditiva`);
    assert.ok(!/Invoice|SalesOrder|InventoryMovement|InventorySyncJob|ReturnRequest/.test(sql), `${name}: toca tablas históricas`);
  }
});

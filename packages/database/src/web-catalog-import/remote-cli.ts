// Importación única y controlada contra el proyecto Supabase autorizado (ver remote-guard.ts).
//   dotenv -e ../../.env -- tsx src/web-catalog-import/remote-cli.ts --catalog=<json> --backup=<dump> [--apply]
// Sin --apply hace preflight + comparación en solo lectura. Con --apply escribe WebProduct y Product en una
// transacción. Nunca toca órdenes, facturas, inventario ni productos existentes: lo comprueba antes y después.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '../../generated/client';
import { runImport } from './importer';
import { buildPlan } from './plan';
import { createPrismaStore } from './prisma-store';
import { assertAuthorizedRemoteTarget, REQUIRED_MIGRATIONS } from './remote-guard';

function arg(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

// Tablas operativas que la importación no puede alterar.
const PROTECTED_TABLES = [
  'SalesOrder', 'SalesOrderItem', 'Invoice', 'InvoiceItem', 'Payment', 'InventoryMovement', 'InventorySyncJob',
  'CashSession', 'CashMovement', 'ElectronicDocument', 'Customer', 'User', 'Membership', 'ShopifyEvent',
] as const;

async function snapshot(prisma: PrismaClient, tenantSlug: string) {
  const counts: Record<string, number> = {};
  for (const table of PROTECTED_TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(`select count(*) c from "${table}"`);
    counts[table] = Number(rows[0].c);
  }
  const legacy = await prisma.$queryRawUnsafe<{ fingerprint: string; products: bigint }[]>(
    `select md5(coalesce(string_agg(concat_ws('|', p.id, p.sku, p.price::text, p.stock::text, p."reservedStock"::text, p.status::text, p."shopifyProductId", p."shopifyVariantId", p."updatedAt"::text), ';' order by p.id), '')) fingerprint, count(*) products
     from "Product" p join "Tenant" t on t.id = p."tenantId" where p."webProductId" is null and t.slug = $1`,
    tenantSlug,
  );
  const syncJobs = await prisma.$queryRawUnsafe<{ fingerprint: string }[]>(
    `select md5(coalesce(string_agg(concat_ws('|', id, "productId", revision::text, attempts::text, pending::text, error), ';' order by id), '')) fingerprint from "InventorySyncJob"`,
  );
  const web = await prisma.$queryRawUnsafe<{ wp: bigint; pv: bigint }[]>(
    `select (select count(*) from "WebProduct") wp, (select count(*) from "Product" where "webProductId" is not null) pv`,
  );
  return {
    counts,
    legacyProducts: Number(legacy[0].products),
    legacyProductsFingerprint: legacy[0].fingerprint,
    syncJobsFingerprint: syncJobs[0].fingerprint,
    webProducts: Number(web[0].wp),
    webVariants: Number(web[0].pv),
  };
}

async function main() {
  const catalogPath = arg('--catalog');
  const tenantSlug = arg('--tenant') ?? 'hotel-ancla';
  const apply = process.argv.includes('--apply');
  if (!catalogPath) throw new Error('Uso: remote-cli.ts --catalog=<json> --backup=<dump> [--tenant=slug] [--apply] [--out=dir]');
  const outDir = resolve(arg('--out') ?? '.tmp/web-catalog-import');

  // Bloquea un posible disparo hacia Shopify desde cualquier código cargado en este proceso.
  process.env.SHOPIFY_SYNC_DISABLED = 'true';
  const target = assertAuthorizedRemoteTarget(process.env, tenantSlug, arg('--backup') ? resolve(arg('--backup') as string) : undefined);

  const raw = readFileSync(resolve(catalogPath));
  const sourceSha256 = createHash('sha256').update(raw).digest('hex');
  const plan = buildPlan(JSON.parse(raw.toString('utf8')));

  const prisma = new PrismaClient({ datasources: { db: { url: target.url } } });
  const store = createPrismaStore(target.url);
  const startedAt = new Date().toISOString();
  try {
    // Preflight
    const applied = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      `select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null`,
    );
    const names = new Set(applied.map((r) => r.migration_name));
    const missing = REQUIRED_MIGRATIONS.filter((m) => !names.has(m));
    if (missing.length) throw new Error(`Preflight: faltan migraciones ${missing.join(', ')}`);

    const before = await snapshot(prisma, tenantSlug);
    const report = await runImport(plan, { mode: apply ? 'remote-authorized' : 'dry-run', tenantSlug, sourceSha256, store });
    const after = apply ? await snapshot(prisma, tenantSlug) : before;

    const violations: string[] = [];
    for (const table of PROTECTED_TABLES) if (before.counts[table] !== after.counts[table]) violations.push(`${table}: ${before.counts[table]} -> ${after.counts[table]}`);
    if (before.legacyProductsFingerprint !== after.legacyProductsFingerprint) violations.push('productos existentes modificados');
    if (before.syncJobsFingerprint !== after.syncJobsFingerprint) violations.push('InventorySyncJob modificados');

    const { actions: _actions, ...summary } = report;
    void _actions;
    const record = {
      startedAt,
      finishedAt: new Date().toISOString(),
      apply,
      backup: { path: target.backupPath, sha256: target.backupSha256, bytes: target.backupBytes },
      migrationsVerified: REQUIRED_MIGRATIONS,
      before,
      after,
      violations,
      ...summary,
    };
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `remote-import-${apply ? 'apply' : 'preflight'}-${startedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ status: report.status, groups: report.groups, variants: report.variants, sku: report.sku, violations, before: before.counts, after: after.counts, webProducts: [before.webProducts, after.webProducts], webVariants: [before.webVariants, after.webVariants], safety: report.safety }, null, 2));
    console.log(`Registro: ${file}`);
    if (violations.length) throw new Error(`Se detectaron cambios en datos protegidos: ${violations.join('; ')}`);
    process.exitCode = ['DRY_RUN_OK', 'NO_CHANGES', 'APPLIED'].includes(report.status) ? 0 : 1;
  } finally {
    await store.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// Importador del catálogo web. Por defecto es dry-run: no abre ninguna conexión ni lee ningún .env.
//   pnpm --filter @qorvex/database import:web-catalog -- --catalog=<catalog.normalized.json> [--tenant=unique-personalizado]
// Modo aislado (solo base local de prueba, ver guard.ts):
//   ... --mode=isolated      con DATABASE_URL y WEB_CATALOG_IMPORT_ISOLATED definidos en el entorno
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertIsolatedTarget } from './guard';
import { runImport, type ImportMode, type ImportStore } from './importer';
import { buildPlan } from './plan';

function arg(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const catalogPath = arg('--catalog');
  if (!catalogPath) {
    console.error('Uso: import:web-catalog -- --catalog=<catalog.normalized.json> [--tenant=slug] [--mode=dry-run|isolated] [--out=dir]');
    process.exit(2);
  }
  const mode = (arg('--mode') ?? 'dry-run') as ImportMode;
  if (mode !== 'dry-run' && mode !== 'isolated') throw new Error(`Modo desconocido: ${mode}`);
  const tenantSlug = arg('--tenant') ?? 'unique-personalizado';
  const outDir = resolve(arg('--out') ?? '.tmp/web-catalog-import');

  const raw = readFileSync(resolve(catalogPath));
  const sourceSha256 = createHash('sha256').update(raw).digest('hex');
  const plan = buildPlan(JSON.parse(raw.toString('utf8')));

  let store: (ImportStore & { disconnect(): Promise<void> }) | undefined;
  if (mode === 'isolated') {
    const url = assertIsolatedTarget(process.env);
    const { createPrismaStore } = await import('./prisma-store');
    store = createPrismaStore(url);
  }
  try {
    const report = await runImport(plan, { mode, tenantSlug, sourceSha256, store });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'import-report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, 'sku-mapping.json'), JSON.stringify(plan.skuMapping, null, 2));
    const { actions: _actions, ...summary } = report;
    void _actions;
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Informe: ${join(outDir, 'import-report.json')}`);
    process.exitCode = ['DRY_RUN_OK', 'NO_CHANGES', 'APPLIED'].includes(report.status) ? 0 : 1;
  } finally {
    await store?.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

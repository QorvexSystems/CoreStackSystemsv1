// Genera src/modules/web-catalog/web-collections.data.ts a partir del catalogo del e-commerce.
//   node scripts/generate-web-collections.mjs <ruta/a/catalog.json>
// Las colecciones se relacionan con WebProduct.legacyEcommerceId (UP-P-xxxx), nunca por nombre.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
  console.error('Uso: node scripts/generate-web-collections.mjs <catalog.json>');
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(resolve(source), 'utf8'));
const productIds = new Set(catalog.products.map((p) => p.id));
const collections = catalog.collections
  .map((c) => ({
    handle: String(c.handle),
    title: String(c.title),
    groupIds: [...new Set(c.productIds.filter((id) => productIds.has(id)))].sort(),
  }))
  .filter((c) => c.groupIds.length > 0)
  .sort((a, b) => a.title.localeCompare(b.title, 'es'));

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/modules/web-catalog/web-collections.data.ts');
const body = `// GENERADO por scripts/generate-web-collections.mjs desde el catalogo del e-commerce. No editar a mano.
// Cada coleccion lista los grupos web (WebProduct.legacyEcommerceId) que pertenecen a ella.
export type WebCollectionDefinition = { handle: string; title: string; groupIds: string[] };

export const WEB_COLLECTIONS: WebCollectionDefinition[] = ${JSON.stringify(collections, null, 2)};
`;
writeFileSync(out, body);
console.log(`${collections.length} colecciones, ${collections.reduce((n, c) => n + c.groupIds.length, 0)} relaciones -> ${out}`);

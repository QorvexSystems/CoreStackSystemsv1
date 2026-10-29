// Planificación pura del importador: valida el catálogo ya normalizado y calcula, sin tocar ninguna base,
// los registros WebProduct (grupo) y Product (variante) que se crearían. No hay red, ni Prisma, ni Shopify.
import { createHash } from 'node:crypto';
import { resolveSkus, type SkuMappingEntry } from './sku-policy';

export const EXPECTED_GROUPS = 174;
export const EXPECTED_VARIANTS = 312;
const PUBLICATION_STATUSES = ['active', 'draft', 'archived', 'inactive'];

export type PlanOptions = { expectedGroups?: number; expectedVariants?: number };

export type ImageReference = {
  id: string;
  position: number;
  src: string;
  width: number | null;
  height: number | null;
  sha256: string | null;
  alt: string | null;
  legacyShopifyId: string | null;
  legacySourceUrl: string | null;
  variantIds: string[];
};

export type WebProductPlan = {
  legacyEcommerceId: string;
  legacyShopifyProductId: string;
  slug: string;
  name: string;
  description: string | null;
  descriptionHtml: string | null;
  categoryLabel: string | null;
  options: unknown;
  personalizationOptions: unknown;
  imageManifest: ImageReference[];
  publicationIntent: string;
  importSourceSha256: string;
  variantIds: string[];
};

export type ProductPlan = {
  legacyEcommerceVariantId: string;
  groupLegacyId: string;
  legacyShopifyVariantId: string;
  name: string;
  sku: string;
  originalSku: string | null;
  /** Precio del e-commerce tal cual, como decimal de 2 posiciones. Nunca se suma ni se descuenta ITBIS. */
  price: string;
  webOptions: { title: string; options: unknown; compareAtPrice: string | null; primaryImageId: string | null };
  skuRule: SkuMappingEntry['rule'];
};

export type ImportPlan = {
  errors: string[];
  warnings: string[];
  groups: WebProductPlan[];
  products: ProductPlan[];
  skuMapping: SkuMappingEntry[];
  skuSummary: Record<SkuMappingEntry['rule'], number>;
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Rechaza en lugar de redondear: un decimal perdido es un precio distinto al del e-commerce. */
export function money(value: unknown): string {
  const text = String(value);
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text)) throw new Error(`Valor monetario inválido: ${text}`);
  const [whole, fraction = ''] = text.split('.');
  if (BigInt(whole) >= 10_000_000_000n) throw new Error('El precio excede Decimal(12,2)');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function historicalId(value: unknown): string {
  const ok = typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
  if (!ok || !/^\d+$/.test(String(value))) throw new Error(`ID histórico inválido: ${String(value)}`);
  return String(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Json)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const byId = (a: Json, b: Json) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

function checkUnique(errors: string[], values: string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} duplicado: ${value}`);
    seen.add(value);
  }
}

export function buildPlan(catalog: unknown, options: PlanOptions = {}): ImportPlan {
  const expectedGroups = options.expectedGroups ?? EXPECTED_GROUPS;
  const expectedVariants = options.expectedVariants ?? EXPECTED_VARIANTS;
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = (catalog ?? {}) as Json;
  const rawGroups: Json[] = Array.isArray(root.products) ? [...root.products].sort(byId) : [];
  const empty: ImportPlan = {
    errors,
    warnings,
    groups: [],
    products: [],
    skuMapping: [],
    skuSummary: { UNCHANGED: 0, GENERATED_FOR_MISSING: 0, DISAMBIGUATED_DUPLICATE: 0, NORMALIZED: 0 },
  };
  if (root.meta?.currency !== 'DOP') errors.push('Se esperaba un catálogo en DOP');
  if (rawGroups.length === 0) {
    errors.push('Catálogo vacío');
    return empty;
  }

  const variantCount = rawGroups.reduce((n, g) => n + (Array.isArray(g.variants) ? g.variants.length : 0), 0);
  if (rawGroups.length !== expectedGroups) errors.push(`Grupos: se esperaban ${expectedGroups} y hay ${rawGroups.length}`);
  if (variantCount !== expectedVariants) errors.push(`Variantes: se esperaban ${expectedVariants} y hay ${variantCount}`);
  if (root.meta?.productCount !== rawGroups.length || root.meta?.variantCount !== variantCount) {
    errors.push('Los conteos de meta no coinciden con el contenido');
  }

  const groups: WebProductPlan[] = [];
  const products: ProductPlan[] = [];
  const skuInputs: { variantId: string; groupId: string; legacyVariantId: string; originalSku: string | null }[] = [];
  const guard = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`);
    }
  };

  for (const g of rawGroups) {
    const gid = String(g.id);
    guard(gid, () => {
      if (typeof g.name !== 'string' || !g.name.trim()) throw new Error('nombre ausente');
      if (typeof g.slug !== 'string' || !g.slug.trim()) throw new Error('slug ausente');
      if (g.currency !== 'DOP') throw new Error('moneda distinta de DOP');
      if (!PUBLICATION_STATUSES.includes(g.status)) throw new Error(`estado de publicación desconocido: ${g.status}`);
      if (!Array.isArray(g.variants) || g.variants.length === 0) throw new Error('grupo sin variantes');
      if (!Array.isArray(g.images) || !Array.isArray(g.options)) throw new Error('grupo incompleto (images/options)');

      const variants: Json[] = [...g.variants].sort(byId);
      const variantIds = new Set(variants.map((v) => String(v.id)));
      const imageIds = new Set((g.images as Json[]).map((i) => String(i.id)));
      for (const v of variants) {
        if (!String(v.id).startsWith(`${gid}-V`)) throw new Error(`la variante ${v.id} no pertenece al grupo`);
        if (v.imageId && !imageIds.has(String(v.imageId))) throw new Error(`variante ${v.id} apunta a una imagen inexistente`);
      }
      const imageManifest: ImageReference[] = (g.images as Json[]).map((image, position) => {
        if (!Array.isArray(image.variantIds) || !image.variantIds.every((id: string) => variantIds.has(id))) {
          throw new Error(`la imagen ${image.id} referencia variantes que no son del grupo`);
        }
        const src = String(image.src ?? '');
        if (!/^\/catalog\//.test(src) || src.includes('..') || src.includes('\\')) throw new Error(`ruta de imagen no segura: ${src}`);
        return {
          id: String(image.id),
          position,
          src,
          width: image.width ?? null,
          height: image.height ?? null,
          sha256: image.sha256 ?? null,
          alt: image.alt ?? null,
          legacyShopifyId: image.legacyShopifyId == null ? null : String(image.legacyShopifyId),
          legacySourceUrl: image.legacySourceUrl ?? null,
          variantIds: [...image.variantIds].sort(),
        };
      });

      const payload = {
        legacyEcommerceId: gid,
        legacyShopifyProductId: historicalId(g.legacyShopifyId),
        slug: g.slug,
        name: g.name,
        description: g.description ?? null,
        descriptionHtml: g.descriptionHtml ?? null,
        categoryLabel: g.category ?? null,
        options: g.options,
        personalizationOptions: g.personalizationOptions ?? null,
        imageManifest,
        publicationIntent: g.status,
        variantIds: [...variantIds].sort(),
      };
      groups.push({ ...payload, importSourceSha256: sha256(canonicalJson(payload)) });
      if (!g.category) warnings.push(`${gid}: CATEGORY_UNASSIGNED`);

      for (const v of variants) {
        guard(String(v.id), () => {
          if (v.currency !== 'DOP') throw new Error('moneda distinta de DOP');
          if (!PUBLICATION_STATUSES.includes(v.status)) throw new Error(`estado desconocido: ${v.status}`);
          if (!Array.isArray(v.options)) throw new Error('opciones ausentes');
          for (const o of v.options as Json[]) {
            const declared = (g.options as Json[]).some((po) => po.name === o.name && po.values?.includes(o.value));
            if (!declared) throw new Error(`opción no declarada en el grupo: ${o.name}=${o.value}`);
          }
          const price = money(v.price);
          const compareAtPrice = v.compareAtPrice == null ? null : money(v.compareAtPrice);
          const single = variants.length === 1 && v.title === 'Default Title';
          const name = single ? g.name : `${g.name} - ${v.title}`;
          if (name.length > 160) warnings.push(`${v.id}: nombre de ${name.length} caracteres (el ERP recomienda hasta 160)`);
          const originalSku = typeof v.sku === 'string' && v.sku.trim() ? v.sku : null;
          skuInputs.push({ variantId: String(v.id), groupId: gid, legacyVariantId: historicalId(v.legacyShopifyId), originalSku });
          products.push({
            legacyEcommerceVariantId: String(v.id),
            groupLegacyId: gid,
            legacyShopifyVariantId: historicalId(v.legacyShopifyId),
            name,
            sku: '',
            originalSku,
            price,
            webOptions: { title: v.title, options: v.options, compareAtPrice, primaryImageId: v.imageId ?? null },
            skuRule: 'UNCHANGED',
          });
        });
      }
    });
  }

  checkUnique(errors, groups.map((g) => g.legacyEcommerceId), 'ID de grupo');
  checkUnique(errors, groups.map((g) => g.legacyShopifyProductId), 'ID histórico de grupo');
  checkUnique(errors, groups.map((g) => g.slug), 'slug');
  checkUnique(errors, products.map((p) => p.legacyEcommerceVariantId), 'ID de variante');
  checkUnique(errors, products.map((p) => p.legacyShopifyVariantId), 'ID histórico de variante');

  const skuMapping = resolveSkus(skuInputs);
  const byVariant = new Map(skuMapping.map((m) => [m.variantId, m]));
  for (const product of products) {
    const entry = byVariant.get(product.legacyEcommerceVariantId);
    if (entry) {
      product.sku = entry.candidateSku;
      product.skuRule = entry.rule;
    }
  }
  const skuSummary = { UNCHANGED: 0, GENERATED_FOR_MISSING: 0, DISAMBIGUATED_DUPLICATE: 0, NORMALIZED: 0 };
  for (const entry of skuMapping) skuSummary[entry.rule] += 1;

  return { errors, warnings, groups, products, skuMapping, skuSummary };
}

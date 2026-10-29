// Reglas puras del catálogo web: qué se puede publicar, cómo se calcula la disponibilidad comercial y qué
// información sale hacia el canal. Sin Nest, sin Prisma, sin red.
//
// Principios:
//  - Cada variante es un Product con su propio precio e inventario; el grupo (WebProduct) no tiene existencias.
//  - Solo se expone un ESTADO de disponibilidad, nunca cantidades, costos ni datos internos.
//  - Una variante con política UNDECIDED (o sin política) nunca sale al canal ni permite publicar el grupo.

export type AvailabilityPolicy = 'UNDECIDED' | 'STOCKED' | 'MADE_TO_ORDER';
export type ProductStatusValue = 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';
type Decimalish = { toFixed(digits: number): string } | string | number;

export type VariantRow = {
  id: string;
  sku: string | null;
  name: string;
  price: Decimalish;
  status: ProductStatusValue;
  stock: number;
  reservedStock: number;
  trackInventory: boolean;
  webAvailability: AvailabilityPolicy | null;
  webOptions: unknown;
  legacyEcommerceVariantId: string | null;
  skuApprovedAt?: Date | null;
  updatedAt: Date;
};

export type GroupRow = {
  id: string;
  legacyEcommerceId: string;
  slug: string;
  name: string;
  description: string | null;
  descriptionHtml: string | null;
  categoryLabel: string | null;
  options: unknown;
  personalizationOptions: unknown;
  imageUrl: string | null;
  imageManifest: unknown;
  /** Modelos 3D asociados (JSON estructurado, ver Model3dEntry). `undefined`/null en grupos sin 3D. */
  media3d?: unknown;
  published: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
};

export type ImageEntry = {
  id: string;
  position: number;
  src?: string | null;
  url?: string | null;
  width?: number | null;
  height?: number | null;
  sha256?: string | null;
  alt?: string | null;
  variantIds?: string[];
};

export type AvailabilityState = 'in_stock' | 'out_of_stock' | 'made_to_order';
export type VariantAvailability = { state: AvailabilityState; purchasable: boolean };

export const decimalText = (value: Decimalish): string =>
  typeof value === 'object' ? value.toFixed(2) : Number(value).toFixed(2);

export const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
};

/**
 * URL de imagen aceptable para el canal: https público. Solo fuera de producción y con
 * WEB_CATALOG_DEV_IMAGE_HOSTS (lista de hosts) se admite http hacia esos hosts, para pruebas locales.
 */
export function isPublicImageUrl(value: unknown, env: Record<string, string | undefined> = process.env): value is string {
  if (isHttpsUrl(value)) return true;
  if (typeof value !== 'string' || env.NODE_ENV === 'production') return false;
  const hosts = (env.WEB_CATALOG_DEV_IMAGE_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !url.username && !url.password && hosts.includes(url.hostname);
  } catch {
    return false;
  }
}

const isLocalCatalogPath = (value: unknown): value is string =>
  typeof value === 'string' && /^\/catalog\//.test(value) && !value.includes('..') && !value.includes('\\');

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const isValidSlug = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;

export function readImages(manifest: unknown): ImageEntry[] {
  if (!Array.isArray(manifest)) return [];
  return (manifest as ImageEntry[])
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry, index) => ({ ...entry, position: Number.isInteger(entry.position) ? entry.position : index }))
    .sort((a, b) => a.position - b.position);
}

// ---- Modelos 3D (visualización interactiva) ----
// Solo se guarda una referencia estructurada (tipo + identificador validado), nunca HTML. El tipo permite añadir luego
// modelos GLB propios (`kind: 'GLB'`) sin cambiar el contenedor.
export type Model3dKind = 'SKETCHFAB';
export type Model3dEntry = { kind: Model3dKind; modelId: string; sourceUrl: string };
export type ChannelModel3d = { kind: 'sketchfab'; modelId: string; sourceUrl: string; embedUrl: string };

const SKETCHFAB_HOSTS = new Set(['sketchfab.com', 'www.sketchfab.com']);
const SKETCHFAB_ID = /^[0-9a-f]{32}$/;
export const SKETCHFAB_EMBED_ORIGIN = 'https://sketchfab.com';

/**
 * Extrae el identificador de un modelo de Sketchfab desde su URL pública (`/3d-models/<slug>-<id>`) o de embed
 * (`/models/<id>[/embed]`). Devuelve null para cualquier otra cosa: otro dominio, HTML, http, credenciales, etc.
 */
export function parseSketchfabUrl(value: unknown): { modelId: string; sourceUrl: string } | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !SKETCHFAB_HOSTS.has(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  const match = /^\/(?:[a-z]{2}\/)?3d-models\/(?:[A-Za-z0-9._~-]*-)?([0-9a-f]{32})$/i.exec(path) ?? /^\/models\/([0-9a-f]{32})(?:\/embed)?$/i.exec(path);
  const modelId = match?.[1]?.toLowerCase();
  if (!modelId || !SKETCHFAB_ID.test(modelId)) return null;
  return { modelId, sourceUrl: `${SKETCHFAB_EMBED_ORIGIN}/models/${modelId}` };
}

/** URL de embed construida solo desde el identificador validado y el dominio permitido. */
export const sketchfabEmbedUrl = (modelId: string) => `${SKETCHFAB_EMBED_ORIGIN}/models/${modelId}/embed`;

export function readModels3d(raw: unknown): Model3dEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is Model3dEntry => !!m && m.kind === 'SKETCHFAB' && typeof m.modelId === 'string' && SKETCHFAB_ID.test(m.modelId) && typeof m.sourceUrl === 'string');
}

export function toChannelModels3d(raw: unknown): ChannelModel3d[] {
  return readModels3d(raw).map((m) => ({ kind: 'sketchfab', modelId: m.modelId, sourceUrl: m.sourceUrl, embedUrl: sketchfabEmbedUrl(m.modelId) }));
}

export function declaredOptions(options: unknown): { name: string; values: string[] }[] {
  if (!Array.isArray(options)) return [];
  return options
    .filter((o) => o && typeof o.name === 'string' && Array.isArray(o.values))
    .map((o) => ({ name: o.name as string, values: (o.values as unknown[]).map(String) }));
}

export function variantOptions(webOptions: unknown): { name: string; value: string }[] {
  const options = (webOptions as { options?: unknown } | null)?.options;
  if (!Array.isArray(options)) return [];
  return options
    .filter((o) => o && typeof o.name === 'string' && typeof o.value === 'string')
    .map((o) => ({ name: o.name as string, value: o.value as string }));
}

const variantTitle = (v: VariantRow) => {
  const title = (v.webOptions as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title ? title : v.name;
};

export function computeAvailability(v: VariantRow): VariantAvailability | null {
  if (v.webAvailability === 'MADE_TO_ORDER') return { state: 'made_to_order', purchasable: true };
  if (v.webAvailability === 'STOCKED' && v.trackInventory) {
    const available = v.stock - v.reservedStock;
    return available > 0 ? { state: 'in_stock', purchasable: true } : { state: 'out_of_stock', purchasable: false };
  }
  return null; // UNDECIDED, sin política o configuración contradictoria: no hay disponibilidad que mostrar
}

/** Una variante sale al canal solo si está activa, con política decidida y precio válido. */
export const isPublicVariant = (v: VariantRow) =>
  v.status === 'ACTIVE' && computeAvailability(v) !== null && Number(decimalText(v.price)) > 0 && !!v.sku;

export function publishBlockers(group: GroupRow, variants: VariantRow[]): string[] {
  const blockers: string[] = [];
  if (!group.name.trim()) blockers.push('GROUP_NAME_MISSING');
  if (!isValidSlug(group.slug)) blockers.push('GROUP_SLUG_INVALID');
  if (!group.description?.trim()) blockers.push('GROUP_DESCRIPTION_MISSING');
  if (!group.categoryLabel?.trim()) blockers.push('GROUP_CATEGORY_MISSING');
  const images = readImages(group.imageManifest);
  const hasImage = isPublicImageUrl(group.imageUrl) || images.some((i) => isPublicImageUrl(i.url) || isLocalCatalogPath(i.src));
  if (!hasImage) blockers.push('GROUP_IMAGE_MISSING');

  const active = variants.filter((v) => v.status === 'ACTIVE');
  if (active.length === 0) blockers.push('NO_ACTIVE_VARIANTS');
  const declared = declaredOptions(group.options);
  const seenSkus = new Set<string>();
  for (const v of active) {
    const tag = v.legacyEcommerceVariantId ?? v.id;
    if (!v.sku) blockers.push(`VARIANT_SKU_MISSING:${tag}`);
    else if (!v.skuApprovedAt) blockers.push(`VARIANT_SKU_PENDING_APPROVAL:${tag}`);
    else if (seenSkus.has(v.sku)) blockers.push(`VARIANT_SKU_REPEATED:${tag}`);
    else seenSkus.add(v.sku);
    if (!(Number(decimalText(v.price)) > 0)) blockers.push(`VARIANT_PRICE_INVALID:${tag}`);
    if (v.webAvailability === null || v.webAvailability === 'UNDECIDED') blockers.push(`VARIANT_AVAILABILITY_UNDECIDED:${tag}`);
    if (v.webAvailability === 'STOCKED' && !v.trackInventory) blockers.push(`VARIANT_STOCKED_WITHOUT_TRACKING:${tag}`);
    for (const o of variantOptions(v.webOptions)) {
      if (!declared.some((d) => d.name === o.name && d.values.includes(o.value))) {
        blockers.push(`VARIANT_OPTION_NOT_DECLARED:${tag}:${o.name}=${o.value}`);
      }
    }
  }
  return blockers;
}

export type ChannelImage = {
  id: string;
  position: number;
  /** Ruta propia de la tienda (imágenes importadas). */
  path: string | null;
  /** URL pública https autorizada (productos nuevos). */
  url: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  variantIds: string[];
};

export type ChannelVariant = {
  id: string;
  sku: string;
  title: string;
  options: { name: string; value: string }[];
  price: string;
  compareAtPrice: string | null;
  currency: 'DOP';
  imageId: string | null;
  availability: VariantAvailability;
};

export type ChannelProduct = {
  id: string;
  slug: string;
  name: string;
  description: string;
  descriptionHtml: string | null;
  category: string | null;
  options: { name: string; values: string[] }[];
  personalizationOptions: unknown;
  primaryImageUrl: string | null;
  images: ChannelImage[];
  /** Solo presente cuando el producto tiene modelos 3D: los productos sin 3D conservan el contrato anterior. */
  models3d?: ChannelModel3d[];
  variants: ChannelVariant[];
  publishedAt: string | null;
  updatedAt: string;
};

export const stableVariantId = (v: VariantRow) => v.legacyEcommerceVariantId ?? v.id;

/** Proyección pública de un grupo; null si no está publicado o no tiene variantes públicas. */
export function toChannelProduct(group: GroupRow, variants: VariantRow[]): ChannelProduct | null {
  if (!group.published) return null;
  const visible = variants.filter(isPublicVariant).sort((a, b) => stableVariantId(a).localeCompare(stableVariantId(b)));
  if (visible.length === 0) return null;
  const visibleIds = new Set(visible.map(stableVariantId));
  const images: ChannelImage[] = readImages(group.imageManifest).map((i) => ({
    id: i.id,
    position: i.position,
    path: isLocalCatalogPath(i.src) ? i.src : null,
    url: isPublicImageUrl(i.url) ? i.url : null,
    width: i.width ?? null,
    height: i.height ?? null,
    alt: i.alt ?? null,
    variantIds: (i.variantIds ?? []).filter((id) => visibleIds.has(id)),
  })).filter((i) => i.path || i.url);
  const primary = isPublicImageUrl(group.imageUrl) ? group.imageUrl : (images.find((i) => i.url)?.url ?? null);
  return {
    id: group.legacyEcommerceId,
    slug: group.slug,
    name: group.name,
    description: group.description ?? '',
    descriptionHtml: group.descriptionHtml,
    category: group.categoryLabel,
    options: declaredOptions(group.options),
    personalizationOptions: group.personalizationOptions ?? null,
    primaryImageUrl: primary,
    images,
    ...(toChannelModels3d(group.media3d).length ? { models3d: toChannelModels3d(group.media3d) } : {}),
    variants: visible.map((v) => {
      const meta = (v.webOptions ?? {}) as { compareAtPrice?: unknown; primaryImageId?: unknown };
      return {
        id: stableVariantId(v),
        sku: v.sku as string,
        title: variantTitle(v),
        options: variantOptions(v.webOptions),
        price: decimalText(v.price),
        compareAtPrice: typeof meta.compareAtPrice === 'string' ? meta.compareAtPrice : null,
        currency: 'DOP' as const,
        imageId: typeof meta.primaryImageId === 'string' ? meta.primaryImageId : null,
        availability: computeAvailability(v) as VariantAvailability,
      };
    }),
    publishedAt: group.publishedAt?.toISOString() ?? null,
    updatedAt: new Date(Math.max(group.updatedAt.getTime(), ...variants.map((v) => v.updatedAt.getTime()))).toISOString(),
  };
}

// Cliente de la API de administración del catálogo web (`/web-products*`).
// Mismo patrón que `lib/api.ts`: JWT + `x-tenant-id`. Los precios son finales: nunca se suma ni divide ITBIS.

const apiUrl = process.env.NEXT_PUBLIC_API_URL;

export type WebAvailabilityPolicy = 'UNDECIDED' | 'STOCKED' | 'MADE_TO_ORDER';
export type WebVariantStatus = 'ACTIVE' | 'INACTIVE' | 'DISCONTINUED';

export type WebProductOptionDefinition = { name: string; values: string[] };
export type WebProductOptionValue = { name: string; value: string };

export type WebProductListItem = {
  id: string;
  internalId: string;
  slug: string;
  name: string;
  categoryLabel: string | null;
  published: boolean;
  publishedAt: string | null;
  updatedAt: string;
  primaryImage: string | null;
  has3d?: boolean;
  variantCount: number;
  activeVariantCount: number;
  priceMin: string | null;
  priceMax: string | null;
  availability: { stocked: number; madeToOrder: number; undecided: number };
  availableUnits: number;
  publishable: boolean;
  blockers: string[];
  /** Estado de preparación sobre todas las variantes (los bloqueos solo miran las activas). */
  preparation?: { inactive: number; undecided: number; skuPending: number };
};

export type WebProductList = { items: WebProductListItem[]; nextCursor: string | null };

export type WebProductCategory = { name: string | null; count: number };

export type WebProductVariant = {
  id: string;
  internalId: string;
  sku: string | null;
  name: string;
  price: string;
  status: WebVariantStatus;
  trackInventory: boolean;
  webAvailability: WebAvailabilityPolicy | null;
  commercialAvailability: {
    state: 'in_stock' | 'out_of_stock' | 'made_to_order';
    purchasable: boolean;
  } | null;
  availableUnits: number;
  webOptions: {
    title?: string;
    options?: WebProductOptionValue[];
    compareAtPrice?: string | null;
  } | null;
};

export type WebProductDetail = {
  id: string;
  internalId: string;
  slug: string;
  name: string;
  description: string | null;
  categoryLabel: string | null;
  options: WebProductOptionDefinition[];
  imageUrl: string | null;
  images: Array<{
    id: string;
    position: number;
    src?: string | null;
    url?: string | null;
    alt?: string | null;
  }>;
  /** Modelo 3D asociado (Sketchfab hoy; GLB propio en el futuro). */
  model3d: { kind: 'SKETCHFAB'; modelId: string; sourceUrl: string; embedUrl: string } | null;
  published: boolean;
  publishedAt: string | null;
  publishable: boolean;
  blockers: string[];
  variants: WebProductVariant[];
};

export type WebVariantInput = {
  title: string;
  options: WebProductOptionValue[];
  sku: string;
  price: number;
  webAvailability?: WebAvailabilityPolicy;
};

export type CreateWebProductInput = {
  name: string;
  description?: string;
  categoryLabel?: string;
  imageUrl?: string;
  options: WebProductOptionDefinition[];
  variants: WebVariantInput[];
};

export type UpdateWebProductInput = {
  name?: string;
  description?: string;
  categoryLabel?: string;
  imageUrl?: string;
  /** URL de Sketchfab; cadena vacía o null elimina el modelo 3D. */
  model3dUrl?: string | null;
  options?: WebProductOptionDefinition[];
};

export type UpdateWebVariantInput = {
  title?: string;
  options?: WebProductOptionValue[];
  sku?: string;
  price?: number;
  status?: WebVariantStatus;
  webAvailability?: WebAvailabilityPolicy;
  trackInventory?: boolean;
};

export class WebCatalogApiError extends Error {
  status: number;
  /** Códigos de bloqueo (`BLOCKER:*` del 409) sin el prefijo. */
  blockers: string[];

  constructor(message: string, status: number, blockers: string[] = []) {
    super(message);
    this.name = 'WebCatalogApiError';
    this.status = status;
    this.blockers = blockers;
  }
}

function parseError(body: string, status: number) {
  const fallback = `No se pudo completar la solicitud (${status}).`;
  if (!body) return new WebCatalogApiError(fallback, status);
  try {
    const parsed = JSON.parse(body) as { message?: string | string[] };
    const all = Array.isArray(parsed.message)
      ? parsed.message
      : parsed.message
        ? [parsed.message]
        : [];
    const blockers = all
      .filter((m) => m.startsWith('BLOCKER:'))
      .map((m) => m.slice('BLOCKER:'.length));
    const text = all.filter((m) => !m.startsWith('BLOCKER:')).join(' ');
    return new WebCatalogApiError(text || fallback, status, blockers);
  } catch {
    return new WebCatalogApiError(fallback, status);
  }
}

async function request<T>(
  path: string,
  tenantId: string,
  accessToken: string,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {},
) {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
        Authorization: `Bearer ${accessToken}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new WebCatalogApiError('No se pudo conectar con el servidor. Revisa tu conexión.', 0);
  }
  if (!response.ok) throw parseError(await response.text(), response.status);
  return (await response.json()) as T;
}

export function listWebProducts(
  tenantId: string,
  accessToken: string,
  params: {
    q?: string;
    published?: 'true' | 'false';
    category?: string;
    blocker?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.published) search.set('published', params.published);
  if (params.category) search.set('category', params.category);
  if (params.blocker) search.set('blocker', params.blocker);
  if (params.cursor) search.set('cursor', params.cursor);
  search.set('limit', String(params.limit ?? 50));
  return request<WebProductList>(`/web-products?${search.toString()}`, tenantId, accessToken);
}

export function getWebProductCategories(tenantId: string, accessToken: string) {
  return request<WebProductCategory[]>('/web-products/categories', tenantId, accessToken);
}

export function getWebProduct(tenantId: string, accessToken: string, id: string) {
  return request<WebProductDetail>(
    `/web-products/${encodeURIComponent(id)}`,
    tenantId,
    accessToken,
  );
}

export function createWebProduct(
  tenantId: string,
  accessToken: string,
  body: CreateWebProductInput,
) {
  return request<WebProductDetail>('/web-products', tenantId, accessToken, {
    method: 'POST',
    body,
  });
}

export function updateWebProduct(
  tenantId: string,
  accessToken: string,
  id: string,
  body: UpdateWebProductInput,
) {
  return request<WebProductDetail>(
    `/web-products/${encodeURIComponent(id)}`,
    tenantId,
    accessToken,
    { method: 'PATCH', body },
  );
}

export function addWebVariant(
  tenantId: string,
  accessToken: string,
  id: string,
  body: WebVariantInput,
) {
  return request<WebProductDetail>(
    `/web-products/${encodeURIComponent(id)}/variants`,
    tenantId,
    accessToken,
    { method: 'POST', body },
  );
}

export function updateWebVariant(
  tenantId: string,
  accessToken: string,
  id: string,
  variantId: string,
  body: UpdateWebVariantInput,
) {
  return request<WebProductDetail>(
    `/web-products/${encodeURIComponent(id)}/variants/${encodeURIComponent(variantId)}`,
    tenantId,
    accessToken,
    { method: 'PATCH', body },
  );
}

export function publishWebProduct(tenantId: string, accessToken: string, id: string) {
  return request<WebProductDetail>(
    `/web-products/${encodeURIComponent(id)}/publish`,
    tenantId,
    accessToken,
    { method: 'POST' },
  );
}

export function unpublishWebProduct(tenantId: string, accessToken: string, id: string) {
  return request<WebProductDetail>(
    `/web-products/${encodeURIComponent(id)}/unpublish`,
    tenantId,
    accessToken,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------- preparación masiva

export type WebCatalogReview = {
  groups: number;
  published: number;
  publishable: number;
  variants: number;
  inactiveVariants: number;
  undecidedVariants: number;
  skuPendingApproval: number;
  groupsWithoutCategory: number;
  groupsWithoutImage: number;
  groupsWithoutDescription: number;
  byBlocker: Record<string, number>;
};

export type SkuRule = 'ORIGINAL' | 'GENERADO_SIN_SKU' | 'NORMALIZADO' | 'DESAMBIGUADO_DUPLICADO';

export type SkuReviewRow = {
  variantId: string;
  groupId: string | null;
  groupName: string | null;
  name: string;
  originalSku: string | null;
  proposedSku: string | null;
  rule: SkuRule;
};

export type BulkSkipped = { id: string; reason: string };
export type BulkCategoryResult = { applied: string[]; skipped: BulkSkipped[] };
export type BulkSkuApproveResult = { approved: string[]; withoutSku: string[]; notFound?: string[] };
export type BulkAvailabilityResult = {
  updated: string[];
  alreadyDecided: string[];
  notFound?: string[];
};
export type BulkActivateResult = { activated: string[]; skipped: BulkSkipped[]; notFound?: string[] };
export type BulkPublishResult = {
  published: string[];
  rejected: Array<{ id: string; blockers: string[] }>;
  notFound?: string[];
};

export function getWebCatalogReview(tenantId: string, accessToken: string) {
  return request<WebCatalogReview>('/web-products/review', tenantId, accessToken);
}

export function getSkuReview(tenantId: string, accessToken: string, groupId: string) {
  const search = new URLSearchParams({ limit: '200', groupId });
  return request<{ items: SkuReviewRow[]; nextCursor: string | null }>(
    `/web-products/sku-review?${search.toString()}`,
    tenantId,
    accessToken,
  );
}

export function bulkAssignCategory(
  tenantId: string,
  accessToken: string,
  body: { ids: string[]; categoryLabel: string; overwrite?: boolean },
) {
  return request<BulkCategoryResult>('/web-products/bulk/category', tenantId, accessToken, {
    method: 'POST',
    body,
  });
}

export function bulkApproveSkus(tenantId: string, accessToken: string, ids: string[]) {
  return request<BulkSkuApproveResult>('/web-products/bulk/sku-approve', tenantId, accessToken, {
    method: 'POST',
    body: { ids },
  });
}

export function bulkSetAvailability(
  tenantId: string,
  accessToken: string,
  body: { ids: string[]; policy: 'STOCKED' | 'MADE_TO_ORDER' },
) {
  return request<BulkAvailabilityResult>('/web-products/bulk/availability', tenantId, accessToken, {
    method: 'POST',
    body,
  });
}

export function bulkActivateVariants(tenantId: string, accessToken: string, ids: string[]) {
  return request<BulkActivateResult>('/web-products/bulk/activate', tenantId, accessToken, {
    method: 'POST',
    body: { ids },
  });
}

/** Publicación masiva: solo con ids explícitos (máx. 25) y confirmación; no existe "publicar todo". */
export function bulkPublish(tenantId: string, accessToken: string, ids: string[]) {
  return request<BulkPublishResult>('/web-products/bulk/publish', tenantId, accessToken, {
    method: 'POST',
    body: { ids, confirm: true },
  });
}

// ---------------------------------------------------------------- imágenes del grupo

export type UploadedWebImage = {
  imageId: string;
  url: string;
  path: string;
  bucket: string;
  primary: boolean;
};

export const WEB_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Sube un archivo a POST /web-products/:id/images (multipart; el navegador fija el límite del cuerpo). */
export async function uploadWebProductImage(
  tenantId: string,
  accessToken: string,
  id: string,
  input: { file: File; alt?: string; primary?: boolean },
): Promise<UploadedWebImage> {
  const form = new FormData();
  form.append('file', input.file);
  if (input.alt?.trim()) form.append('alt', input.alt.trim());
  if (input.primary) form.append('primary', 'true');
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/web-products/${encodeURIComponent(id)}/images`, {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, Authorization: `Bearer ${accessToken}` },
      body: form,
    });
  } catch {
    throw new WebCatalogApiError('No se pudo conectar con el servidor. Revisa tu conexión.', 0);
  }
  if (!response.ok) throw parseError(await response.text(), response.status);
  return (await response.json()) as UploadedWebImage;
}

// Política PROPUESTA de SKUs para el catálogo web. Determinista y pura: los candidatos NO están aprobados
// para aplicarse en una base real; solo sirven para pruebas aisladas y para revisión del propietario.
//   sin SKU            -> UP-{producto}-{variante}       UP-P-0040-V02 -> UP-0040-02
//   SKU duplicado      -> {SKU normalizado}-{producto}   mapping explícito por variante, sin fusionar publicaciones
//   SKU no normalizado -> SKU normalizado como lo guarda el ERP (misma regla que products.service.ts)
//   SKU correcto       -> sin cambio
// El SKU original y el ID histórico se conservan siempre junto al candidato.

export const SKU_MAX = 80;

export type SkuRule = 'UNCHANGED' | 'GENERATED_FOR_MISSING' | 'DISAMBIGUATED_DUPLICATE' | 'NORMALIZED';

export type SkuVariantInput = {
  variantId: string;
  groupId: string;
  legacyVariantId: string;
  originalSku: string | null;
};

export type SkuMappingEntry = SkuVariantInput & {
  candidateSku: string;
  rule: SkuRule;
  approvedForRealDatabase: false;
};

export type SkuCollision = {
  variantId: string;
  candidateSku: string;
  reason: 'DUPLICATE_CANDIDATE' | 'EXISTS_IN_TARGET_FOR_OTHER_VARIANT';
};

/** Misma regla que normalizeCodeSegment de apps/api/src/modules/products/products.service.ts (+ límite de 80). */
export function normalizeSku(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toUpperCase()
    .slice(0, SKU_MAX);
}

function numericParts(id: string, pattern: RegExp, label: string): string[] {
  const match = pattern.exec(id);
  if (!match) throw new Error(`ID histórico con formato inesperado (${label}): ${id}`);
  return match.slice(1);
}

export function resolveSkus(rows: SkuVariantInput[]): SkuMappingEntry[] {
  const groups = new Map<string, number>();
  for (const row of rows) {
    if (row.originalSku) {
      const key = normalizeSku(row.originalSku);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
  return rows.map((row) => {
    const base = { ...row, approvedForRealDatabase: false as const };
    if (!row.originalSku) {
      const [product, variant] = numericParts(row.variantId, /^UP-P-(\d+)-V(\d+)$/, 'variante');
      return { ...base, candidateSku: `UP-${product}-${variant}`, rule: 'GENERATED_FOR_MISSING' };
    }
    const normalized = normalizeSku(row.originalSku);
    if ((groups.get(normalized) ?? 0) > 1) {
      const [product] = numericParts(row.groupId, /^UP-P-(\d+)$/, 'grupo');
      return { ...base, candidateSku: `${normalized}-${product}`.slice(0, SKU_MAX), rule: 'DISAMBIGUATED_DUPLICATE' };
    }
    if (normalized !== row.originalSku) return { ...base, candidateSku: normalized, rule: 'NORMALIZED' };
    return { ...base, candidateSku: row.originalSku, rule: 'UNCHANGED' };
  });
}

/**
 * Colisiones DESPUÉS de generar los candidatos: entre candidatos, y contra SKUs que ya existen en el destino
 * (`targetSkuOwners`: sku -> legacyEcommerceVariantId del dueño actual, o null si no es del catálogo web).
 * Un SKU existente cuyo dueño es la misma variante no es colisión: es un reintento.
 */
export function detectSkuCollisions(
  mapping: SkuMappingEntry[],
  targetSkuOwners: ReadonlyMap<string, string | null> = new Map(),
): SkuCollision[] {
  const counts = new Map<string, number>();
  for (const entry of mapping) counts.set(entry.candidateSku, (counts.get(entry.candidateSku) ?? 0) + 1);
  const collisions: SkuCollision[] = [];
  for (const entry of mapping) {
    if ((counts.get(entry.candidateSku) ?? 0) > 1) {
      collisions.push({ variantId: entry.variantId, candidateSku: entry.candidateSku, reason: 'DUPLICATE_CANDIDATE' });
    }
    if (targetSkuOwners.has(entry.candidateSku) && targetSkuOwners.get(entry.candidateSku) !== entry.variantId) {
      collisions.push({
        variantId: entry.variantId,
        candidateSku: entry.candidateSku,
        reason: 'EXISTS_IN_TARGET_FOR_OTHER_VARIANT',
      });
    }
  }
  return collisions;
}

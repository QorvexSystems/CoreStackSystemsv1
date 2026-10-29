import type { SkuRule, WebAvailabilityPolicy, WebVariantStatus } from './web-catalog-api';

export const availabilityLabels: Record<WebAvailabilityPolicy, string> = {
  STOCKED: 'Inventario controlado',
  MADE_TO_ORDER: 'Bajo pedido',
  UNDECIDED: 'Sin decidir',
};

export const variantStatusLabels: Record<WebVariantStatus, string> = {
  ACTIVE: 'Activa',
  INACTIVE: 'Inactiva',
  DISCONTINUED: 'Descontinuada',
};

const fixedBlockers: Record<string, string> = {
  GROUP_NAME_MISSING: 'Falta el nombre del producto.',
  GROUP_SLUG_INVALID: 'El identificador web (slug) no es válido.',
  GROUP_DESCRIPTION_MISSING: 'Falta la descripción del producto.',
  GROUP_CATEGORY_MISSING: 'Falta la categoría.',
  GROUP_IMAGE_MISSING: 'Falta una imagen principal (URL pública https).',
  NO_ACTIVE_VARIANTS: 'Debe haber al menos una variante activa.',
};

/**
 * Traduce un código de bloqueo de publicación (`GROUP_*`, `VARIANT_*:id[:detalle]`) a un mensaje claro.
 * `variantName` resuelve el identificador de variante a un nombre legible (título o SKU).
 */
export function describeBlocker(
  code: string,
  variantName: (id: string) => string = (id) => id,
): string {
  if (fixedBlockers[code]) return fixedBlockers[code];
  const [kind, tag, ...rest] = code.split(':');
  const name = tag ? `«${variantName(tag)}»` : 'una variante';
  switch (kind) {
    case 'VARIANT_SKU_MISSING':
      return `La variante ${name} no tiene SKU.`;
    case 'VARIANT_SKU_PENDING_APPROVAL':
      return `El SKU de la variante ${name} es una propuesta pendiente de aprobación humana.`;
    case 'VARIANT_SKU_REPEATED':
      return `La variante ${name} repite el SKU de otra variante activa.`;
    case 'VARIANT_PRICE_INVALID':
      return `La variante ${name} necesita un precio mayor que cero.`;
    case 'VARIANT_AVAILABILITY_UNDECIDED':
      return `Define la disponibilidad de la variante ${name}: inventario controlado o bajo pedido.`;
    case 'VARIANT_STOCKED_WITHOUT_TRACKING':
      return `La variante ${name} es de inventario controlado pero no controla existencias.`;
    case 'VARIANT_OPTION_NOT_DECLARED':
      return `La variante ${name} usa una opción que no está declarada (${rest.join(':')}).`;
    default:
      return `Requisito pendiente: ${code}`;
  }
}

/** Filtros por bloqueo de la vista de preparación (código de la API → etiqueta). */
export const blockerFilterLabels: Record<string, string> = {
  GROUP_CATEGORY_MISSING: 'Sin categoría',
  GROUP_IMAGE_MISSING: 'Sin imagen',
  GROUP_DESCRIPTION_MISSING: 'Sin descripción',
  NO_ACTIVE_VARIANTS: 'Sin variantes activas',
  VARIANT_AVAILABILITY_UNDECIDED: 'Sin política de disponibilidad',
  VARIANT_SKU_PENDING_APPROVAL: 'SKU pendientes de aprobación',
  ANY_VARIANT_INACTIVE: 'Con variantes inactivas',
  ANY_VARIANT_UNDECIDED: 'Con variantes sin política',
  ANY_VARIANT_SKU_PENDING: 'Con SKU pendientes de aprobar',
  NONE: 'Publicables',
};

export const skuRuleLabels: Record<SkuRule, string> = {
  ORIGINAL: 'Original (sin cambios)',
  GENERADO_SIN_SKU: 'Generado porque no tenía SKU',
  NORMALIZADO: 'Normalizado (formato corregido)',
  DESAMBIGUADO_DUPLICADO: 'Desambiguado (estaba repetido)',
};

export const bulkSkipReasonLabels: Record<string, string> = {
  NOT_FOUND: 'No se encontró el producto.',
  ALREADY_HAS_CATEGORY: 'Ya tiene categoría (no se sobrescribe).',
  UNCHANGED: 'Ya tenía esa misma categoría.',
  SKU_NOT_APPROVED: 'Su SKU aún no está aprobado.',
  AVAILABILITY_UNDECIDED: 'Su política de disponibilidad no está decidida.',
  PRICE_INVALID: 'Su precio no es válido (debe ser mayor que cero).',
};

export function describeSkipReason(reason: string) {
  return bulkSkipReasonLabels[reason] ?? `Omitido: ${reason}`;
}

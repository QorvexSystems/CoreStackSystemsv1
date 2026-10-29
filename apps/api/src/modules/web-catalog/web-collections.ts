import { Prisma } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { WEB_COLLECTIONS } from './web-collections.data';

export type WebCollectionOption = { handle: string; title: string; count: number };

/** Normaliza el handle recibido por query: solo letras, dígitos y guiones, como los de la tienda. */
export function cleanCollectionHandle(value: string | undefined): string | undefined {
  const handle = value?.trim();
  return handle ? handle : undefined;
}

/**
 * Filtro de Product para una colección del e-commerce. Une por WebProduct (grupo), no por nombre, y siempre
 * dentro del tenant. Una colección desconocida no devuelve nada (en vez de ignorar el filtro).
 */
export async function collectionProductFilter(
  prisma: PrismaService,
  tenantId: string,
  handle: string,
): Promise<Prisma.ProductWhereInput> {
  const collection = WEB_COLLECTIONS.find((c) => c.handle === handle);
  if (!collection) return { id: { in: [] } };
  const groups = await prisma.webProduct.findMany({
    where: { tenantId, legacyEcommerceId: { in: collection.groupIds } },
    select: { id: true },
  });
  return { webProductId: { in: groups.map((g) => g.id) } };
}

/**
 * Colecciones con el número de productos/variantes realmente visibles en el módulo (`where`). Cada variante pertenece a
 * un solo grupo y un grupo aparece una sola vez por colección, así que no hay duplicados al sumar.
 */
export async function countCollections(
  prisma: PrismaService,
  tenantId: string,
  where: Prisma.ProductWhereInput,
): Promise<WebCollectionOption[]> {
  const [perGroup, groups] = await Promise.all([
    prisma.product.groupBy({
      by: ['webProductId'],
      where: { ...where, tenantId, webProductId: { not: null } },
      _count: { _all: true },
    }),
    prisma.webProduct.findMany({ where: { tenantId }, select: { id: true, legacyEcommerceId: true } }),
  ]);
  const variantsByLegacyId = new Map<string, number>();
  const legacyIdByGroup = new Map(groups.map((g) => [g.id, g.legacyEcommerceId]));
  for (const row of perGroup) {
    const legacyId = row.webProductId ? legacyIdByGroup.get(row.webProductId) : undefined;
    if (legacyId) variantsByLegacyId.set(legacyId, row._count._all);
  }
  return WEB_COLLECTIONS.map((c) => ({
    handle: c.handle,
    title: c.title,
    count: c.groupIds.reduce((sum, id) => sum + (variantsByLegacyId.get(id) ?? 0), 0),
  }))
    .filter((c) => c.count > 0)
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

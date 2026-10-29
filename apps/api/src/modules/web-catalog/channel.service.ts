import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  computeAvailability,
  decimalText,
  isPublicVariant,
  stableVariantId,
  toChannelProduct,
  type AvailabilityPolicy,
  type ChannelProduct,
  type GroupRow,
  type VariantRow,
} from './web-catalog.rules';

// Solo los campos necesarios para la proyección pública: nunca costos, márgenes, códigos de barras ni proveedores.
const VARIANT_SELECT = {
  id: true, sku: true, name: true, price: true, status: true, stock: true, reservedStock: true,
  trackInventory: true, webAvailability: true, webOptions: true, legacyEcommerceVariantId: true,
  updatedAt: true, webProductId: true, skuApprovedAt: true,
} as const;
const PUBLIC_POLICIES: AvailabilityPolicy[] = ['STOCKED', 'MADE_TO_ORDER'];

@Injectable()
export class ChannelService {
  constructor(private readonly prisma: PrismaService) {}

  async catalog(tenantId: string, options: { limit?: number; cursor?: string }) {
    const limit = options.limit ?? 200;
    const groups = await this.prisma.webProduct.findMany({
      where: { tenantId, published: true, ...(options.cursor ? { legacyEcommerceId: { gt: options.cursor } } : {}) },
      orderBy: { legacyEcommerceId: 'asc' },
      take: limit + 1,
    });
    const page = groups.slice(0, limit);
    const variants = page.length
      ? await this.prisma.product.findMany({
          where: { tenantId, webProductId: { in: page.map((g) => g.id) }, status: 'ACTIVE', webAvailability: { in: PUBLIC_POLICIES } },
          select: VARIANT_SELECT,
        })
      : [];
    const items: ChannelProduct[] = [];
    for (const group of page) {
      const projected = toChannelProduct(group as GroupRow, variants.filter((v) => v.webProductId === group.id) as unknown as VariantRow[]);
      if (projected) items.push(projected);
    }
    const nextCursor = groups.length > limit ? page[page.length - 1].legacyEcommerceId : null;
    const version = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
    return { generatedAt: new Date().toISOString(), items, nextCursor, version };
  }

  async availability(tenantId: string, requested: { variantId: string; quantity?: number }[]) {
    const ids = [...new Set(requested.map((r) => r.variantId))];
    const rows = await this.prisma.product.findMany({
      where: { tenantId, OR: [{ legacyEcommerceVariantId: { in: ids } }, { id: { in: ids } }], webProduct: { is: { published: true } } },
      select: VARIANT_SELECT,
    });
    const byId = new Map<string, VariantRow>();
    for (const row of rows as unknown as VariantRow[]) {
      byId.set(stableVariantId(row), row);
      byId.set(row.id, row);
    }
    return {
      generatedAt: new Date().toISOString(),
      items: requested.map(({ variantId, quantity }) => {
        const row = byId.get(variantId);
        const availability = row && isPublicVariant(row) ? computeAvailability(row) : null;
        if (!row || !availability) return { variantId, found: false as const };
        const available = row.stock - row.reservedStock;
        // Confirmar una compra requerirá volver a llamar aquí: `sufficient` se decide en el ERP, no en la tienda.
        const sufficient = quantity === undefined ? availability.purchasable : availability.state === 'made_to_order' || available >= quantity;
        return {
          variantId,
          found: true as const,
          sku: row.sku,
          price: decimalText(row.price),
          currency: 'DOP' as const,
          availability,
          sufficient,
        };
      }),
    };
  }
}

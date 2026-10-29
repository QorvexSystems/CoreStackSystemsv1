import { BadRequestException, ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import type { ChannelCreateOrderDto } from './web-catalog.dto';

/**
 * Recibe solicitudes de pedido del e-commerce (servidor a servidor, firmadas con HMAC). Solo identifica qué variantes
 * publicadas pide el cliente; precios, impuestos, disponibilidad, reserva y alta de la orden las resuelve
 * `OrdersService.createExternalOrder` con las reglas del ERP.
 */
@Injectable()
export class ChannelOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async create(tenantId: string, dto: ChannelCreateOrderDto) {
    const variantIds = [...new Set(dto.items.map((item) => item.variantId))];
    const products = await this.prisma.product.findMany({
      where: {
        tenantId,
        legacyEcommerceVariantId: { in: variantIds },
        status: 'ACTIVE',
        webProduct: { is: { published: true } },
      },
      select: { id: true, legacyEcommerceVariantId: true, webAvailability: true },
    });
    const byVariant = new Map(
      products
        .filter((p) => p.webAvailability === 'STOCKED' || p.webAvailability === 'MADE_TO_ORDER')
        .map((p) => [p.legacyEcommerceVariantId as string, p.id]),
    );
    const missing = variantIds.filter((id) => !byVariant.has(id));
    if (missing.length) {
      throw new UnprocessableEntityException({
        code: 'VARIANT_UNAVAILABLE',
        message: 'Algunas piezas del pedido ya no están disponibles.',
        variantIds: missing,
      });
    }

    try {
      const result = await this.orders.createExternalOrder(tenantId, {
        reference: dto.reference,
        customer: dto.customer,
        delivery: dto.delivery,
        notes: dto.notes,
        items: dto.items.map((item) => ({
          productId: byVariant.get(item.variantId) as string,
          quantity: item.quantity,
          note: item.note,
        })),
      });
      return {
        duplicate: result.duplicate,
        reference: dto.reference,
        orderNumber: result.order.orderNumber,
        receivedAt: result.order.createdAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        const message = String((error.getResponse() as { message?: unknown }).message ?? error.message);
        if (/Insufficient available stock/i.test(message)) {
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: 'No hay existencias suficientes para alguna de las piezas del pedido.',
          });
        }
        throw new UnprocessableEntityException({ code: 'ORDER_REJECTED', message });
      }
      throw error;
    }
  }
}

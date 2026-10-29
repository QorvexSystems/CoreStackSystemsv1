import { consumerInvoiceNumber } from '../../common/utils/consumer-invoice-number';
import { changeReservation, markInventoryChanged } from '../../common/utils/stock-reservations';
import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeliveryMethod,
  DocumentType,
  ProductInventoryDestination,
  DispatchLocation,
  InventoryMovementType,
  InvoiceStatus,
  OrderExceptionStatus,
  OrderSource,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ProductKind,
  Role,
  SalesOrderDestination,
  SalesOrderStatus,
} from '@qorvex/database';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

type ShopifyOrder = {
  currency?: string;
  taxes_included?: boolean;
  current_total_price?: string;
  refund_line_items?: Array<{
    line_item_id: string | number;
    quantity: number;
    subtotal?: string;
    total_tax?: string;
    restock_type?: string;
  }>;
  transactions?: Array<{ kind?: string; status?: string; amount: string }>;
  order_adjustments?: Array<{ amount?: string; tax_amount?: string }>;
  fulfillment_status?: string;
  id: number | string;
  order_id?: number | string;
  name?: string;
  order_number?: number;
  financial_status?: string;
  created_at?: string;
  email?: string;
  phone?: string;
  total_line_items_price?: string;
  total_discounts?: string;
  total_tax?: string;
  total_price?: string;
  customer?: { first_name?: string; last_name?: string; email?: string; phone?: string };
  shipping_address?: { address1?: string; address2?: string; city?: string; province?: string };
  note?: string;
  note_attributes?: Array<{ name: string; value: string }>;
  line_items?: Array<{
    id: number | string;
    variant_id?: number | string | null;
    sku?: string | null;
    name?: string;
    title?: string;
    quantity: number;
    price: string;
    total_discount?: string;
    tax_lines?: Array<{ price?: string }>;
    properties?: Array<{ name: string; value: string }>;
  }>;
};

@Injectable()
export class ShopifyService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private processing = false;
  onModuleInit() {
    if (this.isConfigured()) {
      this.timer = setInterval(() => {
        void this.processPending().catch(() => undefined);
      }, 15000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Aislamiento explícito de Shopify (ventana de migración): solo `SHOPIFY_SYNC_DISABLED=true` (sin distinguir mayúsculas ni
   * espacios) lo activa. Por defecto no cambia nada. Desactiva TODO lo saliente: cola, worker, reintento manual y sincronización
   * de productos; la recepción de pedidos por webhook (entrante) no se ve afectada.
   */
  syncDisabled() {
    return this.config.get<string>('SHOPIFY_SYNC_DISABLED')?.trim().toLowerCase() === 'true';
  }

  isConfigured() {
    if (this.syncDisabled()) return false;
    return Boolean(
      this.config.get<string>('SHOPIFY_STORE_DOMAIN')?.trim() &&
      this.config.get<string>('SHOPIFY_ADMIN_ACCESS_TOKEN')?.trim() &&
      this.config.get<string>('SHOPIFY_LOCATION_ID')?.trim(),
    );
  }

  async syncProductIfConfigured(tenantId: string, productId: string) {
    // Aislamiento explícito de Shopify para entornos de prueba o de transición: por defecto NO cambia nada
    // (sigue encolando y sincronizando como siempre). Solo SHOPIFY_SYNC_DISABLED=true omite cola y llamadas.
    if (this.syncDisabled()) {
      return { configured: false, synced: false, disabled: true };
    }
    await markInventoryChanged(this.prisma, tenantId, productId);
    if (!this.isConfigured()) return { configured: false, synced: false };
    try {
      await this.syncProduct(tenantId, productId);
      return { configured: true, synced: true };
    } catch (error) {
      await this.prisma.inventorySyncJob.update({
        where: { tenantId_productId: { tenantId, productId } },
        data: {
          pending: true,
          error: error instanceof Error ? error.message.slice(0, 1000) : 'Error de sincronización',
          attempts: { increment: 1 },
        },
      });
      return { configured: true, synced: false };
    }
  }

  async receiveOrder(
    rawBody: Buffer | undefined,
    payload: ShopifyOrder,
    headers: { hmac?: string; shopDomain?: string; webhookId?: string },
  ) {
    this.verifyWebhook(rawBody, headers.hmac, headers.shopDomain);
    if (!payload?.id || !Array.isArray(payload.line_items) || !payload.line_items.length) {
      throw new BadRequestException('El webhook de Shopify no contiene una orden válida.');
    }

    const tenantSlug = this.config.get<string>('SHOPIFY_TENANT_SLUG', 'unique-personalizado');
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new ServiceUnavailableException('El tenant de Shopify no está configurado.');

    if (payload.currency && payload.currency !== 'DOP')
      throw new BadRequestException('La moneda Shopify debe ser DOP.');
    const externalOrderId = String(payload.id);
    const duplicate = await this.prisma.salesOrder.findUnique({
      where: {
        tenantId_source_externalOrderId: {
          tenantId: tenant.id,
          source: OrderSource.SHOPIFY,
          externalOrderId,
        },
      },
      select: { id: true, orderNumber: true },
    });
    if (duplicate) return { received: true, duplicate: true, order: duplicate };

    const membership = await this.prisma.membership.findFirst({
      where: { tenantId: tenant.id, role: { in: [Role.ADMIN, Role.SUPER_ADMIN] } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership)
      throw new ServiceUnavailableException('Shopify requiere un administrador del tenant.');

    const variantIds = payload.line_items.flatMap((item) =>
      item.variant_id
        ? [String(item.variant_id), `gid://shopify/ProductVariant/${String(item.variant_id)}`]
        : [],
    );
    const skus = payload.line_items.flatMap((item) => (item.sku?.trim() ? [item.sku.trim()] : []));
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: tenant.id,
        OR: [
          ...(variantIds.length ? [{ shopifyVariantId: { in: variantIds } }] : []),
          ...(skus.length ? [{ sku: { in: skus } }] : []),
        ],
      },
    });
    const byVariant = new Map(
      products.flatMap((product) =>
        product.shopifyVariantId ? [[product.shopifyVariantId, product] as const] : [],
      ),
    );
    const bySku = new Map(
      products.flatMap((product) => (product.sku ? [[product.sku, product] as const] : [])),
    );
    const lines = payload.line_items.map((line) => {
      const product =
        (line.variant_id
          ? (byVariant.get(String(line.variant_id)) ??
            byVariant.get(`gid://shopify/ProductVariant/${line.variant_id}`))
          : undefined) ?? (line.sku ? bySku.get(line.sku.trim()) : undefined);
      const quantity = Number(line.quantity);
      let unitPrice = new Prisma.Decimal(line.price || 0);
      let discount = new Prisma.Decimal(line.total_discount || 0);
      let subtotal = unitPrice.mul(quantity).sub(discount).toDecimalPlaces(2);
      const tax = (line.tax_lines ?? []).reduce(
        (total, item) => total.add(item.price || 0),
        new Prisma.Decimal(0),
      );
      if (payload.taxes_included) subtotal = subtotal.sub(tax);
      const taxRate = subtotal.gt(0) ? tax.div(subtotal).toDecimalPlaces(4) : new Prisma.Decimal(0);
      if (payload.taxes_included && subtotal.gt(0)) {
        const divisor = new Prisma.Decimal(1).add(taxRate);
        unitPrice = unitPrice.div(divisor).toDecimalPlaces(2);
        discount = discount.div(divisor).toDecimalPlaces(2);
      }
      if (!Number.isInteger(quantity) || quantity <= 0 || subtotal.lt(0))
        throw new BadRequestException('Shopify contiene cantidades o importes inválidos.');
      return {
        line,
        personalization: this.linePersonalization(line.properties),
        product,
        quantity,
        unitPrice,
        discount,
        taxRate,
        subtotal,
        tax,
        total: subtotal.add(tax),
      };
    });
    const unknownLines = lines.filter((item) => !item.product);
    if (unknownLines.length) {
      throw new BadRequestException(
        `Shopify contiene productos sin correspondencia en CoreStack: ${unknownLines
          .map((item) => item.line.sku || item.line.name || item.line.title || item.line.id)
          .join(', ')}.`,
      );
    }
    const paid = ['paid', 'partially_refunded'].includes(payload.financial_status ?? '');
    const orderNumber = `SHOP-${String(payload.order_number ?? payload.name ?? payload.id).replace(/[^A-Za-z0-9-]/g, '')}`;
    const promisedAt = this.resolvePromisedAt(payload.note_attributes);
    const clientName =
      [payload.customer?.first_name, payload.customer?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      payload.email ||
      'Cliente Shopify';
    const personalization = lines.flatMap(({ line }) =>
      (line.properties ?? [])
        .filter((property) => property.value)
        .map((property) => `${line.name ?? line.title}: ${property.name}: ${property.value}`),
    );
    const deliveryNote = [
      payload.shipping_address?.address1,
      payload.shipping_address?.address2,
      payload.shipping_address?.city,
      payload.shipping_address?.province,
      payload.phone ?? payload.customer?.phone,
    ]
      .filter(Boolean)
      .join(', ');

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenant.id} FOR UPDATE`;
      const existing = await tx.salesOrder.findUnique({
        where: {
          tenantId_source_externalOrderId: {
            tenantId: tenant.id,
            source: OrderSource.SHOPIFY,
            externalOrderId,
          },
        },
      });
      if (existing) return existing;
      const email = payload.email ?? payload.customer?.email;
      const existingCustomer = email
        ? await tx.customer.findFirst({
            where: { tenantId: tenant.id, email: { equals: email, mode: 'insensitive' } },
          })
        : null;
      const customer =
        existingCustomer ??
        (await tx.customer.create({
          data: {
            tenantId: tenant.id,
            name: clientName,
            email,
            phone: payload.phone ?? payload.customer?.phone,
            address: deliveryNote,
            documentType: DocumentType.OTHER,
          },
        }));
      const fiscalNumber = paid
        ? await consumerInvoiceNumber(tx, tenant.id)
        : { invoiceNumber: 'PEND-' + orderNumber };
      const merchandiseTotal = lines.reduce(
        (sum, item) => sum.add(item.total),
        new Prisma.Decimal(0),
      );
      const headerTotal = new Prisma.Decimal(payload.total_price ?? merchandiseTotal);
      const adjustment = headerTotal.sub(merchandiseTotal).toDecimalPlaces(2);
      const merchandiseSubtotal = lines.reduce(
        (sum, item) => sum.add(item.subtotal),
        new Prisma.Decimal(0),
      );
      const merchandiseTax = lines.reduce((sum, item) => sum.add(item.tax), new Prisma.Decimal(0));
      const invoice = await tx.invoice.create({
        data: {
          tenantId: tenant.id,
          ...fiscalNumber,
          customerId: customer.id,
          status: paid ? InvoiceStatus.PAID : InvoiceStatus.DRAFT,
          subtotal: merchandiseSubtotal.add(adjustment),
          taxTotal: merchandiseTax,
          discountTotal: new Prisma.Decimal(payload.total_discounts || 0),
          total: headerTotal,
          paidAmount: paid ? headerTotal : new Prisma.Decimal(0),
          balance: paid ? new Prisma.Decimal(0) : headerTotal,
          paymentMethod: PaymentMethod.CARD,
          issuedById: membership.userId,
          issuedAt: payload.created_at ? new Date(payload.created_at) : new Date(),
          items: {
            create: [
              ...lines.map((item) => ({
                productId: item.product?.id,
                sku: item.line.sku || item.product?.sku,
                barcode: item.product?.barcode,
                description: item.line.name || item.line.title || 'Producto Shopify',
                externalLineId: String(item.line.id),
                personalization: item.personalization,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                discountTotal: item.discount,
                taxRate: item.taxRate,
                taxTotal: item.tax,
                subtotal: item.subtotal,
                total: item.total,
              })),
              ...(adjustment.isZero()
                ? []
                : [
                    {
                      description: 'Envío y ajustes Shopify',
                      quantity: new Prisma.Decimal(1),
                      unitPrice: adjustment,
                      subtotal: adjustment,
                      taxTotal: new Prisma.Decimal(0),
                      taxRate: new Prisma.Decimal(0),
                      total: adjustment,
                    },
                  ]),
            ],
          },
          ...(paid
            ? {
                payments: {
                  create: {
                    tenantId: tenant.id,
                    method: PaymentMethod.CARD,
                    amount: headerTotal,
                    status: PaymentStatus.COMPLETED,
                    receiptNumber: `SHOPIFY-${externalOrderId}`,
                    userId: membership.userId,
                    paidAt: payload.created_at ? new Date(payload.created_at) : new Date(),
                  },
                },
              }
            : {}),
        },
      });

      const order = await tx.salesOrder.create({
        data: {
          tenantId: tenant.id,
          destination: SalesOrderDestination.CASH_SALE,
          customerId: customer.id,
          clientName,
          orderNumber,
          status: paid ? SalesOrderStatus.COMPLETED : SalesOrderStatus.CREATED,
          source: OrderSource.SHOPIFY,
          externalOrderId,
          promisedAt,
          deliveryMethod: payload.shipping_address
            ? DeliveryMethod.DELIVERY
            : DeliveryMethod.PICKUP,
          dispatchLocation: DispatchLocation.STORE,
          deliveryAddress: deliveryNote || null,
          deliveryPhone: payload.phone ?? payload.customer?.phone ?? null,
          notificationEmail: payload.email ?? payload.customer?.email ?? null,
          requiresProduction: lines.some((item) => item.product?.kind === ProductKind.PERSONALIZED),
          productionNotes: [payload.note, personalization.join('\n'), deliveryNote]
            .filter(Boolean)
            .join('\n'),
          subtotal: invoice.subtotal,
          taxTotal: invoice.taxTotal,
          discountTotal: invoice.discountTotal,
          total: invoice.total,
          createdById: membership.userId,
          completedById: paid ? membership.userId : null,
          completedAt: paid ? new Date() : null,
          invoiceId: invoice.id,
          items: {
            create: lines.map((item) => ({
              productId: item.product?.id,
              sku: item.line.sku || item.product?.sku,
              barcode: item.product?.barcode,
              description: item.line.name || item.line.title || 'Producto Shopify',
              externalLineId: String(item.line.id),
              personalization: item.personalization,
              quantity: item.quantity,
              reservedQuantity: paid || !item.product?.trackInventory ? 0 : item.quantity,
              unitPrice: item.unitPrice,
              discountTotal: item.discount,
              taxRate: item.taxRate,
              taxTotal: item.tax,
              subtotal: item.subtotal,
              total: item.total,
            })),
          },
        },
      });

      for (const item of lines) {
        if (!item.product?.trackInventory) continue;
        if (paid) {
          const consumed = await tx.$queryRaw<Array<{ stock: number }>>`
            UPDATE "Product" SET "stock" = "stock" - ${item.quantity}
            WHERE "id" = ${item.product.id} AND "tenantId" = ${tenant.id}
            AND ("stock" - "reservedStock") >= ${item.quantity} RETURNING "stock"
          `;
          if (!consumed.length)
            throw new BadRequestException('Stock insuficiente para ' + item.product.name);
          await markInventoryChanged(tx, tenant.id, item.product.id);
          await tx.inventoryMovement.create({
            data: {
              tenantId: tenant.id,
              productId: item.product.id,
              type: InventoryMovementType.SALE,
              quantity: item.quantity,
              previousStock: consumed[0].stock + item.quantity,
              newStock: consumed[0].stock,
              invoiceId: invoice.id,
              reason: 'Venta importada desde Shopify',
              reference: orderNumber,
              createdById: membership.userId,
            },
          });
        } else {
          await changeReservation(
            tx,
            tenant.id,
            item.product.id,
            ProductInventoryDestination.SALES_INVENTORY,
            item.quantity,
          );
        }
      }
      return order;
    });

    return {
      received: true,
      duplicate: false,
      webhookId: headers.webhookId ?? null,
      order: created,
    };
  }

  async receiveOrderPaid(
    rawBody: Buffer | undefined,
    payload: ShopifyOrder,
    headers: { hmac?: string; shopDomain?: string; webhookId?: string },
  ) {
    this.verifyWebhook(rawBody, headers.hmac, headers.shopDomain);
    const context = await this.findShopifyOrder(payload.order_id ?? payload.id);
    const duplicate = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "SalesOrder" WHERE "id" = ${context.order.id} FOR UPDATE`;
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: context.order.id },
          include: { items: { include: { product: true } }, invoice: true },
        });
        if (
          order.status === SalesOrderStatus.COMPLETED ||
          order.status === SalesOrderStatus.CANCELLED
        )
          return true;
        for (const item of [...order.items].sort((a, b) =>
          (a.productId ?? '').localeCompare(b.productId ?? ''),
        )) {
          if (!item.productId || !item.product?.trackInventory) continue;
          const quantity = Number(item.quantity);
          const changed = await tx.$queryRaw<Array<{ stock: number }>>`
          UPDATE "Product" SET "stock" = "stock" - ${quantity}, "reservedStock" = "reservedStock" - ${item.reservedQuantity}
          WHERE "id" = ${item.productId} AND "tenantId" = ${context.tenant.id}
          AND "stock" >= ${quantity} AND "reservedStock" >= ${item.reservedQuantity} RETURNING "stock"
        `;
          if (!changed.length)
            throw new BadRequestException('Stock insuficiente para ' + item.description);
          await tx.inventoryMovement.create({
            data: {
              tenantId: context.tenant.id,
              productId: item.productId,
              type: InventoryMovementType.SALE,
              quantity,
              previousStock: changed[0].stock + quantity,
              newStock: changed[0].stock,
              invoiceId: order.invoiceId,
              reference: order.orderNumber,
              reason: 'Pago Shopify',
              createdById: order.createdById,
            },
          });
          await markInventoryChanged(tx, context.tenant.id, item.productId);
        }
        if (!order.invoiceId) throw new BadRequestException('La orden Shopify no tiene factura.');
        const number = await consumerInvoiceNumber(tx, context.tenant.id);
        await tx.invoice.update({
          where: { id: order.invoiceId },
          data: {
            ...number,
            status: InvoiceStatus.PAID,
            paidAmount: order.total,
            balance: 0,
            payments: {
              create: {
                tenantId: context.tenant.id,
                method: PaymentMethod.CARD,
                amount: order.total,
                status: PaymentStatus.COMPLETED,
                receiptNumber: 'SHOPIFY-' + order.externalOrderId,
                userId: order.createdById,
                paidAt: new Date(),
              },
            },
          },
        });
        await tx.salesOrderItem.updateMany({
          where: { salesOrderId: order.id },
          data: { reservedQuantity: 0 },
        });
        await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            status: SalesOrderStatus.COMPLETED,
            completedById: order.createdById,
            completedAt: new Date(),
          },
        });
        return false;
      },
      { timeout: 30000 },
    );
    return { received: true, duplicate, orderId: context.order.id };
  }

  async receiveOrderCancelled(
    rawBody: Buffer | undefined,
    payload: ShopifyOrder,
    headers: { hmac?: string; shopDomain?: string; webhookId?: string },
  ) {
    this.verifyWebhook(rawBody, headers.hmac, headers.shopDomain);
    const context = await this.findShopifyOrder(payload.order_id ?? payload.id);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "SalesOrder" WHERE "id" = ${context.order.id} FOR UPDATE`;
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: context.order.id },
          include: { items: true, invoice: true },
        });
        if (order.status === SalesOrderStatus.CANCELLED) return { duplicate: true };
        const paid = order.status === SalesOrderStatus.COMPLETED;
        if (!paid) {
          for (const item of order.items)
            if (item.productId && item.reservedQuantity > 0)
              await changeReservation(
                tx,
                context.tenant.id,
                item.productId,
                order.inventorySource,
                -item.reservedQuantity,
              );
          if (order.invoiceId)
            await tx.invoice.update({
              where: { id: order.invoiceId },
              data: { status: InvoiceStatus.CANCELLED, balance: 0 },
            });
        }
        // Shopify refunds specify exactly which units are restocked. Cancelling alone never restocks paid units.
        await tx.salesOrderItem.updateMany({
          where: { salesOrderId: order.id },
          data: { reservedQuantity: 0 },
        });
        await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            status: SalesOrderStatus.CANCELLED,
            exceptionStatus: OrderExceptionStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelReason: 'Cancelada desde Shopify',
            productionNotes: [
              order.productionNotes,
              paid
                ? 'Cancelada; reembolso e inventario se concilian con el evento de devolución Shopify.'
                : null,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        });
        await tx.orderWorkflowEvent.create({
          data: {
            tenantId: context.tenant.id,
            salesOrderId: order.id,
            toStage: order.productionStage,
            fromStage: order.productionStage,
            exceptionStatus: OrderExceptionStatus.CANCELLED,
            changedById: order.createdById,
            note: 'Cancelación Shopify',
          },
        });
        return { duplicate: false };
      },
      { timeout: 30000 },
    );
    return { received: true, ...result, orderId: context.order.id };
  }

  async receiveRefund(
    rawBody: Buffer | undefined,
    payload: ShopifyOrder,
    headers: { hmac?: string; shopDomain?: string; webhookId?: string },
  ) {
    this.verifyWebhook(rawBody, headers.hmac, headers.shopDomain);
    const context = await this.findShopifyOrder(payload.order_id);
    const eventId = 'refund:' + payload.id;
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "SalesOrder" WHERE "id" = ${context.order.id} FOR UPDATE`;
        if (
          await tx.shopifyEvent.findUnique({
            where: { tenantId_eventId: { tenantId: context.tenant.id, eventId } },
          })
        )
          return { duplicate: true };
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: context.order.id },
          include: { invoice: { include: { items: true } }, items: true },
        });
        if (!order.invoice) throw new BadRequestException('La orden no tiene factura.');
        const invoice = order.invoice;
        const returns = [];
        for (const line of payload.refund_line_items ?? []) {
          const item = invoice.items.find(
            (item) => item.externalLineId === String(line.line_item_id),
          );
          if (!item || !Number.isInteger(line.quantity) || line.quantity <= 0)
            throw new BadRequestException('La devolución Shopify contiene líneas inválidas.');
          const already = await tx.returnRequestItem.aggregate({
            where: {
              invoiceItemId: item.id,
              returnRequest: { status: { in: ['REQUESTED', 'APPROVED', 'COMPLETED'] } },
            },
            _sum: { quantity: true },
          });
          if (Number(already._sum.quantity ?? 0) + line.quantity > Number(item.quantity))
            throw new BadRequestException('La devolución excede la cantidad vendida.');
          const ratio = new Prisma.Decimal(line.quantity).div(item.quantity);
          const subtotal = item.subtotal.mul(ratio).toDecimalPlaces(2);
          const taxTotal = item.taxTotal.mul(ratio).toDecimalPlaces(2);
          const restock =
            ['return', 'cancel'].includes(line.restock_type ?? '') && Boolean(order.completedAt);
          returns.push({
            invoiceItemId: item.id,
            productId: item.productId,
            description: item.description,
            quantity: line.quantity,
            unitPrice: item.unitPrice,
            discountTotal: item.discountTotal.mul(ratio),
            taxRate: item.taxRate,
            subtotal,
            taxTotal,
            total: subtotal.add(taxTotal),
            restock,
          });
          if (restock && item.productId) {
            const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
            if (product.trackInventory) {
              const updated = await tx.product.update({
                where: { id: product.id },
                data: { stock: { increment: line.quantity } },
              });
              await tx.inventoryMovement.create({
                data: {
                  tenantId: context.tenant.id,
                  productId: product.id,
                  type: InventoryMovementType.RETURN,
                  quantity: line.quantity,
                  previousStock: updated.stock - line.quantity,
                  newStock: updated.stock,
                  invoiceId: invoice.id,
                  reference: eventId,
                  reason: 'Reembolso Shopify',
                  createdById: order.createdById,
                },
              });
              await markInventoryChanged(tx, context.tenant.id, product.id);
            }
          }
        }
        const transactions = (payload.transactions ?? []).filter(
          (t) => t.kind === 'refund' && t.status === 'success',
        );
        const amount = transactions.length
          ? transactions.reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0))
          : returns.reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
        if (amount.lt(0) || amount.gt(invoice.paidAmount.add(invoice.balance)))
          throw new BadRequestException('Importe de reembolso inválido.');
        const credit = Prisma.Decimal.min(amount, invoice.balance);
        const cashRefund = amount.sub(credit);
        const balance = invoice.balance.sub(credit);
        const paidAmount = invoice.paidAmount.sub(cashRefund);
        await tx.returnRequest.create({
          data: {
            tenantId: context.tenant.id,
            invoiceId: invoice.id,
            requestedById: order.createdById,
            approvedById: order.createdById,
            status: 'COMPLETED',
            reason: 'Reembolso confirmado por Shopify',
            refundReference: eventId,
            refundMethod: PaymentMethod.CARD,
            refundAmount: amount,
            creditAppliedAmount: credit,
            cashRefundAmount: cashRefund,
            debtBefore: invoice.balance,
            debtAfter: balance,
            paidAmountBefore: invoice.paidAmount,
            paidAmountAfter: paidAmount,
            approvedAt: new Date(),
            completedAt: new Date(),
            restockDestination: ProductInventoryDestination.SALES_INVENTORY,
            items: { create: returns },
          },
        });
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            balance,
            paidAmount,
            status:
              paidAmount.isZero() && balance.isZero()
                ? InvoiceStatus.CREDITED
                : balance.isZero()
                  ? InvoiceStatus.PAID
                  : InvoiceStatus.PARTIALLY_PAID,
          },
        });
        await tx.shopifyEvent.create({
          data: { tenantId: context.tenant.id, eventId, type: 'REFUND' },
        });
        await tx.orderWorkflowEvent.create({
          data: {
            tenantId: context.tenant.id,
            salesOrderId: order.id,
            fromStage: order.productionStage,
            toStage: order.productionStage,
            changedById: order.createdById,
            note: 'Reembolso Shopify registrado: ' + amount.toFixed(2),
          },
        });
        return { duplicate: false };
      },
      { timeout: 30000 },
    );
    return { received: true, ...result, orderId: context.order.id };
  }

  async receiveOrderUpdated(
    rawBody: Buffer | undefined,
    payload: ShopifyOrder,
    headers: { hmac?: string; shopDomain?: string; webhookId?: string },
  ) {
    this.verifyWebhook(rawBody, headers.hmac, headers.shopDomain);
    const context = await this.findShopifyOrder(payload.id);
    if (context.order.status === SalesOrderStatus.CANCELLED)
      return { received: true, ignored: true };
    const unchanged =
      payload.line_items?.length === context.order.items.length &&
      payload.line_items?.every((line) =>
        context.order.items.some(
          (item) =>
            item.externalLineId === String(line.id) && Number(item.quantity) === line.quantity,
        ),
      );
    if (!unchanged || (payload.total_price && !context.order.total.eq(payload.total_price))) {
      await this.flagShopifyReview(
        context.order.id,
        'Shopify modificó productos o importes. Revisar la diferencia antes de producir/despachar.',
      );
      return { received: true, manualReview: true };
    }
    await this.prisma.salesOrder.update({
      where: { id: context.order.id },
      data: {
        deliveryAddress: payload.shipping_address
          ? Object.values(payload.shipping_address).filter(Boolean).join(', ')
          : undefined,
        deliveryPhone: payload.phone ?? payload.customer?.phone,
      },
    });
    return { received: true };
  }

  private linePersonalization(properties: Array<{ name: string; value: string }> = []) {
    const result: Record<string, string | number> = {};
    const extra: string[] = [];
    for (const property of properties) {
      const key = property.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
      if (['dijes', 'charms', 'ninos', 'children'].includes(key)) {
        const value = Number(property.value);
        if (Number.isInteger(value) && value >= 0)
          result[['dijes', 'charms'].includes(key) ? 'charms' : 'children'] = value;
      } else if (key === 'material') result.material = property.value;
      else if (property.value) extra.push(property.name + ': ' + property.value);
    }
    if (extra.length) result.instructions = extra.join('; ');
    return result;
  }

  async syncProduct(tenantId: string, productId: string) {
    if (this.syncDisabled()) {
      throw new ServiceUnavailableException('La sincronización con Shopify está desactivada (SHOPIFY_SYNC_DISABLED).');
    }
    let product = await this.prisma.product.findFirstOrThrow({
      where: { id: productId, tenantId },
    });
    const job = await this.prisma.inventorySyncJob.upsert({
      where: { tenantId_productId: { tenantId, productId } },
      create: { tenantId, productId },
      update: {},
    });
    const settings = await this.graphql(
      'query StoreSettings { shop { currencyCode taxesIncluded } }',
      {},
    );
    if (settings.shop.currencyCode !== 'DOP')
      throw new BadRequestException('La moneda principal Shopify debe ser DOP.');
    const basePrice = product.salePrice.gt(0) ? product.salePrice : product.price;
    const remotePrice = settings.shop.taxesIncluded
      ? basePrice.mul(new Prisma.Decimal(1).add(product.taxRate)).toDecimalPlaces(2)
      : basePrice;
    let variantId = product.shopifyVariantId;
    let shopifyProductId = product.shopifyProductId;
    let inventoryItemId = product.shopifyInventoryItemId;
    if (!variantId && product.sku) {
      const lookup = await this.graphql(
        'query FindVariant($query: String!) { productVariants(first: 20, query: $query) { nodes { id sku product { id } inventoryItem { id } } } }',
        { query: 'sku:' + JSON.stringify(product.sku) },
      );
      const matches = lookup.productVariants.nodes.filter((v: any) => v.sku === product.sku);
      if (matches.length > 1)
        throw new BadRequestException(
          'Shopify tiene varias variantes con el mismo SKU. Resuelve la asociación antes de sincronizar.',
        );
      if (matches[0]) {
        variantId = matches[0].id;
        shopifyProductId = matches[0].product.id;
        inventoryItemId = matches[0].inventoryItem.id;
      }
    }
    if (!variantId) {
      const label =
        [product.material, product.measurement].filter(Boolean).join(' · ') || 'Estándar';
      const data = await this.graphql(
        'mutation CreateProduct($input: ProductSetInput!) { productSet(synchronous: true, input: $input) { product { id variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { message } } }',
        {
          input: {
            title: product.name,
            descriptionHtml: product.description ?? '',
            vendor: product.brand ?? 'Unique Personalizado',
            status: product.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
            productOptions: [{ name: 'Variante', values: [{ name: label }] }],
            variants: [
              {
                optionValues: [{ optionName: 'Variante', name: label }],
                price: remotePrice.toFixed(2),
                taxable: product.taxRate.gt(0),
                barcode: product.barcode,
                inventoryItem: { sku: product.sku, tracked: product.trackInventory },
              },
            ],
          },
        },
      );
      shopifyProductId = data.productSet.product.id;
      variantId = data.productSet.product.variants.nodes[0].id;
      inventoryItemId = data.productSet.product.variants.nodes[0].inventoryItem.id;
    } else {
      await this.graphql(
        'mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id inventoryItem { id } } userErrors { message } } }',
        {
          productId: shopifyProductId,
          variants: [
            {
              id: variantId,
              price: remotePrice.toFixed(2),
              taxable: product.taxRate.gt(0),
              barcode: product.barcode,
              inventoryItem: { sku: product.sku, tracked: product.trackInventory },
            },
          ],
        },
      );
    }
    // Persist association before later remote steps: retry never recreates a product.
    await this.prisma.product.update({
      where: { id: productId },
      data: {
        shopifyProductId,
        shopifyVariantId: variantId,
        shopifyInventoryItemId: inventoryItemId,
      },
    });
    const parent = await this.graphql(
      'query ProductInfo($id: ID!) { product(id: $id) { variantsCount { count } } }',
      { id: shopifyProductId },
    );
    if (parent.product?.variantsCount.count === 1) {
      await this.graphql(
        'mutation UpdateProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) { product { id } userErrors { message } } }',
        {
          product: {
            id: shopifyProductId,
            title: product.name,
            descriptionHtml: product.description ?? '',
            status: product.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
          },
          media:
            product.imageUrl && !product.shopifySyncedAt && /^https:\/\//.test(product.imageUrl)
              ? [{ originalSource: product.imageUrl, mediaContentType: 'IMAGE', alt: product.name }]
              : undefined,
        },
      );
    }
    if (product.trackInventory && inventoryItemId) {
      const locationId = this.config.get<string>('SHOPIFY_LOCATION_ID');
      const inventory = await this.graphql(
        'query Inventory($id: ID!, $location: ID!) { inventoryItem(id: $id) { inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } }',
        { id: inventoryItemId, location: locationId },
      );
      let level = inventory.inventoryItem.inventoryLevel;
      if (!level) {
        const activation = await this.graphql(
          'mutation Activate($item: ID!, $location: ID!) { inventoryActivate(inventoryItemId: $item, locationId: $location) { inventoryLevel { quantities(names: ["available"]) { quantity } } userErrors { message } } }',
          { item: inventoryItemId, location: locationId },
        );
        level = activation.inventoryActivate.inventoryLevel;
      }
      product = await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });
      await this.graphql(
        'mutation SetStock($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { createdAt } userErrors { message } } }',
        {
          key: randomUUID(),
          input: {
            name: 'available',
            reason: 'correction',
            referenceDocumentUri: 'corestack://inventory/' + productId,
            quantities: [
              {
                inventoryItemId,
                locationId,
                quantity:
                  product.status === 'ACTIVE'
                    ? Math.max(Math.floor(product.stock - product.reservedStock), 0)
                    : 0,
                compareQuantity: level.quantities[0]?.quantity ?? 0,
              },
            ],
          },
        },
      );
    }
    await this.prisma.inventorySyncJob.updateMany({
      where: { id: job.id, revision: job.revision },
      data: { pending: false, error: null, attempts: 0 },
    });
    return this.prisma.product.update({
      where: { id: productId },
      data: { shopifySyncedAt: new Date() },
    });
  }

  async processPending(tenantId?: string) {
    if (!this.isConfigured() || this.processing)
      return { configured: this.isConfigured(), processed: 0 };
    this.processing = true;
    let processed = 0;
    try {
      const jobs = await this.prisma.inventorySyncJob.findMany({
        where: { pending: true, ...(tenantId ? { tenantId } : {}) },
        orderBy: { updatedAt: 'asc' },
        take: 20,
      });
      for (const job of jobs) {
        try {
          await this.syncProduct(job.tenantId, job.productId);
          processed++;
        } catch (error) {
          await this.prisma.inventorySyncJob.update({
            where: { id: job.id },
            data: {
              attempts: { increment: 1 },
              error:
                error instanceof Error ? error.message.slice(0, 1000) : 'Error de sincronización',
            },
          });
        }
      }
      const orders = await this.prisma.salesOrder.findMany({
        where: {
          ...(tenantId ? { tenantId } : {}),
          source: OrderSource.SHOPIFY,
          productionStage: 'DELIVERED',
          status: SalesOrderStatus.COMPLETED,
          shopifyFulfillmentSyncedAt: null,
          externalOrderId: { not: { startsWith: 'IMPORT:' } },
        },
        take: 10,
      });
      for (const order of orders) {
        try {
          await this.syncFulfillment(order.id);
        } catch (error) {
          await this.prisma.salesOrder.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentError:
                error instanceof Error ? error.message.slice(0, 1000) : 'Error de despacho Shopify',
            },
          });
        }
      }
      return { configured: true, processed };
    } finally {
      this.processing = false;
    }
  }

  async integrationStatus(tenantId: string) {
    return {
      configured: this.isConfigured(),
      jobs: await this.prisma.inventorySyncJob.findMany({
        where: { tenantId },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      dispatchErrors: await this.prisma.salesOrder.findMany({
        where: { tenantId, shopifyFulfillmentError: { not: null } },
        select: { id: true, orderNumber: true, shopifyFulfillmentError: true },
      }),
    };
  }

  private async syncFulfillment(orderId: string) {
    const order = await this.prisma.salesOrder.findUniqueOrThrow({ where: { id: orderId } });
    const remote = await this.graphql(
      'query FulfillmentOrders($id: ID!) { order(id: $id) { fulfillmentOrders(first: 50) { nodes { id status assignedLocation { location { id } } } } } }',
      { id: 'gid://shopify/Order/' + order.externalOrderId },
    );
    const open = remote.order.fulfillmentOrders.nodes.filter(
      (item: any) =>
        ['OPEN', 'IN_PROGRESS'].includes(item.status) &&
        item.assignedLocation.location?.id === this.config.get<string>('SHOPIFY_LOCATION_ID'),
    );
    for (const item of open) {
      await this.graphql(
        'mutation Fulfill($input: FulfillmentInput!) { fulfillmentCreate(fulfillment: $input) { fulfillment { id } userErrors { message } } }',
        {
          input: {
            notifyCustomer: false,
            lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: item.id }],
          },
        },
      );
    }
    if (
      !open.length &&
      remote.order.fulfillmentOrders.nodes.some(
        (item: any) => item.status !== 'CLOSED' && item.status !== 'CANCELLED',
      )
    )
      throw new BadRequestException(
        'Shopify tiene entregas pendientes en otra ubicación o bloqueadas.',
      );
    await this.prisma.salesOrder.update({
      where: { id: orderId },
      data: { shopifyFulfillmentSyncedAt: new Date(), shopifyFulfillmentError: null },
    });
  }

  private async graphql(query: string, variables: Record<string, unknown>) {
    const domain = this.config.get<string>('SHOPIFY_STORE_DOMAIN')?.trim().toLowerCase();
    const token = this.config.get<string>('SHOPIFY_ADMIN_ACCESS_TOKEN')?.trim();
    if (!domain || !token || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))
      throw new ServiceUnavailableException('Shopify está pendiente de configurar.');
    const version = this.config.get<string>('SHOPIFY_API_VERSION', '2026-10');
    const response = await fetch('https://' + domain + '/admin/api/' + version + '/graphql.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await response.json()) as any;
    const errors =
      json.errors ??
      Object.values(json.data ?? {}).flatMap((value: any) => value?.userErrors ?? []);
    if (!response.ok || errors.length)
      throw new BadRequestException(errors[0]?.message ?? 'Shopify no confirmó la operación.');
    return json.data;
  }

  private async findShopifyOrder(payloadId: number | string | undefined) {
    if (!payloadId) throw new BadRequestException('Shopify no indicó la orden relacionada.');
    const tenantSlug = this.config.get<string>('SHOPIFY_TENANT_SLUG', 'unique-personalizado');
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new ServiceUnavailableException('El tenant de Shopify no está configurado.');
    const order = await this.prisma.salesOrder.findUnique({
      where: {
        tenantId_source_externalOrderId: {
          tenantId: tenant.id,
          source: OrderSource.SHOPIFY,
          externalOrderId: String(payloadId),
        },
      },
      include: {
        items: { include: { product: true } },
        invoice: { include: { payments: true } },
      },
    });
    if (!order) throw new NotFoundException('La orden Shopify todavía no existe en CoreStack.');
    return { tenant, order };
  }

  private async flagShopifyReview(orderId: string, note: string) {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: { productionNotes: true },
    });
    if (order?.productionNotes?.includes(note)) return;
    await this.prisma.salesOrder.update({
      where: { id: orderId },
      data: {
        exceptionStatus: OrderExceptionStatus.PROBLEM,
        productionNotes: [order?.productionNotes, note].filter(Boolean).join('\n'),
      },
    });
  }

  private verifyWebhook(rawBody?: Buffer, providedHmac?: string, shopDomain?: string) {
    const secret = this.config.get<string>('SHOPIFY_CLIENT_SECRET')?.trim();
    const expectedDomain = this.config.get<string>('SHOPIFY_STORE_DOMAIN')?.trim().toLowerCase();
    if (!secret || !expectedDomain)
      throw new ServiceUnavailableException('Shopify no está configurado.');
    if (!rawBody || !providedHmac || shopDomain?.toLowerCase() !== expectedDomain) {
      throw new UnauthorizedException('Webhook de Shopify no autorizado.');
    }
    const calculated = createHmac('sha256', secret).update(rawBody).digest('base64');
    const provided = Buffer.from(providedHmac, 'utf8');
    const expected = Buffer.from(calculated, 'utf8');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Firma de Shopify inválida.');
    }
  }

  private resolvePromisedAt(attributes: ShopifyOrder['note_attributes']) {
    const configured = attributes?.find((attribute) =>
      ['promised_date', 'fecha_prometida'].includes(attribute.name.toLowerCase()),
    )?.value;
    if (configured && /^\d{4}-\d{2}-\d{2}$/.test(configured)) {
      return new Date(`${configured}T12:00:00.000Z`);
    }
    const days = Number(this.config.get<string>('SHOPIFY_DEFAULT_PROMISE_DAYS', '3')) || 3;
    return new Date(Date.now() + days * 86_400_000);
  }
}

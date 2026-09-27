import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BarcodeType,
  Prisma,
  ProductInventoryDestination,
  ProductStatus,
  ProductUnit,
  SalesOrderStatus,
  TaxCategory,
  WarehouseMovementType,
} from '@qorvex/database';
import { normalizeBarcodeInput } from '../../common/utils/barcode';
import { PrismaService } from '../../prisma/prisma.service';
import { DispatchWarehouseProductDto } from './dto/dispatch-warehouse-product.dto';
import { CreateWarehouseProductDto, UpdateWarehouseProductDto } from './dto/warehouse-product.dto';
import {
  ConfirmWarehouseDispatchDto,
  CountWarehouseStockDto,
  ReceiveWarehouseBatchDto,
  ReceiveWarehouseStockDto,
} from './dto/warehouse-stock-movement.dto';

const internalBarcodePrefix = 'QV';

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  findStock(tenantId: string) {
    return this.prisma.warehouseStock.findMany({
      where: { tenantId },
      include: {
        product: {
          include: {
            category: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ quantity: 'desc' }, { product: { name: 'asc' } }],
    });
  }

  findProducts(tenantId: string) {
    return this.prisma.product.findMany({
      where: { tenantId, inventoryDestination: ProductInventoryDestination.WAREHOUSE },
      include: {
        warehouseStocks: {
          where: { tenantId },
          select: { id: true, quantity: true, unitCost: true, updatedAt: true },
        },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  async createProduct(tenantId: string, userId: string, dto: CreateWarehouseProductDto) {
    const sku = dto.sku?.trim() || null;
    const barcodeWasGenerated = !dto.barcode?.trim();
    const barcode = barcodeWasGenerated
      ? await this.generateInternalBarcode(tenantId)
      : normalizeBarcodeInput(dto.barcode!);
    await this.ensureUniqueCodes(tenantId, sku, barcode);

    const initialQuantity = dto.initialQuantity ?? 0;
    const cost = dto.cost === undefined ? null : new Prisma.Decimal(dto.cost);
    this.ensureCompatibleQuantity(dto.unit ?? ProductUnit.UNIT, initialQuantity);
    const salePrice = new Prisma.Decimal(dto.salePrice);
    const taxCategory = dto.taxCategory ?? TaxCategory.ITBIS_18;
    const taxRate = this.taxRateForCategory(taxCategory);
    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          tenantId,
          name: dto.name.trim(),
          sku,
          barcode,
          barcodeType: barcodeWasGenerated ? BarcodeType.INTERNAL_CODE128 : BarcodeType.CODE128,
          generatedBarcode: barcodeWasGenerated,
          barcodeCreatedById: barcodeWasGenerated ? userId : null,
          brand: dto.brand?.trim() || null,
          description: dto.description?.trim() || null,
          unit: dto.unit ?? ProductUnit.UNIT,
          price: salePrice,
          salePrice,
          cost,
          taxCategory,
          taxRate,
          trackInventory: false,
          inventoryDestination: ProductInventoryDestination.WAREHOUSE,
          stock: 0,
          minStock: dto.minStock ?? 0,
          status: ProductStatus.ACTIVE,
        },
      });

      await tx.warehouseStock.create({
        data: { tenantId, productId: created.id, quantity: initialQuantity, unitCost: cost },
      });

      if (initialQuantity > 0) {
        await tx.warehouseMovement.create({
          data: {
            tenantId,
            productId: created.id,
            type: WarehouseMovementType.ADJUSTMENT_IN,
            quantity: initialQuantity,
            previousQuantity: 0,
            newQuantity: initialQuantity,
            unitCost: cost,
            reason: 'Existencia inicial de producto de almacén',
            reference: `WAREHOUSE-PRODUCT-${created.id}`,
            createdById: userId,
          },
        });
      }

      return created;
    });

    return product;
  }

  async updateProduct(
    tenantId: string,
    _userId: string,
    id: string,
    dto: UpdateWarehouseProductDto,
  ) {
    await this.getWarehouseProduct(tenantId, id);
    const sku = dto.sku === undefined ? undefined : dto.sku.trim() || null;
    const barcode =
      dto.barcode === undefined
        ? undefined
        : dto.barcode.trim()
          ? normalizeBarcodeInput(dto.barcode)
          : null;
    await this.ensureUniqueCodes(tenantId, sku, barcode, id);

    return this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        sku,
        barcode,
        barcodeType: barcode === undefined ? undefined : barcode ? BarcodeType.CODE128 : null,
        generatedBarcode: barcode === undefined ? undefined : false,
        barcodeCreatedById: barcode === undefined ? undefined : null,
        brand: dto.brand === undefined ? undefined : dto.brand.trim() || null,
        description: dto.description === undefined ? undefined : dto.description.trim() || null,
        unit: dto.unit,
        cost: dto.cost === undefined ? undefined : new Prisma.Decimal(dto.cost),
        price: dto.salePrice === undefined ? undefined : new Prisma.Decimal(dto.salePrice),
        salePrice: dto.salePrice === undefined ? undefined : new Prisma.Decimal(dto.salePrice),
        taxCategory: dto.taxCategory,
        taxRate:
          dto.taxCategory === undefined ? undefined : this.taxRateForCategory(dto.taxCategory),
        minStock: dto.minStock,
      },
    });
  }

  async removeProduct(tenantId: string, _userId: string, id: string) {
    await this.getWarehouseProduct(tenantId, id);
    const stock = await this.prisma.warehouseStock.findUnique({
      where: { tenantId_productId: { tenantId, productId: id } },
      select: { quantity: true },
    });
    if ((stock?.quantity ?? 0) > 0) {
      throw new BadRequestException(
        'No puedes desactivar un producto con existencia. Ajusta su inventario a cero primero.',
      );
    }
    return this.prisma.product.update({
      where: { id },
      data: { status: ProductStatus.INACTIVE },
    });
  }

  async activateProduct(tenantId: string, id: string) {
    await this.getWarehouseProduct(tenantId, id);
    return this.prisma.product.update({
      where: { id },
      data: { status: ProductStatus.ACTIVE },
    });
  }

  async receiveStock(tenantId: string, userId: string, id: string, dto: ReceiveWarehouseStockDto) {
    const product = await this.getActiveWarehouseProduct(tenantId, id);
    this.ensureCompatibleQuantity(product.unit, dto.quantity);
    const unitCost = dto.unitCost === undefined ? product.cost : new Prisma.Decimal(dto.unitCost);

    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.warehouseStock.findUnique({
        where: { tenantId_productId: { tenantId, productId: id } },
      });
      const previousQuantity = previous?.quantity ?? 0;
      const stock = await tx.warehouseStock.upsert({
        where: { tenantId_productId: { tenantId, productId: id } },
        create: { tenantId, productId: id, quantity: dto.quantity, unitCost },
        update: {
          quantity: { increment: dto.quantity },
          ...(unitCost ? { unitCost } : {}),
        },
      });
      if (dto.unitCost !== undefined) {
        await tx.product.update({ where: { id }, data: { cost: unitCost } });
      }
      await tx.warehouseMovement.create({
        data: {
          tenantId,
          productId: id,
          type: WarehouseMovementType.MANUAL_RECEIPT,
          quantity: dto.quantity,
          previousQuantity,
          newQuantity: stock.quantity,
          unitCost,
          reference: dto.reference.trim(),
          reason: dto.reason.trim(),
          createdById: userId,
        },
      });
      return { product, stock };
    });
  }

  async receiveStockBatch(tenantId: string, userId: string, dto: ReceiveWarehouseBatchDto) {
    const quantities = new Map<string, number>();
    for (const item of dto.items) {
      if (quantities.has(item.productId)) {
        throw new BadRequestException('El lote contiene productos duplicados.');
      }
      quantities.set(item.productId, item.quantity);
    }

    const productIds = [...quantities.keys()].sort();
    const products = await this.prisma.product.findMany({
      where: {
        tenantId,
        id: { in: productIds },
        inventoryDestination: ProductInventoryDestination.WAREHOUSE,
        status: ProductStatus.ACTIVE,
      },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException('Uno o más productos no están activos en el almacén.');
    }

    for (const product of products) {
      this.ensureCompatibleQuantity(product.unit, quantities.get(product.id)!);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Product"
        WHERE "tenantId" = ${tenantId}
          AND "id" IN (${Prisma.join(productIds)})
        ORDER BY "id"
        FOR UPDATE
      `;

      for (const product of products.sort((left, right) => left.id.localeCompare(right.id))) {
        const quantity = quantities.get(product.id)!;
        const previous = await tx.warehouseStock.findUnique({
          where: { tenantId_productId: { tenantId, productId: product.id } },
        });
        const previousQuantity = previous?.quantity ?? 0;
        const stock = await tx.warehouseStock.upsert({
          where: { tenantId_productId: { tenantId, productId: product.id } },
          create: {
            tenantId,
            productId: product.id,
            quantity,
            unitCost: product.cost,
          },
          update: { quantity: { increment: quantity } },
        });
        await tx.warehouseMovement.create({
          data: {
            tenantId,
            productId: product.id,
            type: WarehouseMovementType.MANUAL_RECEIPT,
            quantity,
            previousQuantity,
            newQuantity: stock.quantity,
            unitCost: stock.unitCost,
            reference: dto.reference.trim(),
            reason: dto.reason.trim(),
            createdById: userId,
          },
        });
      }

      return { receivedProducts: products.length };
    });
  }

  async countStock(tenantId: string, userId: string, id: string, dto: CountWarehouseStockDto) {
    const product = await this.getActiveWarehouseProduct(tenantId, id);
    this.ensureCompatibleQuantity(product.unit, dto.countedQuantity);

    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.warehouseStock.findUnique({
        where: { tenantId_productId: { tenantId, productId: id } },
      });
      const previousQuantity = previous?.quantity ?? 0;
      if (Math.abs(previousQuantity - dto.countedQuantity) < 1e-9) {
        throw new BadRequestException('La existencia contada es igual a la registrada.');
      }
      const stock = await tx.warehouseStock.upsert({
        where: { tenantId_productId: { tenantId, productId: id } },
        create: { tenantId, productId: id, quantity: dto.countedQuantity, unitCost: product.cost },
        update: { quantity: dto.countedQuantity },
      });
      await tx.warehouseMovement.create({
        data: {
          tenantId,
          productId: id,
          type: WarehouseMovementType.STOCK_COUNT,
          quantity: Math.abs(dto.countedQuantity - previousQuantity),
          previousQuantity,
          newQuantity: stock.quantity,
          unitCost: stock.unitCost,
          reference: dto.reference?.trim() || null,
          reason: dto.reason.trim(),
          createdById: userId,
        },
      });
      return { product, stock };
    });
  }

  async dispatchProduct(
    tenantId: string,
    userId: string,
    id: string,
    dto: DispatchWarehouseProductDto,
  ) {
    const product = await this.getActiveWarehouseProduct(tenantId, id);
    this.ensureCompatibleQuantity(product.unit, dto.quantity);

    const relatedOrder = await this.prisma.salesOrder.findFirst({
      where: {
        tenantId,
        OR: [
          { orderNumber: { equals: dto.reference.trim(), mode: 'insensitive' } },
          { invoice: { invoiceNumber: { equals: dto.reference.trim(), mode: 'insensitive' } } },
        ],
      },
      select: { id: true },
    });
    if (relatedOrder) {
      throw new BadRequestException(
        'Las órdenes B2B se entregan desde Pendientes de entrega y no como salida manual.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const stock = await tx.warehouseStock.findUnique({
        where: { tenantId_productId: { tenantId, productId: id } },
      });

      if (!stock || stock.quantity <= 0) {
        throw new BadRequestException('El producto no tiene existencia disponible en almacén.');
      }

      const updated = await tx.warehouseStock.updateMany({
        where: { id: stock.id, tenantId, quantity: { gte: dto.quantity } },
        data: { quantity: { decrement: dto.quantity } },
      });

      if (updated.count !== 1) {
        throw new BadRequestException(
          `No hay existencia suficiente. Disponible: ${stock.quantity}.`,
        );
      }

      const nextStock = await tx.warehouseStock.findUniqueOrThrow({ where: { id: stock.id } });
      await tx.warehouseMovement.create({
        data: {
          tenantId,
          productId: id,
          type: WarehouseMovementType.MANUAL_DISPATCH,
          quantity: dto.quantity,
          previousQuantity: nextStock.quantity + dto.quantity,
          newQuantity: nextStock.quantity,
          unitCost: nextStock.unitCost,
          reason: dto.reason.trim(),
          reference: dto.reference.trim(),
          createdById: userId,
        },
      });

      return { product, stock: nextStock };
    });
  }

  async findPendingDispatches(tenantId: string) {
    const [orders, dispatchedReferences] = await Promise.all([
      this.prisma.salesOrder.findMany({
        where: {
          tenantId,
          inventorySource: ProductInventoryDestination.WAREHOUSE,
          status: SalesOrderStatus.COMPLETED,
          invoiceId: { not: null },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          invoice: { select: { id: true, invoiceNumber: true, status: true, total: true } },
          items: {
            select: {
              id: true,
              productId: true,
              sku: true,
              barcode: true,
              description: true,
              quantity: true,
            },
          },
        },
        orderBy: { completedAt: 'asc' },
        take: 100,
      }),
      this.prisma.warehouseMovement.findMany({
        where: { tenantId, type: WarehouseMovementType.DISPATCH, reference: { not: null } },
        select: { reference: true },
        distinct: ['reference'],
      }),
    ]);
    const completed = new Set(
      dispatchedReferences.flatMap((item) => (item.reference ? [item.reference] : [])),
    );
    return orders.filter((order) => !completed.has(order.orderNumber));
  }

  async confirmOrderDispatch(
    tenantId: string,
    userId: string,
    orderId: string,
    dto: ConfirmWarehouseDispatchDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const lockedOrder = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "SalesOrder"
        WHERE "id" = ${orderId}
          AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (lockedOrder.length !== 1) {
        throw new NotFoundException('La orden pagada no está disponible para despacho.');
      }

      const order = await tx.salesOrder.findFirst({
        where: {
          id: orderId,
          tenantId,
          inventorySource: ProductInventoryDestination.WAREHOUSE,
          status: SalesOrderStatus.COMPLETED,
          invoiceId: { not: null },
        },
        include: { items: true, invoice: { select: { invoiceNumber: true } } },
      });
      if (!order) {
        throw new NotFoundException('La orden pagada no está disponible para despacho.');
      }
      const existing = await tx.warehouseMovement.findFirst({
        where: { tenantId, type: WarehouseMovementType.DISPATCH, reference: order.orderNumber },
        select: { id: true },
      });
      if (existing) throw new ConflictException('Esta orden ya fue entregada.');

      if (order.items.some((item) => !item.productId)) {
        throw new BadRequestException(
          'La orden contiene líneas sin producto y requiere revisión antes del despacho.',
        );
      }

      const confirmedByItem = new Map<string, number>();
      for (const item of dto.items) {
        if (confirmedByItem.has(item.orderItemId)) {
          throw new BadRequestException('La verificación contiene líneas duplicadas.');
        }
        confirmedByItem.set(item.orderItemId, item.quantity);
      }

      const verificationIsComplete =
        confirmedByItem.size === order.items.length &&
        order.items.every((item) => {
          const confirmedQuantity = confirmedByItem.get(item.id);
          return (
            confirmedQuantity !== undefined &&
            Math.abs(confirmedQuantity - item.quantity.toNumber()) < 0.0005
          );
        });
      if (!verificationIsComplete) {
        throw new BadRequestException(
          'Debes escanear y completar todas las cantidades de la orden antes de despacharla.',
        );
      }

      const stockRows = await tx.warehouseStock.findMany({
        where: {
          tenantId,
          productId: {
            in: order.items.flatMap((item) => (item.productId ? [item.productId] : [])),
          },
        },
      });
      const stockByProduct = new Map(stockRows.map((stock) => [stock.productId, stock]));
      const movementItems = order.items.filter((item) => item.productId);
      await tx.warehouseMovement.createMany({
        data: movementItems.map((item) => {
          const stock = stockByProduct.get(item.productId!);
          return {
            tenantId,
            productId: item.productId!,
            type: WarehouseMovementType.DISPATCH,
            quantity: item.quantity.toNumber(),
            previousQuantity: stock?.quantity ?? null,
            newQuantity: stock?.quantity ?? null,
            unitCost: stock?.unitCost ?? null,
            reason: dto.note?.trim() || `Entrega de orden pagada ${order.orderNumber}`,
            reference: order.orderNumber,
            createdById: userId,
          };
        }),
      });
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoice?.invoiceNumber,
      };
    });
  }

  findMovements(tenantId: string) {
    return this.prisma.warehouseMovement.findMany({
      where: { tenantId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            barcode: true,
            unit: true,
          },
        },
        createdBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });
  }

  private async getWarehouseProduct(tenantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId, inventoryDestination: ProductInventoryDestination.WAREHOUSE },
    });
    if (!product) {
      throw new NotFoundException('Warehouse product not found for tenant.');
    }
    return product;
  }

  private async getActiveWarehouseProduct(tenantId: string, id: string) {
    const product = await this.getWarehouseProduct(tenantId, id);
    if (product.status !== ProductStatus.ACTIVE) {
      throw new BadRequestException('El producto está inactivo. Reactívalo antes de operar.');
    }
    return product;
  }

  private ensureCompatibleQuantity(unit: ProductUnit, quantity: number) {
    const fractionalUnits: ProductUnit[] = [
      ProductUnit.METER,
      ProductUnit.FOOT,
      ProductUnit.YARD,
      ProductUnit.POUND,
    ];
    if (!fractionalUnits.includes(unit) && !Number.isInteger(quantity)) {
      throw new BadRequestException('La unidad seleccionada requiere cantidades enteras.');
    }
  }

  private taxRateForCategory(category: TaxCategory) {
    if (category === TaxCategory.EXEMPT) return new Prisma.Decimal(0);
    if (category === TaxCategory.ITBIS_16) return new Prisma.Decimal(0.16);
    return new Prisma.Decimal(0.18);
  }

  private async generateInternalBarcode(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true, commercialName: true, name: true },
    });
    const slugParts = tenant.slug.split('-').filter(Boolean);
    const lastSlugPart = slugParts.at(-1) ?? tenant.slug;
    const source = lastSlugPart.length >= 3 ? lastSlugPart : (tenant.commercialName ?? tenant.name);
    const tenantCode = (normalizeCodeSegment(source).replace(/-/g, '') || 'TEN').slice(0, 3);
    const count = await this.prisma.product.count({ where: { tenantId } });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = `${internalBarcodePrefix}-${tenantCode}-${String(count + attempt + 1).padStart(6, '0')}`;
      const existing = await this.prisma.product.findFirst({
        where: { tenantId, barcode: candidate },
        select: { id: true },
      });

      if (!existing) return candidate;
    }

    throw new ConflictException('No se pudo generar un código de barras único.');
  }

  private async ensureUniqueCodes(
    tenantId: string,
    sku: string | null | undefined,
    barcode: string | null | undefined,
    excludeId?: string,
  ) {
    const filters = [...(sku ? [{ sku }] : []), ...(barcode ? [{ barcode }] : [])];
    if (!filters.length) return;

    const existing = await this.prisma.product.findFirst({
      where: { tenantId, OR: filters, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, sku: true, barcode: true },
    });
    if (existing) {
      throw new ConflictException('Product code already exists for this tenant.');
    }
  }
}

function normalizeCodeSegment(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toUpperCase();
}

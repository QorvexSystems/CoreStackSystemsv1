import { randomBytes } from 'node:crypto';
import { markInventoryChanged, changeReservation } from '../../common/utils/stock-reservations';
import { factoryOrder } from '../../common/utils/factory-view';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashSessionStatus,
  CreditApprovalStatus,
  CreditTermOption,
  CustomerCreditStatus,
  CustomerStatus,
  DeliveryMethod,
  DocumentType,
  EmployeeLogAction,
  EmployeeStatus,
  InitialPaymentOption,
  InventoryMovementType,
  PaymentMethod,
  PaymentStatus,
  InvoiceDocumentType,
  InvoiceStatus,
  OrderSource,
  OrderExceptionStatus,
  OrderPriority,
  Prisma,
  ProductKind,
  ProductInventoryDestination,
  ProductStatus,
  ProductUnit,
  ProductionStage,
  Role,
  SalePaymentMode,
  SalesOrderDestination,
  SalesOrderPriceLevel,
  SalesOrderStatus,
} from '@qorvex/database';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import {
  normalizeDominicanDocument,
  validateDominicanCedula,
  validateDominicanRnc,
} from '../../common/utils/dominican-documents';
import { getBarcodeLookupCandidates } from '../../common/utils/barcode';
import {
  addBusinessDays,
  businessDateKey,
  parseBusinessDate,
} from '../../common/utils/business-date';
import { PrismaService } from '../../prisma/prisma.service';
import { collectionProductFilter, countCollections } from '../web-catalog/web-collections';
import {
  AcceptSalesOrderDto,
  CancelSalesOrderDto,
  ClaimSalesOrderDto,
  CreateSalesOrderDto,
  SalesOrderItemDto,
} from './dto/create-sales-order.dto';
import { UpdateOrderWorkflowDto } from './dto/update-order-workflow.dto';
import {
  AddCorporateOrderUnitsDto,
  UpdateCorporateOrderUnitDto,
} from './dto/corporate-order-unit.dto';
import { ResendService } from '../notifications/resend.service';
import { loadProductionBoard } from './production-board.query';
import { readSheet } from 'read-excel-file/node';

const adminRoles: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN];
const openOrderStatuses: SalesOrderStatus[] = [
  SalesOrderStatus.CREATED,
  SalesOrderStatus.SENT_TO_CASHIER,
  SalesOrderStatus.IN_CASHIER,
];
const claimTtlMs = 30 * 60 * 1000;

/** Pedido solicitado desde el e-commerce. Nunca trae precios: se calculan aquí con las reglas del ERP. */
export type ExternalOrderInput = {
  reference: string;
  customer: { name: string; phone: string; email?: string; documentNumber?: string };
  delivery: { method: 'PICKUP' | 'DELIVERY'; address?: string; addressReference?: string };
  notes?: string;
  items: { productId: string; quantity: number; note?: string }[];
};

type ComputedOrderItem = {
  product: Awaited<ReturnType<PrismaService['product']['findMany']>>[number];
  quantity: Prisma.Decimal;
  reservedQuantity: number;
  unitPrice: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  personalization: Prisma.InputJsonValue | undefined;
};

@Injectable()
export class OrdersService {
  private readonly expiredClaimSweepAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resend: ResendService,
  ) {}

  async findAll(tenantId: string, user: AuthenticatedUser, status?: string) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanViewOrders(membership);
    await this.releaseExpiredClaims(tenantId);

    const parsedStatuses = this.parseStatuses(status);
    const destinationFilter =
      status === 'OPEN'
        ? SalesOrderDestination.CASH_SALE
        : status === 'QUOTATION'
          ? SalesOrderDestination.QUOTATION
          : undefined;

    const rows = await this.prisma.salesOrder.findMany({
      where: {
        tenantId,
        ...(membership.role === Role.WAREHOUSE_KEEPER
          ? {
              requiresProduction: true,
              destination: SalesOrderDestination.CASH_SALE,
              productionStage: { in: [ProductionStage.WAITING, ProductionStage.FACTORY] },
            }
          : {}),
        ...(destinationFilter ? { destination: destinationFilter } : {}),
        ...(parsedStatuses ? { status: { in: parsedStatuses } } : {}),
      },
      include: this.orderInclude(),
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 150,
    });
    return membership.role === Role.WAREHOUSE_KEEPER ? rows.map(factoryOrder) : rows;
  }

  async findOne(tenantId: string, user: AuthenticatedUser, id: string) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanViewOrders(membership);

    const order = await this.prisma.salesOrder.findFirst({
      where: { id, tenantId },
      include: this.orderInclude(),
    });

    if (
      !order ||
      (membership.role === Role.WAREHOUSE_KEEPER &&
        (!order.requiresProduction ||
          order.destination !== SalesOrderDestination.CASH_SALE ||
          (order.productionStage !== ProductionStage.WAITING &&
            order.productionStage !== ProductionStage.FACTORY)))
    ) {
      throw new NotFoundException('Sales order not found for tenant.');
    }

    if (
      !adminRoles.includes(membership.role) &&
      membership.role !== Role.CASHIER &&
      membership.role !== Role.WAREHOUSE_KEEPER &&
      !membership.canUsePos &&
      order.createdById !== user.id
    ) {
      throw new ForbiddenException('Employee does not have permission to view this sales order.');
    }

    return membership.role === Role.WAREHOUSE_KEEPER ? factoryOrder(order) : order;
  }

  async getKanban(tenantId: string, user: AuthenticatedUser) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanViewProduction(membership);

    const orders = await loadProductionBoard(
      this.prisma,
      tenantId,
      membership.role === Role.WAREHOUSE_KEEPER,
    );

    return membership.role === Role.WAREHOUSE_KEEPER
      ? orders
          .filter(
            (order) =>
              order.requiresProduction &&
              (order.productionStage === ProductionStage.WAITING ||
                order.productionStage === ProductionStage.FACTORY),
          )
          .map(factoryOrder)
      : orders;
  }

  async updateWorkflow(
    tenantId: string,
    user: AuthenticatedUser,
    id: string,
    dto: UpdateOrderWorkflowDto,
  ) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanManageProduction(membership);

    if (
      membership.role === Role.WAREHOUSE_KEEPER &&
      (dto.requiresProduction !== undefined ||
        dto.priority !== undefined ||
        (dto.stage !== undefined &&
          dto.stage !== ProductionStage.FACTORY &&
          dto.stage !== ProductionStage.READY))
    ) {
      throw new ForbiddenException('Fábrica solo puede iniciar o terminar sus trabajos.');
    }

    if (dto.exceptionStatus === OrderExceptionStatus.CANCELLED) {
      return this.cancel(tenantId, user, id, {
        reason: dto.note?.trim() || 'Cancelación desde producción',
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, id);
      const current = await tx.salesOrder.findFirst({
        where: { id, tenantId },
        include: {
          invoice: true,
          items: { include: { product: { select: { kind: true } } } },
          corporateUnits: { select: { status: true, deliveredAt: true, salesOrderItemId: true } },
        },
      });
      if (!current) throw new NotFoundException('La orden no existe.');

      if (membership.role === Role.WAREHOUSE_KEEPER) {
        if (
          !current.requiresProduction ||
          (current.productionStage !== ProductionStage.WAITING &&
            current.productionStage !== ProductionStage.FACTORY)
        ) {
          throw new ForbiddenException('Este trabajo no está asignado a Fábrica.');
        }
        if (
          (dto.stage === ProductionStage.FACTORY &&
            (current.productionStage !== ProductionStage.WAITING ||
              (current.items.some((item) => item.product?.kind === ProductKind.PERSONALIZED) &&
                !current.designApprovedAt))) ||
          (dto.stage === ProductionStage.READY &&
            (current.productionStage !== ProductionStage.FACTORY ||
              !current.qualityApprovedAt ||
              (current.isCorporate &&
                (!current.corporateUnits.length ||
                  current.corporateUnits.some((unit) => unit.status !== 'COMPLETED')))))
        ) {
          throw new BadRequestException('El trabajo aún no cumple los pasos para avanzar.');
        }
      }

      if (dto.requiresProduction !== undefined) {
        if (!adminRoles.includes(membership.role)) {
          throw new ForbiddenException('Solo administración puede asignar trabajos a Fábrica.');
        }
        if (
          current.isExpress ||
          current.productionStage !== ProductionStage.WAITING ||
          current.status === SalesOrderStatus.CANCELLED ||
          dto.stage !== undefined
        ) {
          throw new BadRequestException(
            'La asignación a Fábrica solo puede cambiarse mientras la orden está en espera.',
          );
        }
        if (
          dto.requiresProduction === false &&
          current.items.some((item) => item.product?.kind === ProductKind.PERSONALIZED)
        ) {
          throw new BadRequestException(
            'Los productos personalizados siempre requieren trabajo de Fábrica.',
          );
        }
      }

      const nextStage = dto.stage ?? current.productionStage;
      if (
        dto.stage === ProductionStage.DELIVERED &&
        current.paymentMode !== SalePaymentMode.CREDIT &&
        current.invoice?.balance.gt(0)
      ) {
        throw new BadRequestException('Completa el balance de la orden antes de entregarla.');
      }
      if (
        dto.stage &&
        (current.status === SalesOrderStatus.CANCELLED ||
          current.exceptionStatus === OrderExceptionStatus.CANCELLED)
      ) {
        throw new BadRequestException('Una orden cancelada no puede avanzar en producción.');
      }
      if (dto.stage && current.status !== SalesOrderStatus.COMPLETED) {
        throw new BadRequestException('La orden debe estar facturada y cobrada antes de avanzar.');
      }
      if (
        dto.stage === ProductionStage.DELIVERED &&
        (!current.invoice ||
          ['DRAFT', 'CANCELLED', 'VOID', 'VOIDED', 'CREDITED'].includes(current.invoice.status))
      ) {
        throw new BadRequestException('La orden necesita una factura vigente antes de entregarse.');
      }
      const now = new Date();
      const updated = await tx.salesOrder.update({
        where: { id },
        data: {
          productionStage: dto.stage,
          requiresProduction:
            dto.requiresProduction ?? (dto.stage === ProductionStage.FACTORY ? true : undefined),
          deliveredAt: dto.stage === ProductionStage.DELIVERED ? now : dto.stage ? null : undefined,
          deliveredById:
            dto.stage === ProductionStage.DELIVERED ? user.id : dto.stage ? null : undefined,
          exceptionStatus: dto.exceptionStatus,
          priority: dto.priority,
          productionNotes: dto.note === undefined ? undefined : dto.note.trim() || null,
        },
        include: this.orderInclude(),
      });

      await tx.orderWorkflowEvent.create({
        data: {
          tenantId,
          salesOrderId: id,
          fromStage: current.productionStage,
          toStage: nextStage,
          exceptionStatus: dto.exceptionStatus ?? current.exceptionStatus,
          note:
            dto.requiresProduction === undefined
              ? dto.note?.trim() || null
              : dto.requiresProduction
                ? 'Orden asignada a Fábrica por administración'
                : 'Asignación a Fábrica retirada por administración',
          changedById: user.id,
        },
      });
      return updated;
    });

    if (
      dto.stage === ProductionStage.READY &&
      updated.notificationEmail &&
      !updated.readyNotifiedAt
    ) {
      const deliveryLabel =
        updated.deliveryMethod === DeliveryMethod.PICKUP
          ? `Puedes recogerla en ${updated.dispatchLocation === 'FACTORY' ? 'la fábrica' : 'la tienda'}.`
          : `La orden será despachada a: ${updated.deliveryAddress ?? 'la dirección registrada'}.`;
      const notification = await this.resend.sendOrderReady({
        orderId: updated.id,
        orderNumber: updated.orderNumber,
        recipient: updated.notificationEmail,
        clientName: updated.clientName || updated.customer?.name || 'cliente',
        deliveryLabel,
      });
      await this.prisma.salesOrder.update({
        where: { id: updated.id },
        data: notification.sent
          ? {
              readyNotifiedAt: new Date(),
              readyNotificationId: notification.id,
              readyNotificationError: null,
            }
          : { readyNotificationError: notification.error },
      });
    }

    return this.findOne(tenantId, user, id);
  }

  async approveDesign(tenantId: string, user: AuthenticatedUser, id: string) {
    return this.recordApproval(tenantId, user, id, 'design');
  }

  async approveQuality(tenantId: string, user: AuthenticatedUser, id: string) {
    return this.recordApproval(tenantId, user, id, 'quality');
  }

  private async recordApproval(
    tenantId: string,
    user: AuthenticatedUser,
    id: string,
    type: 'design' | 'quality',
  ) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanManageProduction(membership);
    if (type === 'design' && membership.role === Role.WAREHOUSE_KEEPER) {
      throw new ForbiddenException('La aprobación del diseño corresponde a administración.');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, id);
      const order = await tx.salesOrder.findFirstOrThrow({
        where: { id, tenantId },
        include: { items: { include: { product: { select: { kind: true } } } } },
      });
      // Moving a paid order on the board does not imply design approval.
      // Administration must still be able to record it after work has started.
      const allowedStages: ProductionStage[] =
        type === 'design'
          ? [ProductionStage.WAITING, ProductionStage.FACTORY]
          : [ProductionStage.FACTORY];
      if (
        !order.requiresProduction ||
        !allowedStages.includes(order.productionStage) ||
        order.exceptionStatus !== OrderExceptionStatus.NONE ||
        order.status === SalesOrderStatus.CANCELLED
      ) {
        throw new BadRequestException('La orden no está disponible para esta aprobación.');
      }
      if (
        type === 'quality' &&
        !order.designApprovedAt &&
        order.items.some((item) => item.product?.kind === ProductKind.PERSONALIZED)
      )
        throw new BadRequestException('Aprueba el diseño primero.');
      await tx.salesOrder.update({
        where: { id },
        data:
          type === 'design'
            ? { designApprovedAt: new Date(), designApprovedById: user.id }
            : { qualityApprovedAt: new Date(), qualityApprovedById: user.id },
      });
      await tx.orderWorkflowEvent.create({
        data: {
          tenantId,
          salesOrderId: id,
          fromStage: order.productionStage,
          toStage: order.productionStage,
          changedById: user.id,
          note: type === 'design' ? 'Diseño aprobado' : 'Control de calidad aprobado',
        },
      });
    });
    return this.findOne(tenantId, user, id);
  }

  async addCorporateUnits(
    tenantId: string,
    user: AuthenticatedUser,
    id: string,
    dto: AddCorporateOrderUnitsDto,
  ) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanManageProduction(membership);
    if (membership.role === Role.WAREHOUSE_KEEPER) {
      throw new ForbiddenException('Solo administración puede agregar destinatarios.');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, id);
      const order = await tx.salesOrder.findFirst({
        where: { id, tenantId, isCorporate: true },
        include: { items: true, corporateUnits: true },
      });
      if (!order) throw new NotFoundException('La orden empresarial no existe.');
      if (
        order.status === SalesOrderStatus.CANCELLED ||
        order.productionStage === ProductionStage.DELIVERED
      )
        throw new BadRequestException('La orden está cerrada.');
      if (!dto.units.length) throw new BadRequestException('Agrega destinatarios.');
      const counts = new Map<string, number>();
      for (const unit of order.corporateUnits)
        if (unit.salesOrderItemId)
          counts.set(unit.salesOrderItemId, (counts.get(unit.salesOrderItemId) ?? 0) + 1);
      const data = dto.units.map((unit) => {
        const item =
          order.items.find((item) => item.id === unit.salesOrderItemId) ??
          (order.items.length === 1 ? order.items[0] : undefined);
        if (!item) throw new BadRequestException('Selecciona el producto de los destinatarios.');
        const count = (counts.get(item.id) ?? 0) + 1;
        if (count > Number(item.quantity))
          throw new BadRequestException(
            'Los destinatarios exceden las unidades vendidas del producto.',
          );
        if (!unit.recipientName.trim()) throw new BadRequestException('Indica el destinatario.');
        counts.set(item.id, count);
        return {
          tenantId,
          salesOrderId: id,
          salesOrderItemId: item.id,
          recipientName: unit.recipientName.trim(),
          message: unit.message?.trim() || null,
          personalization: unit.personalization ?? undefined,
          updatedById: user.id,
        };
      });
      await tx.corporateOrderUnit.createMany({ data });
    });
    return this.findOne(tenantId, user, id);
  }

  async importCorporateUnits(
    tenantId: string,
    user: AuthenticatedUser,
    id: string,
    file?: { originalname: string; buffer: Buffer; size: number },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('Selecciona un archivo Excel .xlsx.');
    const rows = await readSheet(file.buffer);
    if (rows.length < 2)
      throw new BadRequestException('El archivo debe incluir encabezados y destinatarios.');
    if (rows.length > 1001)
      throw new BadRequestException('El archivo admite hasta 1,000 destinatarios.');
    const normalize = (value: unknown) =>
      String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    const headers = rows[0].map(normalize);
    const recipientIndex = headers.findIndex((header) =>
      ['nombre', 'destinatario', 'recipient', 'recipient name'].includes(header),
    );
    const messageIndex = headers.findIndex((header) =>
      ['mensaje', 'message', 'dedicatoria'].includes(header),
    );
    if (recipientIndex < 0) {
      throw new BadRequestException('El Excel necesita una columna Nombre o Destinatario.');
    }
    const skuIndex = headers.findIndex((header) => ['sku', 'codigo', 'producto'].includes(header));
    const corporateOrder = await this.prisma.salesOrder.findFirstOrThrow({
      where: { id, tenantId, isCorporate: true },
      include: { items: true },
    });
    const units = rows.slice(1).flatMap((row) => {
      const recipientName = String(row[recipientIndex] ?? '').trim();
      if (!recipientName) return [];
      const message = messageIndex >= 0 ? String(row[messageIndex] ?? '').trim() : '';
      const sku = skuIndex >= 0 ? String(row[skuIndex] ?? '').trim() : '';
      const item = sku
        ? corporateOrder.items.find((item) => item.sku === sku)
        : corporateOrder.items.length === 1
          ? corporateOrder.items[0]
          : null;
      if (!item)
        throw new BadRequestException(
          'Incluye el SKU para cada destinatario cuando la orden tiene varios productos.',
        );
      return [{ recipientName, salesOrderItemId: item.id, ...(message ? { message } : {}) }];
    });
    if (!units.length) throw new BadRequestException('El Excel no contiene destinatarios válidos.');
    return this.addCorporateUnits(tenantId, user, id, { units });
  }

  async updateCorporateUnit(
    tenantId: string,
    user: AuthenticatedUser,
    orderId: string,
    unitId: string,
    dto: UpdateCorporateOrderUnitDto,
  ) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanManageProduction(membership);
    if (
      membership.role === Role.WAREHOUSE_KEEPER &&
      (dto.delivered !== undefined ||
        dto.recipientName !== undefined ||
        dto.message !== undefined ||
        dto.personalization !== undefined)
    ) {
      throw new ForbiddenException('Fábrica solo puede actualizar el avance de las unidades.');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, orderId);
      const order = await tx.salesOrder.findFirstOrThrow({
        where: { id: orderId, tenantId, isCorporate: true },
        include: { invoice: true },
      });
      if (
        membership.role === Role.WAREHOUSE_KEEPER &&
        (!order.requiresProduction ||
          (order.productionStage !== ProductionStage.WAITING &&
            order.productionStage !== ProductionStage.FACTORY))
      ) {
        throw new ForbiddenException('Esta orden no está asignada a Fábrica.');
      }
      const unit = await tx.corporateOrderUnit.findFirst({
        where: { id: unitId, tenantId, salesOrderId: orderId },
      });
      if (!unit) throw new NotFoundException('La unidad empresarial no existe.');
      if (
        order.status === SalesOrderStatus.CANCELLED ||
        order.productionStage === ProductionStage.DELIVERED ||
        order.exceptionStatus !== OrderExceptionStatus.NONE
      )
        throw new BadRequestException('La orden está cerrada o bloqueada.');
      const nextStatus = dto.status ?? unit.status;
      if (
        dto.delivered === true &&
        (nextStatus !== 'COMPLETED' ||
          order.status !== SalesOrderStatus.COMPLETED ||
          (order.requiresProduction && !order.qualityApprovedAt) ||
          (order.paymentMode !== SalePaymentMode.CREDIT && order.invoice?.balance.gt(0)))
      ) {
        throw new BadRequestException(
          'Termina y revisa la unidad y completa el balance antes de entregarla.',
        );
      }
      if (dto.recipientName !== undefined && !dto.recipientName.trim())
        throw new BadRequestException('Indica el destinatario.');
      if (unit.deliveredAt && nextStatus !== 'COMPLETED')
        throw new BadRequestException('Una unidad entregada no puede volver a producción.');
      await tx.corporateOrderUnit.update({
        where: { id: unitId },
        data: {
          status: dto.status,
          recipientName: dto.recipientName?.trim(),
          message: dto.message?.trim(),
          personalization: dto.personalization,
          updatedById: user.id,
          ...(dto.delivered === undefined
            ? {}
            : {
                deliveredAt: dto.delivered ? new Date() : null,
                deliveredById: dto.delivered ? user.id : null,
              }),
        },
      });
      await tx.orderWorkflowEvent.create({
        data: {
          tenantId,
          salesOrderId: orderId,
          fromStage: order.productionStage,
          toStage: order.productionStage,
          changedById: user.id,
          note: 'Unidad empresarial actualizada: ' + unit.recipientName,
        },
      });
    });
    return this.findOne(tenantId, user, orderId);
  }

  async removeCorporateUnit(
    tenantId: string,
    user: AuthenticatedUser,
    orderId: string,
    unitId: string,
  ) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanManageProduction(membership);
    if (membership.role === Role.WAREHOUSE_KEEPER) {
      throw new ForbiddenException('Solo administración puede quitar destinatarios.');
    }
    const removed = await this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, orderId);
      return tx.corporateOrderUnit.deleteMany({
        where: {
          id: unitId,
          tenantId,
          salesOrderId: orderId,
          status: 'PENDING',
          deliveredAt: null,
          salesOrder: {
            status: { not: SalesOrderStatus.CANCELLED },
            productionStage: ProductionStage.WAITING,
          },
        },
      });
    });
    if (!removed.count)
      throw new BadRequestException(
        'Solo puedes retirar destinatarios pendientes de una orden en espera.',
      );
    return this.findOne(tenantId, user, orderId);
  }

  async searchProducts(
    tenantId: string,
    user: AuthenticatedUser,
    q: string,
    inventorySource: ProductInventoryDestination = ProductInventoryDestination.SALES_INVENTORY,
    collection?: string,
  ) {
    await this.ensureCanTakeOrders(tenantId, user);
    if (inventorySource !== ProductInventoryDestination.SALES_INVENTORY) {
      throw new BadRequestException('El stock físico de Fábrica ya no está disponible.');
    }
    const query = q.trim();
    const collectionFilter = collection
      ? await collectionProductFilter(this.prisma, tenantId, collection)
      : {};

    return this.prisma.product
      .findMany({
        where: {
          tenantId,
          inventoryDestination: ProductInventoryDestination.SALES_INVENTORY,
          status: ProductStatus.ACTIVE,
          ...collectionFilter,
          ...(query
            ? {
                OR: [
                  { name: { contains: query, mode: 'insensitive' as const } },
                  { sku: { contains: query, mode: 'insensitive' as const } },
                  { barcode: { contains: query, mode: 'insensitive' as const } },
                  { brand: { contains: query, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        include: { category: true },
        orderBy: [{ stock: 'asc' }, { name: 'asc' }],
        // Una colección puede tener más de 30 variantes (la tienda llega a más de 80 por grupo): se amplía el tope.
        take: collection ? 300 : 30,
      });
  }

  async searchProductCollections(tenantId: string, user: AuthenticatedUser) {
    await this.ensureCanTakeOrders(tenantId, user);
    return countCollections(this.prisma, tenantId, {
      inventoryDestination: ProductInventoryDestination.SALES_INVENTORY,
      status: ProductStatus.ACTIVE,
    });
  }

  async findProductByBarcode(
    tenantId: string,
    user: AuthenticatedUser,
    barcode: string,
    inventorySource: ProductInventoryDestination = ProductInventoryDestination.SALES_INVENTORY,
  ) {
    await this.ensureCanTakeOrders(tenantId, user);
    if (inventorySource !== ProductInventoryDestination.SALES_INVENTORY) {
      throw new BadRequestException('El stock físico de Fábrica ya no está disponible.');
    }
    const lookupCandidates = getBarcodeLookupCandidates(barcode);
    const product = await this.prisma.product.findFirst({
      where: {
        tenantId,
        inventoryDestination: ProductInventoryDestination.SALES_INVENTORY,
        status: ProductStatus.ACTIVE,
        OR: [{ barcode: { in: lookupCandidates } }, { sku: { in: lookupCandidates } }],
      },
      include: { category: true },
    });

    if (!product) {
      throw new NotFoundException('No active product found for barcode.');
    }

    await this.prisma.product.update({
      where: { id: product.id },
      data: { barcodeLastScannedAt: new Date() },
    });

    return product;
  }

  async create(
    tenantId: string,
    user: AuthenticatedUser,
    dto: CreateSalesOrderDto,
    imported?: {
      reference: string;
      paidAmount: number;
      inventoryAlreadyDeducted: boolean;
      stage: ProductionStage;
      source: OrderSource;
      issuedAt?: Date;
      invoiceNumber?: string;
      designApproved: boolean;
      qualityApproved: boolean;
    },
  ) {
    const membership = await this.ensureCanTakeOrders(tenantId, user);
    if (dto.requiresProduction && !adminRoles.includes(membership.role)) {
      throw new ForbiddenException('Solo administración puede asignar una orden normal a Fábrica.');
    }
    if (
      dto.items.some((item) => item.unitPrice !== undefined) &&
      !adminRoles.includes(membership.role) &&
      !membership.canApplyDiscount
    )
      throw new ForbiddenException('No tienes permiso para cambiar precios.');

    if (!dto.items.length) {
      throw new BadRequestException('Sales order must include at least one item.');
    }

    const clientName = dto.clientName?.trim() || undefined;
    const destination = dto.destination ?? SalesOrderDestination.CASH_SALE;
    const inventorySource = dto.inventorySource ?? ProductInventoryDestination.SALES_INVENTORY;
    const priceLevel = dto.priceLevel ?? SalesOrderPriceLevel.REGULAR;
    const discountRate = this.getDiscountRate(priceLevel);
    const paymentMode = dto.paymentMode ?? SalePaymentMode.CASH;
    const electronicInvoiceRequested =
      destination === SalesOrderDestination.CASH_SALE && dto.electronicInvoiceRequested === true;

    if (destination === SalesOrderDestination.QUOTATION) {
      this.validateQuotationDetails(dto);
    } else if (!dto.promisedDate && !dto.isExpress) {
      throw new BadRequestException('Indica la fecha prometida de la orden.');
    }

    if (
      dto.isExpress &&
      (destination !== SalesOrderDestination.CASH_SALE ||
        dto.requiresProduction === true ||
        paymentMode === SalePaymentMode.CREDIT ||
        dto.isCorporate ||
        inventorySource !== ProductInventoryDestination.SALES_INVENTORY ||
        (dto.deliveryMethod && dto.deliveryMethod !== DeliveryMethod.PICKUP))
    ) {
      throw new BadRequestException(
        'La venta exprés requiere cobro de contado y recogida inmediata; no admite regalos empresariales ni trabajos de Fábrica.',
      );
    }

    if (
      destination === SalesOrderDestination.CASH_SALE &&
      dto.deliveryMethod &&
      dto.deliveryMethod !== DeliveryMethod.PICKUP &&
      (!dto.deliveryAddress?.trim() || !dto.deliveryPhone?.trim())
    ) {
      throw new BadRequestException('La dirección y el teléfono son requeridos para el envío.');
    }

    this.validatePaymentModeFields(paymentMode, dto);

    return this.prisma.$transaction(async (tx) => {
      if (imported) {
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
        const duplicate = await tx.salesOrder.findFirst({
          where: { tenantId, externalOrderId: 'IMPORT:' + imported.reference },
        });
        if (duplicate) throw new BadRequestException('Esta referencia histórica ya fue importada.');
      }
      const ecfRecipientEmail = electronicInvoiceRequested
        ? dto.ecfRecipientEmail?.trim().toLowerCase() || null
        : null;

      if (electronicInvoiceRequested && !ecfRecipientEmail) {
        throw new BadRequestException(
          'Indica el correo del cliente para enviar la copia de la factura electrónica.',
        );
      }

      const customer = dto.customerId
        ? await tx.customer.findFirst({
            where: {
              id: dto.customerId,
              tenantId,
            },
          })
        : null;

      if (dto.customerId && !customer) {
        throw new NotFoundException('Customer not found for tenant.');
      }

      if (paymentMode === SalePaymentMode.CREDIT) {
        this.validateCreditCustomer(customer);
      }

      const computed = await this.computeOrder(
        tenantId,
        dto.items,
        tx,
        priceLevel,
        inventorySource,
        imported?.inventoryAlreadyDeducted ?? false,
      );
      if (
        dto.isExpress &&
        computed.items.some((item) => item.product.kind === ProductKind.PERSONALIZED)
      ) {
        throw new BadRequestException(
          'Los productos personalizados requieren el flujo normal de producción.',
        );
      }
      if (
        imported &&
        (imported.paidAmount < 0 ||
          !Number.isFinite(imported.paidAmount) ||
          computed.total.lt(imported.paidAmount))
      )
        throw new BadRequestException('El importe pagado supera el total histórico.');
      const isQuotation = destination === SalesOrderDestination.QUOTATION;
      const isCredit = paymentMode === SalePaymentMode.CREDIT;
      const initialPaymentOption = isCredit ? dto.initialPaymentOption : undefined;
      const initialPaymentRate = isCredit
        ? this.getInitialPaymentRate(initialPaymentOption!)
        : new Prisma.Decimal(0);
      const initialPaymentAmount = computed.total.mul(initialPaymentRate).toDecimalPlaces(2);
      const creditTermOption = isCredit ? dto.creditTermOption : undefined;
      const creditTerms =
        isCredit && customer
          ? this.resolveCreditTerms(customer.creditTermDays, creditTermOption!, dto.customDueDate)
          : null;
      const waitsForCreditApproval = isCredit && !isQuotation;

      if (!isQuotation && !isCredit && !imported?.inventoryAlreadyDeducted) {
        await this.reserveStockForOrder(tenantId, computed.items, tx, inventorySource);
      }

      const now = new Date();
      const currentBalance =
        waitsForCreditApproval && customer
          ? await this.getCustomerCreditBalance(tx, tenantId, customer.id)
          : new Prisma.Decimal(0);
      const financedAmount = computed.total.sub(initialPaymentAmount).toDecimalPlaces(2);
      const orderNumber = imported
        ? 'HIST-' + imported.reference
        : this.generateOrderNumber(isQuotation);
      const draftInvoice = isQuotation
        ? null
        : await this.createDraftInvoice(tx, {
            tenantId,
            customerId: customer?.id,
            orderNumber,
            paymentMode,
            dueDate: creditTerms?.dueDate,
            electronicInvoiceRequested,
            items: computed.items,
            subtotal: computed.subtotal,
            taxTotal: computed.taxTotal,
            discountTotal: computed.discountTotal,
            total: computed.total,
            userId: user.id,
          });
      const order = await tx.salesOrder.create({
        data: {
          tenantId,
          customerId: customer?.id,
          destination,
          inventorySource,
          clientName,
          quotationDocumentType: isQuotation ? dto.quotationDocumentType : undefined,
          quotationDocumentNumber:
            isQuotation && dto.quotationDocumentNumber?.trim()
              ? normalizeDominicanDocument(dto.quotationDocumentNumber)
              : undefined,
          electronicInvoiceRequested,
          ecfRecipientEmail,
          orderNumber,
          source: imported?.source,
          externalOrderId: imported ? 'IMPORT:' + imported.reference : undefined,
          productionStage: imported?.stage,
          isExpress: dto.isExpress ?? false,
          designApprovedAt: imported?.designApproved ? now : undefined,
          designApprovedById: imported?.designApproved ? user.id : undefined,
          qualityApprovedAt: imported?.qualityApproved ? now : undefined,
          qualityApprovedById: imported?.qualityApproved ? user.id : undefined,
          status: isQuotation
            ? SalesOrderStatus.QUOTATION
            : waitsForCreditApproval
              ? SalesOrderStatus.CREATED
              : SalesOrderStatus.SENT_TO_CASHIER,
          priceLevel,
          discountRate,
          subtotal: computed.subtotal,
          taxTotal: computed.taxTotal,
          discountTotal: computed.discountTotal,
          total: computed.total,
          paymentMode,
          initialPaymentOption,
          initialPaymentRate,
          initialPaymentAmount,
          creditTermOption,
          creditTermDays: creditTerms?.days,
          dueDate: creditTerms?.dueDate,
          creditRequestNote: isCredit ? dto.creditRequestNote?.trim() || null : null,
          notes: dto.notes?.trim() || undefined,
          promisedAt: dto.promisedDate ? parseBusinessDate(dto.promisedDate) : null,
          priority: dto.priority ?? OrderPriority.NORMAL,
          isCorporate: dto.isCorporate ?? false,
          deliveryMethod: dto.deliveryMethod,
          dispatchLocation: dto.dispatchLocation,
          deliveryAddress: dto.deliveryAddress?.trim() || null,
          deliveryPhone: dto.deliveryPhone?.trim() || null,
          notificationEmail: dto.notificationEmail?.trim().toLowerCase() || null,
          invoiceId: draftInvoice?.id,
          requiresProduction:
            dto.requiresProduction === true ||
            computed.items.some((item) => item.product.kind === ProductKind.PERSONALIZED),
          createdById: user.id,
          sentToCashierAt: isQuotation || waitsForCreditApproval ? undefined : now,
          items: {
            create: computed.items.map((item) => ({
              productId: item.product.id,
              sku: item.product.sku,
              barcode: item.product.barcode,
              description: item.product.name,
              personalization: item.personalization,
              quantity: item.quantity,
              reservedQuantity:
                isQuotation || isCredit || imported?.inventoryAlreadyDeducted
                  ? 0
                  : item.reservedQuantity,
              unitPrice: item.unitPrice,
              discountTotal: item.discountTotal,
              taxRate: item.product.taxRate,
              taxTotal: item.taxTotal,
              subtotal: item.subtotal,
              total: item.total,
            })),
          },
          ...(waitsForCreditApproval && customer && creditTerms && initialPaymentOption
            ? {
                creditApproval: {
                  create: {
                    tenantId,
                    customerId: customer.id,
                    initialPaymentOption,
                    creditTermOption: creditTermOption!,
                    requestedTotal: computed.total,
                    initialPaymentAmount,
                    financedAmount,
                    customerBalanceSnapshot: currentBalance,
                    creditLimitSnapshot: customer.creditLimit,
                    exceedsCreditLimit: currentBalance.add(financedAmount).gt(customer.creditLimit),
                    dueDate: creditTerms.dueDate,
                    requestNote: dto.creditRequestNote?.trim() || undefined,
                    requestedById: user.id,
                    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                  },
                },
              }
            : {}),
        },
        include: this.orderInclude(),
      });

      const activityLogs: Prisma.EmployeeActivityLogCreateManyInput[] = [
        {
          tenantId,
          userId: user.id,
          action: EmployeeLogAction.CREATE_SALES_ORDER,
          entity: 'SalesOrder',
          entityId: order.id,
          amount: computed.total,
          metadata: this.buildOrderLogMetadata(order, computed.items, user.id),
        },
      ];

      if (!isQuotation && !waitsForCreditApproval) {
        activityLogs.push({
          tenantId,
          userId: user.id,
          action: EmployeeLogAction.SEND_SALES_ORDER_TO_CASHIER,
          entity: 'SalesOrder',
          entityId: order.id,
          amount: computed.total,
          metadata: this.buildOrderLogMetadata(order, computed.items, user.id),
        });
      }

      await tx.employeeActivityLog.createMany({ data: activityLogs });
      if (imported) {
        if (imported.stage === ProductionStage.FACTORY && !imported.designApproved)
          throw new BadRequestException(
            'La orden en fábrica requiere aprobación de diseño histórica.',
          );
        if (
          [ProductionStage.READY, ProductionStage.DELIVERED].includes(imported.stage as any) &&
          order.requiresProduction &&
          (!imported.designApproved || !imported.qualityApproved)
        )
          throw new BadRequestException(
            'La orden lista requiere aprobaciones históricas de diseño y calidad.',
          );
        if (
          !imported.inventoryAlreadyDeducted &&
          (imported.paidAmount > 0 || imported.stage !== ProductionStage.WAITING)
        )
          throw new BadRequestException(
            'Las órdenes históricas cobradas o avanzadas deben indicar inventario ya descontado.',
          );
        if (imported.inventoryAlreadyDeducted) {
          let customerId = order.customerId;
          if (!customerId && computed.total.gt(imported.paidAmount)) {
            if (!clientName)
              throw new BadRequestException('Indica el cliente del balance histórico.');
            const customer = await tx.customer.create({
              data: {
                tenantId,
                name: clientName,
                documentType: DocumentType.OTHER,
                phone: dto.deliveryPhone,
              },
            });
            customerId = customer.id;
          }
          const balance = computed.total.sub(imported.paidAmount);
          await tx.invoice.update({
            where: { id: draftInvoice!.id },
            data: {
              customerId,
              invoiceNumber: imported.invoiceNumber || 'HIST-' + imported.reference,
              issuedAt: imported.issuedAt ?? now,
              status: balance.isZero()
                ? InvoiceStatus.PAID
                : imported.paidAmount > 0
                  ? InvoiceStatus.PARTIALLY_PAID
                  : InvoiceStatus.ISSUED,
              paidAmount: imported.paidAmount,
              balance,
              payments:
                imported.paidAmount > 0
                  ? {
                      create: {
                        tenantId,
                        amount: imported.paidAmount,
                        method: PaymentMethod.TRANSFER,
                        status: PaymentStatus.COMPLETED,
                        paidAt: imported.issuedAt ?? now,
                        receiptNumber: 'HIST-' + imported.reference,
                        userId: user.id,
                      },
                    }
                  : undefined,
            },
          });
          await tx.salesOrder.update({
            where: { id: order.id },
            data: {
              customerId,
              status: SalesOrderStatus.COMPLETED,
              completedAt: imported.issuedAt ?? now,
            },
          });
        }
        await tx.orderWorkflowEvent.create({
          data: {
            tenantId,
            salesOrderId: order.id,
            fromStage: imported.stage,
            toStage: imported.stage,
            changedById: user.id,
            note:
              'Importación histórica: ' +
              imported.reference +
              '. Inventario ' +
              (imported.inventoryAlreadyDeducted
                ? 'previamente descontado; no se descuenta otra vez.'
                : 'reservado al importar.'),
          },
        });
        return tx.salesOrder.findUniqueOrThrow({
          where: { id: order.id },
          include: this.orderInclude(),
        });
      }
      return order;
    });
  }

  async claim(tenantId: string, user: AuthenticatedUser, id: string, dto: ClaimSalesOrderDto) {
    const membership = await this.ensureCanUsePosForOrders(tenantId, user);

    const cashSession = await this.findOpenCashSessionForUser(tenantId, user.id, dto.cashSessionId);
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + claimTtlMs);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.salesOrder.updateMany({
        where: {
          id,
          tenantId,
          destination: SalesOrderDestination.CASH_SALE,
          AND: [
            {
              OR: [{ invoiceId: null }, { invoice: { is: { status: InvoiceStatus.DRAFT } } }],
            },
            {
              OR: [
                { status: SalesOrderStatus.SENT_TO_CASHIER },
                { status: SalesOrderStatus.IN_CASHIER, claimedById: user.id },
                { status: SalesOrderStatus.IN_CASHIER, claimExpiresAt: { lt: now } },
              ],
            },
          ],
        },
        data: {
          status: SalesOrderStatus.IN_CASHIER,
          claimedById: user.id,
          claimedCashSessionId: cashSession.id,
          claimedAt: now,
          claimExpiresAt,
          releasedAt: null,
        },
      });

      if (claimed.count !== 1) {
        const existing = await tx.salesOrder.findFirst({
          where: { id, tenantId },
          select: { status: true },
        });

        if (!existing) {
          throw new NotFoundException('Sales order not found for tenant.');
        }

        if (existing.status === SalesOrderStatus.COMPLETED) {
          throw new BadRequestException('Sales order has already been completed.');
        }

        if (existing.status === SalesOrderStatus.CANCELLED) {
          throw new BadRequestException('Sales order has already been cancelled.');
        }

        throw new BadRequestException('Sales order is already claimed by another cashier.');
      }

      await this.lockOpenCashSessionForUser(tx, tenantId, user.id, cashSession.id);
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          orderNumber: true,
          total: true,
          destination: true,
          status: true,
          clientName: true,
          claimedById: true,
          claimedCashSessionId: true,
          claimedAt: true,
          claimExpiresAt: true,
          releasedAt: true,
        },
      });

      await tx.employeeActivityLog.create({
        data: {
          tenantId,
          userId: user.id,
          cashSessionId: cashSession.id,
          action: EmployeeLogAction.CLAIM_SALES_ORDER,
          entity: 'SalesOrder',
          entityId: id,
          amount: order.total,
          metadata: {
            orderNumber: order.orderNumber,
            role: membership.role,
            cashRegister: cashSession.cashRegister.name,
            sourceDestination: order.destination,
            sourceStatus: order.status,
            clientName: order.clientName,
          },
        },
      });

      return order;
    });
  }

  async release(tenantId: string, user: AuthenticatedUser, id: string) {
    const membership = this.getMembership(tenantId, user);
    this.ensureCanViewOrders(membership);

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          status: true,
          claimedById: true,
          claimedCashSessionId: true,
        },
      });

      if (!order) {
        throw new NotFoundException('Sales order not found for tenant.');
      }

      if (order.status !== SalesOrderStatus.IN_CASHIER) {
        throw new BadRequestException('Only claimed sales orders can be released.');
      }

      if (!adminRoles.includes(membership.role) && order.claimedById !== user.id) {
        throw new ForbiddenException(
          'Employee does not have permission to release this sales order.',
        );
      }

      const released = await tx.salesOrder.update({
        where: { id },
        data: {
          status: SalesOrderStatus.SENT_TO_CASHIER,
          claimedById: null,
          claimedCashSessionId: null,
          claimedAt: null,
          claimExpiresAt: null,
          releasedAt: new Date(),
        },
        select: {
          id: true,
          orderNumber: true,
          total: true,
          destination: true,
          status: true,
          clientName: true,
          claimedById: true,
          claimedCashSessionId: true,
          claimedAt: true,
          claimExpiresAt: true,
          releasedAt: true,
        },
      });

      await tx.employeeActivityLog.create({
        data: {
          tenantId,
          userId: user.id,
          cashSessionId: order.claimedCashSessionId,
          action: EmployeeLogAction.RELEASE_SALES_ORDER,
          entity: 'SalesOrder',
          entityId: id,
          amount: released.total,
          metadata: {
            orderNumber: released.orderNumber,
            sourceDestination: released.destination,
            sourceStatus: released.status,
            clientName: released.clientName,
          },
        },
      });

      return released;
    });
  }

  async cancel(tenantId: string, user: AuthenticatedUser, id: string, dto?: CancelSalesOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, id);
      const order = await tx.salesOrder.findFirst({
        where: { id, tenantId },
        include: this.orderInclude(),
      });

      if (!order) {
        throw new NotFoundException('Sales order not found for tenant.');
      }

      const membership = this.getMembership(tenantId, user);
      const canCancel =
        adminRoles.includes(membership.role) ||
        (order.createdById === user.id &&
          (order.status === SalesOrderStatus.CREATED ||
            order.status === SalesOrderStatus.SENT_TO_CASHIER ||
            order.status === SalesOrderStatus.QUOTATION) &&
          (membership.role === Role.ORDER_TAKER ||
            membership.canTakeOrders ||
            adminRoles.includes(membership.role))) ||
        (order.claimedById === user.id &&
          order.status === SalesOrderStatus.IN_CASHIER &&
          (membership.role === Role.CASHIER || membership.canUsePos));

      if (!canCancel) {
        throw new ForbiddenException(
          'Employee does not have permission to cancel this sales order.',
        );
      }

      if (
        !openOrderStatuses.includes(order.status) &&
        order.status !== SalesOrderStatus.QUOTATION &&
        !(
          order.status === SalesOrderStatus.COMPLETED &&
          order.invoice?.status === InvoiceStatus.CREDITED
        )
      ) {
        throw new BadRequestException(
          'Una orden cobrada requiere registrar primero su devolución.',
        );
      }

      const cancellableStatuses =
        order.status === SalesOrderStatus.QUOTATION
          ? [SalesOrderStatus.QUOTATION]
          : [
              ...openOrderStatuses,
              ...(order.invoice?.status === InvoiceStatus.CREDITED
                ? [SalesOrderStatus.COMPLETED]
                : []),
            ];

      const cancelledRows = await tx.salesOrder.updateMany({
        where: {
          id,
          tenantId,
          status: { in: cancellableStatuses },
        },
        data: {
          status: SalesOrderStatus.CANCELLED,
          exceptionStatus: OrderExceptionStatus.CANCELLED,
          claimedById: null,
          claimedCashSessionId: null,
          claimExpiresAt: null,
          cancelledAt: new Date(),
          cancelReason: dto?.reason?.trim() || undefined,
        },
      });

      if (cancelledRows.count !== 1) {
        throw new BadRequestException('Only pending sales orders can be cancelled.');
      }

      await this.releaseReservedStock(order.items, tx, tenantId, order.inventorySource);
      if (order.invoiceId) {
        await tx.invoice.updateMany({
          where: { id: order.invoiceId, tenantId, status: InvoiceStatus.DRAFT },
          data: { status: InvoiceStatus.CANCELLED },
        });
      }
      if (
        order.creditApproval &&
        (order.creditApproval.status === CreditApprovalStatus.PENDING ||
          order.creditApproval.status === CreditApprovalStatus.APPROVED)
      ) {
        await tx.creditSaleApproval.update({
          where: { id: order.creditApproval.id },
          data: {
            status: CreditApprovalStatus.CANCELLED,
            cancelledById: user.id,
            cancelledAt: new Date(),
            decisionNote: dto?.reason?.trim() || 'Orden cancelada',
          },
        });
      }

      const cancelled = await tx.salesOrder.findUniqueOrThrow({
        where: { id },
        include: this.orderInclude(),
      });

      await tx.employeeActivityLog.create({
        data: {
          tenantId,
          userId: user.id,
          cashSessionId: order.claimedCashSessionId,
          action: EmployeeLogAction.CANCEL_SALES_ORDER,
          entity: 'SalesOrder',
          entityId: id,
          amount: cancelled.total,
          metadata: {
            orderNumber: cancelled.orderNumber,
            reason: cancelled.cancelReason,
            sourceDestination: cancelled.destination,
            sourceStatus: cancelled.status,
            clientName: cancelled.clientName,
          },
        },
      });

      return cancelled;
    });
  }

  async accept(tenantId: string, user: AuthenticatedUser, id: string, dto: AcceptSalesOrderDto) {
    await this.ensureCanTakeOrders(tenantId, user);
    if (dto.promisedDate < businessDateKey(new Date())) {
      throw new BadRequestException('La fecha prometida no puede estar en el pasado.');
    }
    const promisedAt = parseBusinessDate(dto.promisedDate);

    return this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, id);
      const order = await tx.salesOrder.findFirst({
        where: { id, tenantId },
        include: {
          customer: true,
          creditApproval: true,
          items: {
            include: {
              product: true,
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundException('Sales order not found for tenant.');
      }

      if (order.status !== SalesOrderStatus.QUOTATION) {
        throw new BadRequestException('Only quotations can be accepted.');
      }

      const draftInvoice = await this.createDraftInvoice(tx, {
        tenantId,
        customerId: order.customerId ?? undefined,
        orderNumber: order.orderNumber,
        paymentMode: order.paymentMode,
        dueDate: order.dueDate ?? undefined,
        electronicInvoiceRequested: order.electronicInvoiceRequested,
        items: order.items.map((item) => ({
          product: item.product!,
          quantity: item.quantity,
          reservedQuantity: 0,
          unitPrice: item.unitPrice,
          discountTotal: item.discountTotal,
          subtotal: item.subtotal,
          taxTotal: item.taxTotal,
          total: item.total,
          personalization: item.personalization as Prisma.InputJsonValue | undefined,
        })),
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        discountTotal: order.discountTotal,
        total: order.total,
        userId: user.id,
      });

      if (order.paymentMode === SalePaymentMode.CREDIT) {
        this.validateCreditCustomer(order.customer);
        if (!order.customer || !order.initialPaymentOption || !order.creditTermOption) {
          throw new BadRequestException('Credit quotation is missing payment terms.');
        }
        if (order.creditApproval) {
          throw new BadRequestException('Credit quotation already has an approval request.');
        }
        const creditTerms = this.resolveCreditTerms(
          order.customer.creditTermDays,
          order.creditTermOption,
          order.creditTermOption === CreditTermOption.CUSTOM_DATE
            ? order.dueDate
              ? businessDateKey(order.dueDate)
              : undefined
            : undefined,
        );
        const currentBalance = await this.getCustomerCreditBalance(tx, tenantId, order.customer.id);
        const initialPaymentAmount = order.total.mul(order.initialPaymentRate).toDecimalPlaces(2);
        const financedAmount = order.total.sub(initialPaymentAmount).toDecimalPlaces(2);
        const now = new Date();

        await tx.creditSaleApproval.create({
          data: {
            tenantId,
            salesOrderId: order.id,
            customerId: order.customer.id,
            initialPaymentOption: order.initialPaymentOption,
            creditTermOption: order.creditTermOption,
            requestedTotal: order.total,
            initialPaymentAmount,
            financedAmount,
            customerBalanceSnapshot: currentBalance,
            creditLimitSnapshot: order.customer.creditLimit,
            exceedsCreditLimit: currentBalance.add(financedAmount).gt(order.customer.creditLimit),
            dueDate: creditTerms.dueDate,
            requestNote: order.creditRequestNote,
            requestedById: user.id,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          },
        });
        const updated = await tx.salesOrder.update({
          where: { id },
          data: {
            destination: SalesOrderDestination.CASH_SALE,
            status: SalesOrderStatus.CREATED,
            promisedAt,
            invoiceId: draftInvoice.id,
            initialPaymentAmount,
            creditTermDays: creditTerms.days,
            dueDate: creditTerms.dueDate,
          },
          include: this.orderInclude(),
        });
        await tx.employeeActivityLog.create({
          data: {
            tenantId,
            userId: user.id,
            action: EmployeeLogAction.CREATE_SALES_ORDER,
            entity: 'CreditSaleApproval',
            entityId: order.id,
            amount: order.total,
            metadata: {
              orderNumber: order.orderNumber,
              action: 'CREDIT_APPROVAL_REQUESTED',
              sourceDestination: SalesOrderDestination.QUOTATION,
              sourceStatus: order.status,
              destination: updated.destination,
              status: updated.status,
              clientName: order.clientName,
            },
          },
        });
        return updated;
      }

      // Convert order items to list format for stock reservation
      const orderItems = order.items.map((item) => ({
        productId: item.productId!,
        quantity: Number(item.quantity),
      }));

      // Compute order and validate stock
      const computed = await this.computeOrder(
        tenantId,
        orderItems,
        tx,
        order.priceLevel,
        order.inventorySource,
      );

      // Reserve stock for the order
      await this.reserveStockForOrder(tenantId, computed.items, tx, order.inventorySource);

      // Update the reservedQuantity of each item
      for (const item of order.items) {
        const reservedQuantity = Number(item.quantity);
        await tx.salesOrderItem.update({
          where: { id: item.id },
          data: {
            reservedQuantity: item.product?.trackInventory ? reservedQuantity : 0,
          },
        });
      }

      const now = new Date();
      const updated = await tx.salesOrder.update({
        where: { id },
        data: {
          destination: SalesOrderDestination.CASH_SALE,
          status: SalesOrderStatus.SENT_TO_CASHIER,
          promisedAt,
          invoiceId: draftInvoice.id,
          sentToCashierAt: now,
        },
        include: this.orderInclude(),
      });

      // Log activities
      await tx.employeeActivityLog.create({
        data: {
          tenantId,
          userId: user.id,
          action: EmployeeLogAction.SEND_SALES_ORDER_TO_CASHIER,
          entity: 'SalesOrder',
          entityId: id,
          amount: updated.total,
          metadata: {
            orderNumber: updated.orderNumber,
            sourceDestination: SalesOrderDestination.QUOTATION,
            sourceStatus: order.status,
            destination: updated.destination,
            status: updated.status,
            clientName: order.clientName,
          },
        },
      });

      return updated;
    });
  }

  async update(tenantId: string, user: AuthenticatedUser, id: string, dto: CreateSalesOrderDto) {
    const membership = await this.ensureCanTakeOrders(tenantId, user);

    this.validateQuotationDetails(dto);
    if (
      dto.customerId &&
      !(await this.prisma.customer.findFirst({ where: { id: dto.customerId, tenantId } }))
    )
      throw new BadRequestException('El cliente no pertenece al negocio.');

    return this.prisma.$transaction(async (tx) => {
      await this.lockSalesOrder(tx, tenantId, id);
      const order = await tx.salesOrder.findFirst({
        where: { id, tenantId },
        include: { items: true },
      });

      if (!order) {
        throw new NotFoundException('Sales order not found for tenant.');
      }

      if (order.status !== SalesOrderStatus.QUOTATION) {
        throw new BadRequestException('Only quotations can be modified.');
      }

      if (dto.paymentMode && dto.paymentMode !== order.paymentMode) {
        throw new BadRequestException('Quotation payment mode cannot be changed after creation.');
      }
      if (dto.initialPaymentOption && dto.initialPaymentOption !== order.initialPaymentOption) {
        throw new BadRequestException(
          'Credit initial payment option cannot be changed after creation.',
        );
      }
      if (dto.creditTermOption && dto.creditTermOption !== order.creditTermOption) {
        throw new BadRequestException('Credit term cannot be changed after creation.');
      }
      if (
        order.paymentMode === SalePaymentMode.CREDIT &&
        order.creditTermOption === CreditTermOption.CUSTOM_DATE &&
        dto.customDueDate &&
        order.dueDate &&
        dto.customDueDate !== businessDateKey(order.dueDate)
      ) {
        throw new BadRequestException('Custom credit due date cannot be changed after creation.');
      }
      this.validatePaymentModeFields(order.paymentMode, dto, false);
      if (order.paymentMode === SalePaymentMode.CREDIT) {
        const creditCustomer = dto.customerId
          ? await tx.customer.findFirst({ where: { id: dto.customerId, tenantId } })
          : null;
        this.validateCreditCustomer(creditCustomer);
      }

      // Delete existing items
      await tx.salesOrderItem.deleteMany({
        where: { salesOrderId: id },
      });

      const priceLevel = dto.priceLevel ?? SalesOrderPriceLevel.REGULAR;
      const discountRate = this.getDiscountRate(priceLevel);
      const inventorySource = dto.inventorySource ?? order.inventorySource;
      if (inventorySource !== order.inventorySource) {
        throw new BadRequestException(
          'The inventory source cannot be changed after creating a quotation.',
        );
      }
      const computed = await this.computeOrder(
        tenantId,
        dto.items,
        tx,
        priceLevel,
        inventorySource,
      );

      // Update order fields
      const updated = await tx.salesOrder.update({
        where: { id },
        data: {
          clientName: dto.clientName?.trim() || undefined,
          customerId: dto.customerId || null,
          priceLevel,
          discountRate,
          quotationDocumentType: dto.quotationDocumentType ?? null,
          quotationDocumentNumber: dto.quotationDocumentNumber?.trim()
            ? normalizeDominicanDocument(dto.quotationDocumentNumber)
            : null,
          subtotal: computed.subtotal,
          taxTotal: computed.taxTotal,
          discountTotal: computed.discountTotal,
          total: computed.total,
          initialPaymentAmount:
            order.paymentMode === SalePaymentMode.CREDIT
              ? computed.total.mul(order.initialPaymentRate).toDecimalPlaces(2)
              : undefined,
          creditRequestNote:
            order.paymentMode === SalePaymentMode.CREDIT
              ? dto.creditRequestNote?.trim() || null
              : null,
          requiresProduction: computed.items.some(
            (item) => item.product.kind === ProductKind.PERSONALIZED,
          ),
          notes: dto.notes?.trim() || null,
          promisedAt: dto.promisedDate ? parseBusinessDate(dto.promisedDate) : undefined,
          priority: dto.priority,
          isCorporate: dto.isCorporate,
          deliveryMethod: dto.deliveryMethod,
          dispatchLocation: dto.dispatchLocation,
          deliveryAddress:
            dto.deliveryAddress === undefined ? undefined : dto.deliveryAddress.trim() || null,
          deliveryPhone:
            dto.deliveryPhone === undefined ? undefined : dto.deliveryPhone.trim() || null,
          notificationEmail:
            dto.notificationEmail === undefined
              ? undefined
              : dto.notificationEmail.trim().toLowerCase() || null,
          items: {
            create: computed.items.map((item) => ({
              productId: item.product.id,
              sku: item.product.sku,
              barcode: item.product.barcode,
              description: item.product.name,
              personalization: item.personalization,
              quantity: item.quantity,
              reservedQuantity: 0,
              unitPrice: item.unitPrice,
              discountTotal: item.discountTotal,
              taxRate: item.product.taxRate,
              taxTotal: item.taxTotal,
              subtotal: item.subtotal,
              total: item.total,
            })),
          },
        },
        include: this.orderInclude(),
      });

      // Log activity
      await tx.employeeActivityLog.create({
        data: {
          tenantId,
          userId: user.id,
          action: EmployeeLogAction.CREATE_SALES_ORDER,
          entity: 'SalesOrder',
          entityId: id,
          amount: computed.total,
          metadata: {
            orderNumber: updated.orderNumber,
            isUpdate: true,
            sourceDestination: updated.destination,
            sourceStatus: updated.status,
            clientName: updated.clientName,
          },
        },
      });

      return updated;
    });
  }

  /**
   * Crea una solicitud de pedido del e-commerce con el mismo recorrido que una venta tomada en tienda:
   * `SENT_TO_CASHIER` (visible en Caja y en el tablero de seguimiento), factura borrador `PEND-` y reserva de stock.
   * Los precios, el impuesto y la disponibilidad salen de `computeOrder` (reglas del ERP). No cobra, no envía a
   * Fábrica y no descuenta inventario. Idempotente por (tenant, ECOMMERCE, reference).
   */
  async createExternalOrder(tenantId: string, input: ExternalOrderInput) {
    const customerName = input.customer.name.trim().replace(/\s+/g, ' ');
    const phone = input.customer.phone.trim();
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      throw new BadRequestException('Indica un teléfono válido.');
    }
    const documentDigits = input.customer.documentNumber?.trim()
      ? normalizeDominicanDocument(input.customer.documentNumber)
      : null;
    if (documentDigits && !validateDominicanCedula(input.customer.documentNumber as string)) {
      throw new BadRequestException('La cédula indicada no es válida.');
    }
    const isDelivery = input.delivery.method === 'DELIVERY';
    const address = input.delivery.address?.trim() || '';
    if (isDelivery && address.length < 8) {
      throw new BadRequestException('Indica la dirección completa para el delivery.');
    }
    const email = input.customer.email?.trim().toLowerCase() || null;

    const actor = await this.prisma.membership.findFirst({
      where: { tenantId, status: 'ACTIVE', role: { in: [Role.ADMIN, Role.SUPER_ADMIN] } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!actor) {
      throw new BadRequestException('El tenant no tiene un administrador activo para registrar pedidos web.');
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
        const duplicate = await tx.salesOrder.findUnique({
          where: {
            tenantId_source_externalOrderId: {
              tenantId,
              source: OrderSource.ECOMMERCE,
              externalOrderId: input.reference,
            },
          },
          select: { id: true, orderNumber: true, status: true, createdAt: true },
        });
        if (duplicate) return { duplicate: true, order: duplicate };

        // Cliente: por cédula si la hay; si no, por teléfono y nombre. Nunca se modifica un cliente existente.
        let customer = documentDigits
          ? await tx.customer.findFirst({
              where: { tenantId, documentType: DocumentType.CEDULA, documentNumber: documentDigits },
            })
          : null;
        if (!customer && !documentDigits) {
          const candidates = await tx.customer.findMany({
            where: { tenantId, name: { equals: customerName, mode: 'insensitive' }, phone: { not: null } },
            take: 20,
          });
          customer =
            candidates.find((candidate) => (candidate.phone ?? '').replace(/\D/g, '') === phoneDigits) ??
            null;
        }
        if (!customer) {
          customer = await tx.customer.create({
            data: {
              tenantId,
              name: customerName,
              documentType: documentDigits ? DocumentType.CEDULA : DocumentType.CONSUMER_FINAL,
              documentNumber: documentDigits,
              email,
              phone,
              address: isDelivery ? address : null,
            },
          });
        }

        const items = input.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          ...(item.note?.trim() ? { personalization: { instructions: item.note.trim() } } : {}),
        }));
        const computed = await this.computeOrder(
          tenantId,
          items,
          tx,
          SalesOrderPriceLevel.REGULAR,
          ProductInventoryDestination.SALES_INVENTORY,
        );
        await this.reserveStockForOrder(
          tenantId,
          computed.items,
          tx,
          ProductInventoryDestination.SALES_INVENTORY,
        );

        let orderNumber = '';
        for (let attempt = 0; attempt < 8 && !orderNumber; attempt += 1) {
          const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const candidate = `WEB-${stamp}-${randomBytes(3).toString('hex').toUpperCase()}`;
          const taken = await tx.salesOrder.findFirst({
            where: { tenantId, orderNumber: candidate },
            select: { id: true },
          });
          if (!taken) orderNumber = candidate;
        }
        if (!orderNumber) throw new BadRequestException('No se pudo asignar el número del pedido.');

        const draftInvoice = await this.createDraftInvoice(tx, {
          tenantId,
          customerId: customer.id,
          orderNumber,
          paymentMode: SalePaymentMode.CASH,
          electronicInvoiceRequested: false,
          items: computed.items,
          subtotal: computed.subtotal,
          taxTotal: computed.taxTotal,
          discountTotal: computed.discountTotal,
          total: computed.total,
          userId: actor.userId,
        });

        const personalizationNotes = computed.items.flatMap((item) => {
          const instructions = (item.personalization as { instructions?: string } | undefined)?.instructions;
          return instructions ? [`Personalización · ${item.product.name}: ${instructions}`] : [];
        });
        const deliveryAddress = isDelivery
          ? [address, input.delivery.addressReference?.trim()].filter(Boolean).join(' — ')
          : null;
        const order = await tx.salesOrder.create({
          data: {
            tenantId,
            customerId: customer.id,
            destination: SalesOrderDestination.CASH_SALE,
            inventorySource: ProductInventoryDestination.SALES_INVENTORY,
            clientName: customerName,
            orderNumber,
            status: SalesOrderStatus.SENT_TO_CASHIER,
            source: OrderSource.ECOMMERCE,
            externalOrderId: input.reference,
            subtotal: computed.subtotal,
            taxTotal: computed.taxTotal,
            discountTotal: computed.discountTotal,
            total: computed.total,
            paymentMode: SalePaymentMode.CASH,
            notes: input.notes?.trim() || undefined,
            deliveryMethod: isDelivery ? DeliveryMethod.DELIVERY : DeliveryMethod.PICKUP,
            dispatchLocation: 'STORE',
            deliveryAddress,
            deliveryPhone: phone,
            notificationEmail: email,
            requiresProduction: computed.items.some((item) => item.product.kind === ProductKind.PERSONALIZED),
            productionNotes: [
              `Pedido recibido desde el e-commerce (ref. ${input.reference}). Pendiente de revisión y cobro en caja.`,
              isDelivery ? `Delivery: ${deliveryAddress}. Tel. ${phone}` : `Recogida en tienda. Tel. ${phone}`,
              ...personalizationNotes,
              input.notes?.trim() ? `Comentarios del cliente: ${input.notes.trim()}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            createdById: actor.userId,
            sentToCashierAt: new Date(),
            invoiceId: draftInvoice.id,
            items: {
              create: computed.items.map((item) => ({
                productId: item.product.id,
                sku: item.product.sku,
                barcode: item.product.barcode,
                description: item.product.name,
                personalization: item.personalization,
                quantity: item.quantity,
                reservedQuantity: item.reservedQuantity,
                unitPrice: item.unitPrice,
                discountTotal: item.discountTotal,
                taxRate: item.product.taxRate,
                taxTotal: item.taxTotal,
                subtotal: item.subtotal,
                total: item.total,
              })),
            },
          },
          select: { id: true, orderNumber: true, status: true, createdAt: true },
        });

        await tx.orderWorkflowEvent.create({
          data: {
            tenantId,
            salesOrderId: order.id,
            fromStage: ProductionStage.WAITING,
            toStage: ProductionStage.WAITING,
            note: 'Pedido recibido desde el e-commerce. Pendiente de revisión y cobro.',
            changedById: actor.userId,
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: actor.userId,
            action: 'ECOMMERCE_ORDER_RECEIVED',
            entity: 'SalesOrder',
            entityId: order.id,
            metadata: { orderNumber, reference: input.reference, lines: computed.items.length },
          },
        });
        return { duplicate: false, order };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  private async computeOrder(
    tenantId: string,
    items: SalesOrderItemDto[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
    priceLevel: SalesOrderPriceLevel = SalesOrderPriceLevel.REGULAR,
    inventorySource: ProductInventoryDestination = ProductInventoryDestination.SALES_INVENTORY,
    skipStockValidation = false,
  ) {
    if (!items.length) {
      throw new BadRequestException('Sales order must include at least one item.');
    }
    if (inventorySource !== ProductInventoryDestination.SALES_INVENTORY) {
      throw new BadRequestException('El stock físico de Fábrica ya no está disponible.');
    }

    const quantitiesByProduct = new Map<string, number>();
    for (const item of items) {
      quantitiesByProduct.set(
        item.productId,
        (quantitiesByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }

    const products = await client.product.findMany({
      where: {
        tenantId,
        inventoryDestination: ProductInventoryDestination.SALES_INVENTORY,
        id: { in: Array.from(quantitiesByProduct.keys()) },
        status: ProductStatus.ACTIVE,
      },
    });

    if (products.length !== quantitiesByProduct.size) {
      throw new NotFoundException('One or more order products do not belong to tenant.');
    }

    const discountRate = this.getDiscountRate(priceLevel);
    const computedItems: ComputedOrderItem[] = items.map((sourceItem) => {
      const product = products.find((candidate) => candidate.id === sourceItem.productId)!;
      const quantity = new Prisma.Decimal(sourceItem.quantity);
      const regularUnitPrice = product.salePrice.gt(0) ? product.salePrice : product.price;
      const unitPrice =
        sourceItem.unitPrice === undefined
          ? regularUnitPrice.mul(new Prisma.Decimal(1).sub(discountRate)).toDecimalPlaces(2)
          : new Prisma.Decimal(sourceItem.unitPrice).toDecimalPlaces(2);
      const regularSubtotal = quantity.mul(regularUnitPrice).toDecimalPlaces(2);
      const subtotal = quantity.mul(unitPrice).toDecimalPlaces(2);
      const discountTotal = Prisma.Decimal.max(0, regularSubtotal.sub(subtotal)).toDecimalPlaces(2);
      const taxTotal = subtotal.mul(product.taxRate).toDecimalPlaces(2);

      return {
        product,
        personalization: sourceItem?.personalization
          ? {
              ...(sourceItem.personalization.charms !== undefined
                ? { charms: sourceItem.personalization.charms }
                : {}),
              ...(sourceItem.personalization.children !== undefined
                ? { children: sourceItem.personalization.children }
                : {}),
              ...(sourceItem.personalization.material?.trim()
                ? { material: sourceItem.personalization.material.trim() }
                : {}),
              ...(sourceItem.personalization.instructions?.trim()
                ? { instructions: sourceItem.personalization.instructions.trim() }
                : {}),
            }
          : undefined,
        quantity,
        reservedQuantity: product.trackInventory ? quantity.toNumber() : 0,
        unitPrice,
        discountTotal,
        subtotal,
        taxTotal,
        total: subtotal.add(taxTotal).toDecimalPlaces(2),
      };
    });

    for (const item of computedItems) {
      const quantity = quantitiesByProduct.get(item.product.id)!;
      const availableStock = item.product.stock - item.product.reservedStock;

      if (
        item.product.trackInventory &&
        requiresWholeQuantity(item.product.unit) &&
        !Number.isInteger(quantity)
      ) {
        throw new BadRequestException(
          `Tracked product ${item.product.name} requires whole quantities.`,
        );
      }

      if (!skipStockValidation && item.product.trackInventory && availableStock < quantity) {
        throw new BadRequestException(`Insufficient available stock for ${item.product.name}.`);
      }
    }

    return {
      items: computedItems,
      subtotal: computedItems
        .reduce((sum, item) => sum.add(item.subtotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      taxTotal: computedItems
        .reduce((sum, item) => sum.add(item.taxTotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      discountTotal: computedItems
        .reduce((sum, item) => sum.add(item.discountTotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      total: computedItems
        .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
    };
  }

  private getDiscountRate(priceLevel: SalesOrderPriceLevel) {
    if (priceLevel === SalesOrderPriceLevel.DISCOUNT_10) {
      return new Prisma.Decimal('0.05');
    }

    if (priceLevel === SalesOrderPriceLevel.PREFERRED_18) {
      return new Prisma.Decimal('0.10');
    }

    return new Prisma.Decimal(0);
  }

  private validateCreditCustomer(
    customer: {
      status: CustomerStatus;
      creditEnabled: boolean;
      creditStatus: CustomerCreditStatus;
    } | null,
  ) {
    if (!customer) {
      throw new BadRequestException('Credit sales require a registered customer.');
    }
    if (customer.status !== CustomerStatus.ACTIVE) {
      throw new BadRequestException('Credit customer must be active.');
    }
    if (!customer.creditEnabled || customer.creditStatus !== CustomerCreditStatus.ACTIVE) {
      throw new BadRequestException('Customer credit is disabled or blocked.');
    }
  }

  private validatePaymentModeFields(
    paymentMode: SalePaymentMode,
    dto: CreateSalesOrderDto,
    requireCreditFields = true,
  ) {
    if (paymentMode === SalePaymentMode.CASH) {
      if (
        dto.initialPaymentOption !== undefined ||
        dto.creditTermOption !== undefined ||
        dto.customDueDate !== undefined ||
        dto.creditRequestNote !== undefined
      ) {
        throw new BadRequestException('Cash orders cannot include credit payment terms.');
      }
      return;
    }

    if (requireCreditFields && dto.initialPaymentOption === undefined) {
      throw new BadRequestException('Credit sales require an initial payment option.');
    }
    if (requireCreditFields && dto.creditTermOption === undefined) {
      throw new BadRequestException('Credit sales require a credit term option.');
    }
    if (
      requireCreditFields &&
      dto.creditTermOption === CreditTermOption.CUSTOM_DATE &&
      !dto.customDueDate
    ) {
      throw new BadRequestException('Custom credit term requires a due date.');
    }
    if (
      requireCreditFields &&
      dto.creditTermOption !== CreditTermOption.CUSTOM_DATE &&
      dto.customDueDate !== undefined
    ) {
      throw new BadRequestException('Custom due date is only valid for a custom credit term.');
    }
  }

  private getInitialPaymentRate(option: InitialPaymentOption) {
    const rates: Record<InitialPaymentOption, string> = {
      [InitialPaymentOption.NONE]: '0',
      [InitialPaymentOption.PERCENT_30]: '0.30',
      [InitialPaymentOption.PERCENT_50]: '0.50',
      [InitialPaymentOption.PERCENT_70]: '0.70',
    };
    return new Prisma.Decimal(rates[option]);
  }

  private resolveCreditTerms(
    customerDefaultDays: number,
    option: CreditTermOption,
    customDueDate?: string,
  ) {
    const now = new Date();
    if (option === CreditTermOption.CUSTOM_DATE) {
      if (!customDueDate) {
        throw new BadRequestException('Custom credit term requires a due date.');
      }
      const dueDate = parseBusinessDate(customDueDate);
      if (!dueDate || businessDateKey(dueDate) <= businessDateKey(now)) {
        throw new BadRequestException('Credit due date must be in the future.');
      }
      return { dueDate, days: null };
    }
    const days =
      option === CreditTermOption.DAYS_15
        ? 15
        : option === CreditTermOption.DAYS_30
          ? 30
          : option === CreditTermOption.DAYS_45
            ? 45
            : customerDefaultDays;
    if (!Number.isInteger(days) || days <= 0) {
      throw new BadRequestException('Customer credit days must be a positive whole number.');
    }
    const dueDate = addBusinessDays(days, now);
    return { dueDate, days };
  }

  private async getCustomerCreditBalance(
    client: Prisma.TransactionClient,
    tenantId: string,
    customerId: string,
  ) {
    const aggregate = await client.invoice.aggregate({
      where: {
        tenantId,
        customerId,
        paymentMode: SalePaymentMode.CREDIT,
        status: {
          notIn: [
            InvoiceStatus.DRAFT,
            // Cancelled and voided documents do not consume the credit line.
            InvoiceStatus.CANCELLED,
            InvoiceStatus.VOID,
            InvoiceStatus.VOIDED,
          ],
        },
      },
      _sum: { balance: true },
    });
    return (aggregate._sum.balance ?? new Prisma.Decimal(0)).toDecimalPlaces(2);
  }

  private createDraftInvoice(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      customerId?: string;
      orderNumber: string;
      paymentMode: SalePaymentMode;
      dueDate?: Date;
      electronicInvoiceRequested: boolean;
      items: ComputedOrderItem[];
      subtotal: Prisma.Decimal;
      taxTotal: Prisma.Decimal;
      discountTotal: Prisma.Decimal;
      total: Prisma.Decimal;
      userId: string;
    },
  ) {
    return tx.invoice.create({
      data: {
        tenantId: input.tenantId,
        customerId: input.customerId,
        documentType: input.electronicInvoiceRequested
          ? InvoiceDocumentType.CONSUMER_ELECTRONIC_32
          : InvoiceDocumentType.CONSUMER_02,
        invoiceNumber: `PEND-${input.orderNumber}`,
        status: InvoiceStatus.DRAFT,
        subtotal: input.subtotal,
        taxTotal: input.taxTotal,
        discountTotal: input.discountTotal,
        total: input.total,
        paidAmount: 0,
        balance: input.total,
        paymentMode: input.paymentMode,
        issuedById: input.userId,
        issuedAt: new Date(),
        dueDate: input.dueDate,
        items: {
          create: input.items.map((item) => ({
            productId: item.product.id,
            sku: item.product.sku,
            barcode: item.product.barcode,
            description: item.product.name,
            personalization: item.personalization,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountTotal: item.discountTotal,
            taxRate: item.product.taxRate,
            taxTotal: item.taxTotal,
            subtotal: item.subtotal,
            total: item.total,
          })),
        },
      },
    });
  }

  private async reserveStockForOrder(
    tenantId: string,
    items: ComputedOrderItem[],
    tx: Prisma.TransactionClient,
    source: ProductInventoryDestination,
  ) {
    for (const item of [...items].sort((a, b) => a.product.id.localeCompare(b.product.id))) {
      if (item.product.trackInventory && item.reservedQuantity > 0) {
        await changeReservation(tx, tenantId, item.product.id, source, item.reservedQuantity);
      }
    }
  }

  private async lockSalesOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    salesOrderId: string,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "SalesOrder"
      WHERE "id" = ${salesOrderId}
        AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;

    if (rows.length !== 1) {
      throw new NotFoundException('Sales order not found for tenant.');
    }
  }

  private async lockOpenCashSessionForUser(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    cashSessionId: string,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "CashSession"
      WHERE "id" = ${cashSessionId}
        AND "tenantId" = ${tenantId}
        AND "openedById" = ${userId}
        AND "status" = 'OPEN'::"CashSessionStatus"
      FOR UPDATE
    `;
    if (rows.length !== 1) {
      throw new BadRequestException('Selected cash session is no longer open for this cashier.');
    }
  }

  private async releaseReservedStock(
    items: Array<{ id?: string; productId: string | null; reservedQuantity: number }>,
    tx: Prisma.TransactionClient,
    tenantId: string,
    source: ProductInventoryDestination,
  ) {
    for (const item of [...items].sort((a, b) =>
      (a.productId ?? '').localeCompare(b.productId ?? ''),
    )) {
      if (item.productId && item.reservedQuantity > 0) {
        await changeReservation(tx, tenantId, item.productId, source, -item.reservedQuantity);
      }
    }
    if (items.length)
      await tx.salesOrderItem.updateMany({
        where: { id: { in: items.flatMap((item) => ('id' in item ? [String(item.id)] : [])) } },
        data: { reservedQuantity: 0 },
      });
  }

  private parseStatuses(status?: string) {
    if (!status) {
      return undefined;
    }

    if (status === 'OPEN') {
      return openOrderStatuses;
    }

    if (status === 'QUOTATION') {
      return [SalesOrderStatus.QUOTATION];
    }

    if (!Object.values(SalesOrderStatus).includes(status as SalesOrderStatus)) {
      throw new BadRequestException('Invalid sales order status.');
    }

    return [status as SalesOrderStatus];
  }

  private getMembership(tenantId: string, user: AuthenticatedUser) {
    const membership =
      user.memberships.find((candidate) =>
        ([Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN] as Role[]).includes(candidate.role),
      ) ?? user.memberships.find((candidate) => candidate.tenantId === tenantId);

    if (!membership) {
      throw new ForbiddenException('User does not belong to this tenant.');
    }

    return membership;
  }

  private ensureCanViewOrders(membership: AuthenticatedUser['memberships'][number]) {
    if (
      !adminRoles.includes(membership.role) &&
      !membership.canUsePos &&
      !membership.canTakeOrders &&
      membership.role !== Role.CASHIER &&
      membership.role !== Role.ORDER_TAKER &&
      membership.role !== Role.WAREHOUSE_KEEPER
    ) {
      throw new ForbiddenException('Employee does not have permission to view sales orders.');
    }
  }

  private ensureCanViewProduction(membership: AuthenticatedUser['memberships'][number]) {
    if (!adminRoles.includes(membership.role) && membership.role !== Role.WAREHOUSE_KEEPER) {
      throw new ForbiddenException('No tienes permiso para consultar producción.');
    }
  }

  private ensureCanManageProduction(membership: AuthenticatedUser['memberships'][number]) {
    this.ensureCanViewProduction(membership);
  }

  private async ensureCanTakeOrders(tenantId: string, user: AuthenticatedUser) {
    const membership = this.getMembership(tenantId, user);

    if (
      !adminRoles.includes(membership.role) &&
      membership.role !== Role.ORDER_TAKER &&
      !membership.canTakeOrders
    ) {
      throw new ForbiddenException('Employee does not have permission to take orders.');
    }

    if (!adminRoles.includes(membership.role)) {
      await this.ensureActiveEmployeeProfile(tenantId, user.id, 'take orders');
    }

    return membership;
  }

  private async ensureCanUsePosForOrders(tenantId: string, user: AuthenticatedUser) {
    const membership = this.getMembership(tenantId, user);

    if (
      !adminRoles.includes(membership.role) &&
      !membership.canUsePos &&
      membership.role !== Role.CASHIER
    ) {
      throw new ForbiddenException('Employee does not have POS access.');
    }

    if (!adminRoles.includes(membership.role)) {
      await this.ensureActiveEmployeeProfile(tenantId, user.id, 'use POS');
    }

    return membership;
  }

  private async ensureActiveEmployeeProfile(tenantId: string, userId: string, operation: string) {
    const employee = await this.prisma.employeeProfile.findFirst({
      where: {
        tenantId,
        userId,
        status: EmployeeStatus.ACTIVE,
      },
      select: { id: true },
    });

    if (!employee) {
      throw new ForbiddenException(`Employee profile must be active to ${operation}.`);
    }
  }

  private async findOpenCashSessionForUser(
    tenantId: string,
    userId: string,
    cashSessionId?: string,
  ) {
    const session = await this.prisma.cashSession.findFirst({
      where: {
        tenantId,
        openedById: userId,
        status: CashSessionStatus.OPEN,
        ...(cashSessionId ? { id: cashSessionId } : {}),
      },
      select: {
        id: true,
        cashRegister: { select: { name: true } },
      },
      orderBy: { openedAt: 'desc' },
    });

    if (!session) {
      throw new BadRequestException(
        'An open cash session for this cashier is required to claim sales orders.',
      );
    }

    return session;
  }

  private async releaseExpiredClaims(tenantId: string) {
    const sweepIntervalMs = 60_000;
    const currentTime = Date.now();
    const lastSweepAt = this.expiredClaimSweepAt.get(tenantId) ?? 0;

    if (currentTime - lastSweepAt < sweepIntervalMs) {
      return;
    }

    this.expiredClaimSweepAt.set(tenantId, currentTime);
    const now = new Date();
    try {
      await this.prisma.salesOrder.updateMany({
        where: {
          tenantId,
          status: SalesOrderStatus.IN_CASHIER,
          claimExpiresAt: { lt: now },
        },
        data: {
          status: SalesOrderStatus.SENT_TO_CASHIER,
          claimedById: null,
          claimedCashSessionId: null,
          claimedAt: null,
          claimExpiresAt: null,
          releasedAt: now,
        },
      });
    } catch (error) {
      this.expiredClaimSweepAt.delete(tenantId);
      throw error;
    }
  }

  private orderInclude() {
    return {
      customer: true,
      createdBy: { select: { id: true, name: true, email: true } },
      completedBy: { select: { id: true, name: true, email: true } },
      claimedBy: { select: { id: true, name: true, email: true } },
      designApprovedBy: { select: { id: true, name: true, email: true } },
      qualityApprovedBy: { select: { id: true, name: true, email: true } },
      deliveredBy: { select: { id: true, name: true, email: true } },
      claimedCashSession: {
        include: {
          cashRegister: true,
        },
      },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          status: true,
          paidAmount: true,
          balance: true,
        },
      },
      creditApproval: {
        include: {
          requestedBy: { select: { id: true, name: true, email: true } },
          approvedBy: { select: { id: true, name: true, email: true } },
          rejectedBy: { select: { id: true, name: true, email: true } },
        },
      },
      items: {
        include: {
          product: { include: { category: true } },
        },
        orderBy: { description: 'asc' as const },
      },
      workflowEvents: {
        include: { changedBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' as const },
        take: 20,
      },
      corporateUnits: {
        orderBy: { createdAt: 'asc' as const },
      },
    };
  }

  private generateOrderNumber(isQuotation = false) {
    const date = new Date();
    const stamp = date.toISOString().slice(0, 10).replace(/-/g, '');
    const time =
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    const prefix = isQuotation ? 'COT' : 'ORD';
    return `${prefix}-${stamp}-${time}-${suffix}`;
  }

  private validateQuotationDetails(dto: CreateSalesOrderDto) {
    if (!dto.clientName?.trim()) {
      throw new BadRequestException('Quotation requires client name.');
    }

    this.validateQuotationDocument(dto);
  }

  private validateQuotationDocument(dto: CreateSalesOrderDto) {
    const documentType = dto.quotationDocumentType;
    const documentNumber = dto.quotationDocumentNumber?.trim();

    if (!documentType && !documentNumber) {
      return;
    }

    if (!documentType || !documentNumber) {
      throw new BadRequestException(
        'Quotation document type and document number must be provided together.',
      );
    }

    if (documentType !== DocumentType.RNC && documentType !== DocumentType.CEDULA) {
      throw new BadRequestException('Quotation document type must be RNC or CEDULA.');
    }

    const normalized = normalizeDominicanDocument(documentNumber);

    if (documentType === DocumentType.RNC) {
      if (normalized.length !== 9) {
        throw new BadRequestException('El RNC debe tener 9 digitos.');
      }

      if (!validateDominicanRnc(documentNumber)) {
        throw new BadRequestException('El RNC no es valido.');
      }

      return;
    }

    if (normalized.length !== 11) {
      throw new BadRequestException('La cedula debe tener 11 digitos.');
    }

    if (!validateDominicanCedula(documentNumber)) {
      throw new BadRequestException('La cedula no es valida.');
    }
  }

  private buildOrderLogMetadata(
    order: {
      orderNumber: string;
      customerId: string | null;
      destination: SalesOrderDestination;
      status: SalesOrderStatus;
      clientName: string | null;
    },
    items: ComputedOrderItem[],
    userId: string,
  ) {
    return {
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      createdById: userId,
      sourceDestination: order.destination,
      sourceStatus: order.status,
      clientName: order.clientName,
      itemCount: items.length,
      quantityTotal: items.reduce((total, item) => total + item.quantity.toNumber(), 0),
      items: items.map((item) => ({
        productId: item.product.id,
        sku: item.product.sku,
        barcode: item.product.barcode,
        name: item.product.name,
        quantity: item.quantity.toNumber(),
        total: item.total.toNumber(),
      })),
    };
  }
}

function requiresWholeQuantity(unit: ProductUnit) {
  const fractionalUnits: ProductUnit[] = [
    ProductUnit.METER,
    ProductUnit.FOOT,
    ProductUnit.YARD,
    ProductUnit.POUND,
  ];
  return !fractionalUnits.includes(unit);
}

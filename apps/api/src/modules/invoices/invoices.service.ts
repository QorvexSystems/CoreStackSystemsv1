import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EmployeeLogAction,
  InventoryMovementType,
  InvoiceDocumentType,
  InvoiceFiscalStatus,
  InvoiceStatus,
  Prisma,
  ProductStatus,
  ProductUnit,
  Role,
} from '@qorvex/database';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import {
  createElectronicRangeRegistrationClientFromEnvironment,
  type ElectronicPrintedRepresentation,
} from '../fiscal-sequences/electronic-range-registration.client';

const inventoryAffectingStatuses: InvoiceStatus[] = [
  InvoiceStatus.ISSUED,
  InvoiceStatus.PAID,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.PENDING_ECF,
  InvoiceStatus.ACCEPTED,
];
const receiptPrintActions: EmployeeLogAction[] = [
  EmployeeLogAction.PRINT_RECEIPT,
  EmployeeLogAction.REPRINT_RECEIPT,
];
const printableInvoiceStatuses: InvoiceStatus[] = [
  InvoiceStatus.ISSUED,
  InvoiceStatus.PAID,
  InvoiceStatus.PARTIALLY_PAID,
];
const administrativePrintRoles: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN];
const platformPrintRoles: Role[] = [Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN];

@Injectable()
export class InvoicesService {
  private readonly fiscalCore = createElectronicRangeRegistrationClientFromEnvironment();
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(tenantId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { tenantId },
      include: {
        customer: true,
        items: true,
        issuedBy: { select: { id: true, name: true, email: true } },
        _count: {
          select: {
            employeeActivityLogs: {
              where: { action: { in: receiptPrintActions } },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return invoices.map(({ _count, ...invoice }) => ({
      ...invoice,
      receiptPrintCount: _count.employeeActivityLogs,
    }));
  }

  async create(tenantId: string, userId: string, dto: CreateInvoiceDto) {
    if (!dto.items.length) {
      throw new BadRequestException('Invoice must include at least one item.');
    }

    if (dto.customerId) {
      await this.ensureCustomer(tenantId, dto.customerId);
    }

    if (dto.items.some((item) => !item.productId)) {
      throw new BadRequestException(
        'Invoice items must reference products so totals are recalculated from database.',
      );
    }

    const productIds = dto.items.map((item) => item.productId!);
    const products = await this.getProductsForInvoice(tenantId, productIds);
    const items = dto.items.map((item) => {
      const product = products.get(item.productId!);

      if (!product) {
        throw new NotFoundException('One or more invoice products do not belong to tenant.');
      }

      const quantity = new Prisma.Decimal(item.quantity);
      const unitPrice = product.salePrice.gt(0) ? product.salePrice : product.price;
      const subtotal = quantity.mul(unitPrice).toDecimalPlaces(2);
      const taxTotal = subtotal.mul(product.taxRate).toDecimalPlaces(2);

      return {
        product,
        quantity,
        unitPrice,
        subtotal,
        taxTotal,
        total: subtotal.add(taxTotal).toDecimalPlaces(2),
      };
    });
    const subtotal = items
      .reduce((sum, item) => sum.add(item.subtotal), new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    const taxTotal = items
      .reduce((sum, item) => sum.add(item.taxTotal), new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    const total = items
      .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0))
      .toDecimalPlaces(2);
    const status = dto.status ?? InvoiceStatus.DRAFT;
    if (status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException(
        'Issued fiscal invoices must be completed through the POS fiscal workflow.',
      );
    }
    const shouldAffectInventory = inventoryAffectingStatuses.includes(status);

    const invoice = await this.prisma.$transaction(async (tx) => {
      if (shouldAffectInventory) {
        for (const item of items) {
          if (!item.product.trackInventory) {
            continue;
          }

          const quantity = item.quantity.toNumber();

          if (requiresWholeQuantity(item.product.unit) && !Number.isInteger(quantity)) {
            throw new BadRequestException('Tracked inventory products require whole quantities.');
          }

          if (item.product.stock < quantity) {
            throw new BadRequestException(`Insufficient stock for ${item.product.name}.`);
          }
        }
      }

      const paidAmount = new Prisma.Decimal(0);
      const createdInvoice = await tx.invoice.create({
        data: {
          tenantId,
          customerId: dto.customerId,
          documentType: dto.documentType ?? InvoiceDocumentType.CONSUMER_02,
          invoiceNumber: dto.invoiceNumber ?? `RIV-MAN-${Date.now()}`,
          status,
          fiscalStatus: InvoiceFiscalStatus.PENDING_SEQUENCE,
          subtotal,
          taxTotal,
          discountTotal: 0,
          total,
          paidAmount,
          balance: total.sub(paidAmount),
          paymentMethod: dto.paymentMethod,
          issuedById: userId,
          issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : undefined,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          items: {
            create: items.map((item) => ({
              productId: item.product.id,
              sku: item.product.sku,
              barcode: item.product.barcode,
              description: item.product.name,
              quantity: item.quantity,
              unit: item.product.unit,
              unitPrice: item.unitPrice,
              discountTotal: 0,
              taxCategory: item.product.taxCategory,
              taxRate: item.product.taxRate,
              taxTotal: item.taxTotal,
              subtotal: item.subtotal,
              total: item.total,
            })),
          },
        },
        include: {
          customer: true,
          items: true,
        },
      });

      if (shouldAffectInventory) {
        for (const item of items) {
          if (!item.product.trackInventory) {
            continue;
          }

          const quantity = item.quantity.toNumber();
          const previousStock = item.product.stock;
          const newStock = previousStock - quantity;

          await tx.product.update({
            where: { id: item.product.id },
            data: { stock: newStock },
          });

          await tx.inventoryMovement.create({
            data: {
              tenantId,
              productId: item.product.id,
              type: InventoryMovementType.SALE,
              quantity,
              previousStock,
              newStock,
              unitCost: item.product.cost,
              reason: 'Venta facturada',
              reference: createdInvoice.invoiceNumber,
              invoiceId: createdInvoice.id,
              createdById: userId,
            },
          });
        }
      }

      return createdInvoice;
    });

    await this.audit.log({
      tenantId,
      userId,
      action: 'INVOICE_CREATED',
      entity: 'Invoice',
      entityId: invoice.id,
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        total: invoice.total.toString(),
      },
    });

    return invoice;
  }

  async fiscalProgress(tenantId: string, id: string) {
    // Poll the persisted projection only: no DGII requests, print registration,
    // line/payment/customer joins or repeated loading of receipt assets.
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId },
      select: {
        id: true, tenantId: true, invoiceNumber: true, documentType: true,
        eNcf: true, status: true, fiscalStatus: true,
        electronicDocument: { select: {
          id: true, provider: true, status: true, trackId: true,
          externalId: true, errorMessage: true, updatedAt: true,
        } },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found for tenant.');
    return invoice;
  }

  async findOne(tenantId: string, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenantId },
      include: {
        tenant: { include: { branding: true } },
        customer: true,
        items: true,
        payments: true,
        electronicDocument: true,
        issuedBy: {
          select: { id: true, name: true, email: true },
        },
        cashSession: {
          include: { cashRegister: true },
        },
        _count: {
          select: {
            employeeActivityLogs: {
              where: { action: { in: receiptPrintActions } },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found for tenant.');
    }

    const { _count, ...invoiceData } = invoice;

    return {
      ...invoiceData,
      receiptPrintCount: _count.employeeActivityLogs,
    };
  }

  async registerPrint(tenantId: string, user: AuthenticatedUser, id: string) {
    const candidate = await this.prisma.invoice.findFirst({
      where: { id, tenantId },
      select: {
        documentType: true,
        eNcf: true,
        fiscalStatus: true,
        fiscalIssuerSnapshot: true,
        electronicDocument: { select: { externalId: true } },
      },
    });
    if (!candidate) throw new NotFoundException('Invoice not found for tenant.');
    const electronic =
      candidate.documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ||
      candidate.documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32;
    let representation: ElectronicPrintedRepresentation | null = null;
    if (electronic) {
      const documentId = candidate.electronicDocument?.externalId;
      if (
        candidate.fiscalStatus !== InvoiceFiscalStatus.ACCEPTED ||
        !documentId ||
        !this.fiscalCore
      ) {
        throw new BadRequestException(
          'La representación impresa estará disponible cuando DGII acepte el e-CF.',
        );
      }
      try {
        representation = await this.fiscalCore.readPrintedRepresentation(tenantId, documentId);
      } catch {
        throw new BadRequestException(
          'La representación impresa verificada todavía no está disponible.',
        );
      }
      const issuer = candidate.fiscalIssuerSnapshot as { rnc?: unknown } | null;
      if (
        representation.encf !== candidate.eNcf ||
        representation.scope.tenantId !== tenantId ||
        representation.issuerRnc !== issuer?.rnc ||
        representation.scope.environment !== 'production'
      ) {
        throw new BadRequestException('La evidencia de la representación impresa no coincide.');
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const invoices = await tx.$queryRaw<
        Array<{
          id: string;
          invoiceNumber: string;
          ncf: string | null;
          eNcf: string | null;
          documentType: InvoiceDocumentType;
          status: InvoiceStatus;
          fiscalStatus: InvoiceFiscalStatus;
          issuedById: string | null;
          cashSessionId: string | null;
          total: Prisma.Decimal;
        }>
      >`
        SELECT
          "id",
          "invoiceNumber",
          "ncf",
          "eNcf",
          "documentType",
          "status",
          "fiscalStatus",
          "issuedById",
          "cashSessionId",
          "total"
        FROM "Invoice"
        WHERE "id" = ${id}
          AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const invoice = invoices[0];

      if (!invoice) {
        throw new NotFoundException('Invoice not found for tenant.');
      }

      const expectedNcfPrefix =
        invoice.documentType === InvoiceDocumentType.CONSUMER_02
          ? 'B02'
          : invoice.documentType === InvoiceDocumentType.FISCAL_CREDIT_01
            ? 'B01'
            : null;

      const electronicPrefix =
        invoice.documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31
          ? 'E31'
          : invoice.documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32
            ? 'E32'
            : null;
      const localReady = Boolean(
        expectedNcfPrefix && invoice.ncf &&
        new RegExp(`^${expectedNcfPrefix}\\d{8}$`).test(invoice.ncf) &&
        invoice.fiscalStatus === InvoiceFiscalStatus.LOCAL_ISSUED &&
        printableInvoiceStatuses.includes(invoice.status),
      );
      const localSaleReady = Boolean(
        invoice.documentType === InvoiceDocumentType.LOCAL_SALE_NOTE &&
        invoice.ncf === null &&
        invoice.eNcf === null &&
        /^RIV-\d{10}$/.test(invoice.invoiceNumber) &&
        invoice.fiscalStatus === InvoiceFiscalStatus.NOT_APPLICABLE &&
        printableInvoiceStatuses.includes(invoice.status),
      );
      const electronicReady = Boolean(
        electronicPrefix && representation && invoice.eNcf === representation.encf &&
        new RegExp(`^${electronicPrefix}\\d{10}$`).test(invoice.eNcf ?? '') &&
        invoice.fiscalStatus === InvoiceFiscalStatus.ACCEPTED &&
        (invoice.status === InvoiceStatus.ACCEPTED ||
          invoice.status === InvoiceStatus.PAID ||
          invoice.status === InvoiceStatus.ISSUED),
      );
      if (!localReady && !localSaleReady && !electronicReady) {
        throw new BadRequestException(
          'La factura no tiene una representación válida disponible para impresión.',
        );
      }

      const previousPrintCount = await tx.employeeActivityLog.count({
        where: {
          tenantId,
          invoiceId: invoice.id,
          action: { in: receiptPrintActions },
        },
      });
      const tenantMembership = user.memberships.find(
        (membership) => membership.tenantId === tenantId,
      );
      const platformMembership = user.memberships.find((membership) =>
        platformPrintRoles.includes(membership.role),
      );
      const membership = platformMembership ?? tenantMembership;

      if (!membership) {
        throw new ForbiddenException('User does not belong to this tenant.');
      }

      const isAdministrator = administrativePrintRoles.includes(membership.role);

      if (previousPrintCount === 0) {
        const isIssuingCashier = membership.role === Role.CASHIER && invoice.issuedById === user.id;

        if (!isAdministrator && !isIssuingCashier) {
          throw new ForbiddenException(
            'The first print is restricted to the issuing cashier or an administrator.',
          );
        }
      } else if (!isAdministrator && !membership.canReprintReceipt) {
        throw new ForbiddenException('Receipt reprint permission is required.');
      }

      const printNumber = previousPrintCount + 1;
      const action =
        previousPrintCount === 0
          ? EmployeeLogAction.PRINT_RECEIPT
          : EmployeeLogAction.REPRINT_RECEIPT;
      const log = await tx.employeeActivityLog.create({
        data: {
          tenantId,
          userId: user.id,
          cashSessionId: invoice.cashSessionId,
          action,
          entity: 'Invoice',
          entityId: invoice.id,
          invoiceId: invoice.id,
          amount: invoice.total,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            ncf: invoice.ncf ?? invoice.eNcf,
            documentType: invoice.documentType,
            printNumber,
          },
        },
      });

      return {
        action,
        printNumber,
        isReprint: action === EmployeeLogAction.REPRINT_RECEIPT,
        registeredAt: log.createdAt,
        ...(representation ? { representation } : {}),
      };
    });
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateInvoiceDto) {
    const current = await this.findOne(tenantId, id);

    if (
      current.documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ||
      current.documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32
    ) {
      throw new BadRequestException(
        'Electronic drafts must be managed through the fiscal workflow.',
      );
    }

    if (current.ncf || current.fiscalStatus === InvoiceFiscalStatus.LOCAL_ISSUED) {
      throw new BadRequestException(
        'An issued NCF invoice is immutable; use the audited cancellation or credit-note flow.',
      );
    }

    if (dto.status && dto.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException(
        'Draft invoices must be issued through the POS fiscal workflow.',
      );
    }

    const invoice = await this.prisma.invoice.update({
      where: { id },
      data: {
        status: dto.status,
        issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: 'INVOICE_UPDATED',
      entity: 'Invoice',
      entityId: id,
      metadata: { fields: Object.keys(dto), status: invoice.status },
    });

    return invoice;
  }

  private async ensureCustomer(tenantId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: {
        id: customerId,
        tenantId,
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found for tenant.');
    }
  }

  private async getProductsForInvoice(tenantId: string, productIds: string[]) {
    const products = await this.prisma.product.findMany({
      where: {
        tenantId,
        status: ProductStatus.ACTIVE,
        id: {
          in: productIds,
        },
      },
    });

    if (products.length !== new Set(productIds).size) {
      throw new NotFoundException('One or more invoice products do not belong to tenant.');
    }

    return new Map(products.map((product) => [product.id, product]));
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

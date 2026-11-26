import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CashMovementType,
  CashSessionStatus,
  CreditApprovalStatus,
  CustomerCreditStatus,
  CustomerStatus,
  DocumentType,
  EmployeeLogAction,
  FiscalIssuanceMode,
  EmployeeStatus,
  FiscalDocumentPurpose,
  InventoryMovementType,
  InvoiceDocumentType,
  InvoiceFiscalStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Product,
  ProductStatus,
  ProductUnit,
  Role,
  SalePaymentMode,
  SalesOrderDestination,
  SalesOrderStatus,
  TaxCategory,
  TaxIdentityContextType,
} from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { getBarcodeLookupCandidates } from '../../common/utils/barcode';
import { businessDateKey } from '../../common/utils/business-date';
import { allocateFiscalTaxByRate } from '../../common/utils/fiscal-tax-allocation';
import {
  normalizeDominicanDocument,
  validateDominicanCedula,
  validateDominicanRnc,
} from '../../common/utils/dominican-documents';
import {
  buildInlineFiscalCustomerSnapshot,
  fiscalDocumentTypeMatchesPurpose,
  isElectronicFiscalDocumentType,
  isFiscalCreditDocumentType,
  isSalesFiscalDocumentType,
  readFiscalCustomerSnapshot,
  resolveCheckoutDocumentType,
} from '../fiscal-documents/fiscal-document';
import { FiscalSequencesService } from '../fiscal-sequences/fiscal-sequences.service';
import { ElectronicFiscalDispatchService } from '../fiscal-sequences/electronic-fiscal-dispatch.service';
import { TaxIdentitiesService } from '../tax-identities/tax-identities.service';
import { CompleteSaleDto, PosSaleItemDto } from './dto/complete-sale.dto';
import { UpdatePosFiscalDetailsDto } from './dto/update-pos-fiscal-details.dto';
import {
  assertSyntheticPreview,
  fiscalPreviewCore,
  prepareSyntheticSnapshot,
  view as previewView,
} from '../fiscal-documents/preview-preparation';
import type { PreviewPreparationRow } from '../fiscal-documents/preview-preparation';
import { prepareRemotePreview, readRemotePreview } from '../fiscal-documents/preview-remote';
import {
  buildElectronicFiscalDispatch,
  projectPersistedElectronicSalesDraft,
} from '../fiscal-documents/erp-sales-projection';
import { resolveFiscalItemKind } from '../fiscal-documents/fiscal-item-kind';

const adminRoles: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN];
const claimTtlMs = 30 * 60 * 1000;
const fiscalIdentityFutureSkewMs = 60 * 1000;

type ComputedSaleLine = {
  product: Product;
  productId: string;
  sku: string | null;
  barcode: string | null;
  description: string;
  quantity: Prisma.Decimal;
  unit: ProductUnit;
  reservedQuantity: number;
  unitPrice: Prisma.Decimal;
  originalUnitPrice: Prisma.Decimal | null;
  fiscalItemKind: Product['fiscalItemKind'];
  discountTotal: Prisma.Decimal;
  taxCategory: TaxCategory;
  taxRate: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  total: Prisma.Decimal;
};

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscalSequences: FiscalSequencesService,
    private readonly taxIdentities: TaxIdentitiesService,
    @Optional() private readonly fiscalDispatch?: ElectronicFiscalDispatchService,
  ) {}

  async syntheticRehearsal(
    tenantId: string,
    user: AuthenticatedUser,
    orderId: string,
    start = false,
  ) {
    await this.ensureCanUsePos(tenantId, user);
    assertSyntheticPreview();
    if (tenantId !== 'cmt397emm0002nm0ogb50l2q6') throw new BadRequestException('PREVIEW_ONLY');
    return this.prisma.$transaction(async (tx) => {
      const orders = await tx.$queryRawUnsafe<
        Array<{
          updatedAt: Date;
          claimedById: string;
          claimExpiresAt: Date | null;
          claimedCashSessionId: string | null;
          status: string;
          invoiceId: string | null;
        }>
      >(
        'SELECT "updatedAt","claimedById","claimExpiresAt","claimedCashSessionId",status,"invoiceId" FROM "SalesOrder" WHERE id=$1 AND "tenantId"=$2 FOR UPDATE',
        orderId,
        tenantId,
      );
      const order = orders[0];
      if (!order) throw new NotFoundException('Orden no encontrada.');
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; revision: string }>>(
        `SELECT id::text,revision FROM corestack_preview_ecf.preparation WHERE tenant_id=$1 AND order_id=$2
         AND state='DONE' AND execution_mode='REMOTE_VM4' AND remote_ack IS NOT NULL ORDER BY id DESC LIMIT 1`,
        tenantId,
        orderId,
      );
      const row = rows[0];
      if (!row) return null;
      const stale = row.revision !== order.updatedAt.toISOString();
      if (start) {
        if (
          stale ||
          order.claimedById !== user.id ||
          !order.claimExpiresAt ||
          order.claimExpiresAt <= new Date() ||
          order.status !== 'IN_CASHIER' ||
          !order.claimedCashSessionId ||
          order.invoiceId
        )
          throw new BadRequestException(
            'Toma la orden vigente en Caja antes de iniciar el ensayo.',
          );
        await this.lockOpenCashSessionForUser(tx, tenantId, user.id, order.claimedCashSessionId);
        await tx.$executeRawUnsafe(
          'INSERT INTO corestack_preview_ecf.rehearsal(preparation_id) VALUES($1::bigint) ON CONFLICT DO NOTHING',
          row.id,
        );
      }
      const results = await tx.$queryRawUnsafe<
        Array<{ result: unknown; errorCode: string | null; terminal: boolean }>
      >(
        'SELECT result,error_code AS "errorCode",terminal FROM corestack_preview_ecf.rehearsal WHERE preparation_id=$1::bigint',
        row.id,
      );
      return results[0]
        ? { ...results[0], stale, preparationId: row.id, synthetic: true, sendable: false }
        : null;
    });
  }

  async getSyntheticPreparation(tenantId: string, user: AuthenticatedUser, orderId: string) {
    await this.ensureCanUsePos(tenantId, user);
    assertSyntheticPreview();
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, updatedAt: true },
    });
    if (!order) throw new NotFoundException('Orden no encontrada.');
    const rows = await this.prisma.$queryRawUnsafe<PreviewPreparationRow[]>(
      'SELECT id::text,revision,state,result,error_code,execution_mode,remote_ack FROM corestack_preview_ecf.preparation WHERE tenant_id=$1 AND order_id=$2 ORDER BY id DESC LIMIT 1',
      tenantId,
      orderId,
    );
    return rows[0]
      ? {
          ...(rows[0].execution_mode === 'REMOTE_VM4'
            ? await readRemotePreview(rows[0], tenantId)
            : previewView(rows[0])),
          stale: rows[0].revision !== order.updatedAt.toISOString(),
        }
      : null;
  }

  async prepareSyntheticOrder(tenantId: string, user: AuthenticatedUser, orderId: string) {
    await this.ensureCanUsePos(tenantId, user);
    assertSyntheticPreview();
    const id = await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id FROM "SalesOrder" WHERE id=$1 AND "tenantId"=$2 FOR UPDATE',
          orderId,
          tenantId,
        );
        if (!locked.length) throw new NotFoundException('Orden no encontrada.');
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: orderId },
          include: { items: true },
        });
        if (
          order.status !== SalesOrderStatus.IN_CASHIER ||
          order.claimedById !== user.id ||
          !order.claimExpiresAt ||
          order.claimExpiresAt <= new Date() ||
          !order.claimedCashSessionId ||
          order.invoiceId
        ) {
          throw new BadRequestException(
            'Toma la orden en una sesión de Caja abierta antes de preparar la prueba.',
          );
        }
        await this.lockOpenCashSessionForUser(tx, tenantId, user.id, order.claimedCashSessionId);
        if (order.fiscalDocumentTypeSnapshot !== InvoiceDocumentType.CONSUMER_ELECTRONIC_32) {
          throw new BadRequestException(
            'Este recorrido sintético inicial prepara E32; no convierte NCF ni confirma crédito fiscal.',
          );
        }
        if (order.total.gte(250000))
          throw new BadRequestException(
            'La prueba E32 sin comprador admite totales menores de RD$250,000.',
          );
        const revision = order.updatedAt.toISOString();
        const previous = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT id::text FROM corestack_preview_ecf.preparation WHERE tenant_id=$1 AND order_id=$2 AND revision=$3',
          tenantId,
          orderId,
          revision,
        );
        if (previous[0]) return previous[0].id;
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        if (!tenant.rnc || !tenant.legalName || !tenant.address)
          throw new BadRequestException(
            'Completa RNC, razón social y dirección del emisor de pruebas.',
          );
        const now = new Date();
        if (order.items.some((item) => item.originalUnitPrice === null))
          throw new BadRequestException(
            'Faltan evidencias fiscales de los productos; crea una orden nueva.',
          );
        const evidence = {
          operationId: `synthetic-${orderId}-${revision}`,
          issuedOn: businessDateKey(now),
          issuer: {
            rnc: tenant.rnc,
            legalName: `PRUEBA SIN VALIDEZ - ${tenant.legalName}`,
            address: tenant.address,
          },
        };
        // The order lock and revision lookup above make concurrent retries reuse
        // the same draft. No payment, stock movement, issuance or NCF is created.
        const draft = await tx.invoice.create({
          data: {
            tenantId,
            invoiceNumber: `SYNTHETIC-${orderId}-${revision}`,
            documentType: order.fiscalDocumentTypeSnapshot,
            status: InvoiceStatus.DRAFT,
            fiscalStatus: InvoiceFiscalStatus.NOT_APPLICABLE,
            fiscalIssuerSnapshot: evidence.issuer,
            paymentMode: order.paymentMode,
            dueDate: order.paymentMode === SalePaymentMode.CREDIT ? order.dueDate : null,
            subtotal: order.subtotal,
            discountTotal: order.discountTotal,
            taxTotal: order.taxTotal,
            total: order.total,
            items: {
              create: order.items.map((item) => ({
                productId: item.productId,
                sku: item.sku,
                barcode: item.barcode,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unitPrice: item.unitPrice,
                originalUnitPrice: item.originalUnitPrice,
                fiscalItemKind: resolveFiscalItemKind(item),
                discountTotal: item.discountTotal,
                taxCategory: item.taxCategory,
                taxRate: item.taxRate,
                subtotal: item.subtotal,
                taxTotal: item.taxTotal,
                total: item.total,
              })),
            },
          },
          include: { items: true },
        });
        const snapshot = projectPersistedElectronicSalesDraft(draft, {
          tenantId,
          operationId: evidence.operationId,
          issuedOn: evidence.issuedOn,
          incomeType: '01',
        });
        const core = fiscalPreviewCore();
        const scope = { tenantId, issuerRnc: tenant.rnc, environment: 'precertification' };
        if (process.env.RIVNU_PREVIEW_REMOTE_FISCAL === 'true') {
          if (tenantId !== 'cmt397emm0002nm0ogb50l2q6')
            throw new BadRequestException('PREVIEW_REMOTE_SCOPE');
          await core.enqueueFiscalDispatch(
            {
              query: async (sql, values) => ({
                rows: await tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values),
              }),
            },
            scope,
            core.adaptErpSalesSnapshot(scope, snapshot).request,
          );
        }
        const planned =
          new Date(now.getTime() - 4 * 3600_000).toISOString().slice(0, 19) + '-04:00';
        const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO corestack_preview_ecf.preparation
        (tenant_id,order_id,revision,snapshot,planned_at,execution_mode) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id::text`,
          tenantId,
          orderId,
          revision,
          JSON.stringify(snapshot),
          planned,
          process.env.RIVNU_PREVIEW_REMOTE_FISCAL === 'true' ? 'REMOTE_VM4' : 'LOCAL',
        );
        return inserted[0].id;
      },
      { timeout: 15000 },
    );
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<PreviewPreparationRow[]>(
          'SELECT id::text,snapshot,planned_at,revision,state,result,error_code,execution_mode,remote_ack FROM corestack_preview_ecf.preparation WHERE id=$1::bigint AND tenant_id=$2 FOR UPDATE',
          id,
          tenantId,
        );
        return rows[0].execution_mode === 'REMOTE_VM4'
          ? prepareRemotePreview(tx, rows[0], tenantId)
          : prepareSyntheticSnapshot(tx, rows[0], tenantId);
      },
      { timeout: 30000 },
    );
  }

  async searchProducts(tenantId: string, user: AuthenticatedUser, q: string) {
    await this.ensureCanCreateDirectSale(tenantId, user);
    const query = q.trim();

    if (!query) {
      return [];
    }

    return this.prisma.product.findMany({
      where: {
        tenantId,
        status: ProductStatus.ACTIVE,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { sku: { contains: query, mode: 'insensitive' } },
          { barcode: { contains: query, mode: 'insensitive' } },
          { brand: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: { category: true },
      orderBy: [{ stock: 'asc' }, { name: 'asc' }],
      take: 30,
    });
  }

  async findByBarcode(tenantId: string, user: AuthenticatedUser, barcode: string) {
    await this.ensureCanCreateDirectSale(tenantId, user);
    const lookupCandidates = getBarcodeLookupCandidates(barcode);
    const product = await this.prisma.product.findFirst({
      where: {
        tenantId,
        status: ProductStatus.ACTIVE,
        OR: [{ barcode: { in: lookupCandidates } }, { sku: { in: lookupCandidates } }],
      },
      include: {
        category: true,
      },
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

  async updateOrderFiscalDetails(
    tenantId: string,
    user: AuthenticatedUser,
    orderId: string,
    dto: UpdatePosFiscalDetailsDto,
  ) {
    await this.ensureCanUsePos(tenantId, user);

    return this.runSerializable(async (tx) => {
      const lockedOrder = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "SalesOrder"
        WHERE "id" = ${orderId}
          AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (lockedOrder.length !== 1) {
        throw new NotFoundException('Sales order not found for tenant.');
      }

      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: orderId },
        include: { creditApproval: true },
      });
      if (
        order.destination !== SalesOrderDestination.CASH_SALE ||
        order.status !== SalesOrderStatus.IN_CASHIER ||
        order.invoiceId
      ) {
        throw new BadRequestException(
          'Solo se pueden confirmar datos fiscales de una orden pendiente y reclamada en caja.',
        );
      }
      if (order.claimedById !== user.id) {
        throw new ForbiddenException('La orden está reclamada por otro cajero.');
      }
      if (!order.claimExpiresAt || order.claimExpiresAt.getTime() <= Date.now()) {
        throw new BadRequestException(
          'El reclamo de la orden venció. Vuelve a tomarla antes de cambiar sus datos fiscales.',
        );
      }
      if (!order.claimedCashSessionId) {
        throw new BadRequestException('La orden no está asociada a una sesión de caja.');
      }
      await this.lockOpenCashSessionForUser(tx, tenantId, user.id, order.claimedCashSessionId);

      const hasCustomerAssertion = Object.prototype.hasOwnProperty.call(dto, 'customerId');
      const requestedCustomerId = dto.customerId?.trim() || null;
      if (hasCustomerAssertion && requestedCustomerId !== order.customerId) {
        throw new BadRequestException('El cliente de la orden no puede cambiarse desde Caja.');
      }
      const hasInlineDocumentType = Object.prototype.hasOwnProperty.call(dto, 'documentType');
      const hasInlineDocumentNumber = Object.prototype.hasOwnProperty.call(dto, 'documentNumber');
      if (hasInlineDocumentType !== hasInlineDocumentNumber) {
        throw new BadRequestException(
          'Para una identidad fiscal puntual debes enviar tipo y número de documento.',
        );
      }
      if (order.paymentMode === SalePaymentMode.CREDIT) {
        if (!order.customerId) {
          throw new BadRequestException(
            'En una venta fiada no se puede cambiar ni quitar el cliente aprobado.',
          );
        }
        if (
          !order.creditApproval ||
          order.creditApproval.status !== CreditApprovalStatus.APPROVED ||
          order.creditApproval.customerId !== order.customerId
        ) {
          throw new BadRequestException(
            'La aprobación de crédito no coincide con el cliente de la orden.',
          );
        }
      }

      const customer = order.customerId
        ? await tx.customer.findFirst({
            where: {
              id: order.customerId,
              tenantId,
            },
          })
        : null;
      if (order.customerId && !customer) {
        throw new NotFoundException('Customer not found for tenant.');
      }

      if (hasInlineDocumentType && !order.clientName?.trim()) {
        throw new BadRequestException(
          'La orden debe tener el nombre del cliente antes de confirmar los datos fiscales.',
        );
      }

      const verifiedIdentity = hasInlineDocumentType
        ? this.taxIdentities.toVerificationSnapshot(
            await this.taxIdentities.requireUsableIdentity(
              {
                tenantId,
                documentType: dto.documentType!,
                documentNumber: dto.documentNumber!,
                contextType: TaxIdentityContextType.POS_ORDER,
                contextId: order.id,
                overrideId: dto.taxIdentityOverrideId,
              },
              {
                db: tx,
                consumeOverride: Boolean(dto.taxIdentityOverrideId),
              },
            ),
          )
        : null;
      const inlineCustomerSnapshot = verifiedIdentity
        ? buildInlineFiscalCustomerSnapshot(order.clientName, {
            ...verifiedIdentity,
            outcome: verifiedIdentity.source === 'MANUAL_OVERRIDE' ? 'MANUAL_OVERRIDE' : 'VERIFIED',
          })
        : null;
      if (verifiedIdentity && !inlineCustomerSnapshot) {
        throw new BadRequestException('No se pudo construir la identidad fiscal verificada.');
      }

      const fiscalDetails = this.resolveOrderFiscalDetails(
        dto.fiscalPurpose,
        FiscalIssuanceMode.ELECTRONIC_ECF,
        inlineCustomerSnapshot,
        dto.invoiceDocumentType,
      );
      if (isElectronicFiscalDocumentType(fiscalDetails.documentType)) {
        await this.fiscalSequences.assertElectronicAvailable(
          tenantId,
          fiscalDetails.documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ? 31 : 32,
        );
      } else if (fiscalDetails.documentType !== InvoiceDocumentType.LOCAL_SALE_NOTE) {
        await this.fiscalSequences.assertAvailable(tx, tenantId, fiscalDetails.documentType);
      }

      const updated = await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          fiscalPurpose: dto.fiscalPurpose,
          fiscalDocumentTypeSnapshot: fiscalDetails.documentType,
          fiscalCustomerSnapshot: fiscalDetails.customerSnapshot ?? Prisma.JsonNull,
        },
        include: this.posOrderInclude(),
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.id,
          action: 'POS_ORDER_FISCAL_DETAILS_UPDATED',
          entity: 'SalesOrder',
          entityId: order.id,
          metadata: {
            orderNumber: order.orderNumber,
            cashSessionId: order.claimedCashSessionId,
            previousFiscalPurpose: order.fiscalPurpose,
            fiscalPurpose: updated.fiscalPurpose,
            previousDocumentType: order.fiscalDocumentTypeSnapshot,
            documentType: updated.fiscalDocumentTypeSnapshot,
            previousCustomerId: order.customerId,
            customerId: order.customerId,
            fiscalIdentitySource:
              fiscalDetails.customerSnapshot?.verification?.source ??
              (fiscalDetails.customerSnapshot?.id ? 'REGISTERED_CUSTOMER' : 'NONE'),
            customerNameSource: fiscalDetails.customerSnapshot?.verification
              ? 'VERIFIED_FISCAL_IDENTITY'
              : fiscalDetails.customerSnapshot?.id
                ? 'CUSTOMER_RECORD'
                : 'NONE',
            operationalCustomerName: order.clientName,
            fiscalCustomerName: fiscalDetails.customerSnapshot?.name ?? null,
            customerDocumentType: fiscalDetails.customerSnapshot?.documentType ?? null,
            customerDocumentLast4: fiscalDetails.customerSnapshot?.documentNumber.slice(-4) ?? null,
          },
        },
      });

      return updated;
    });
  }

  async previewSale(tenantId: string, user: AuthenticatedUser, dto: CompleteSaleDto) {
    await this.ensureCanCreateDirectSale(tenantId, user);
    const computed = await this.computeSale(tenantId, dto.items ?? []);

    return {
      documentType: dto.documentType ?? InvoiceDocumentType.CONSUMER_02,
      paymentMethod: dto.paymentMethod,
      subtotal: computed.subtotal.toNumber(),
      discountTotal: computed.discountTotal.toNumber(),
      taxTotal: computed.taxTotal.toNumber(),
      total: computed.total.toNumber(),
      items: computed.items.map((item) => ({
        productId: item.product.id,
        name: item.product.name,
        sku: item.product.sku,
        barcode: item.product.barcode,
        quantity: item.quantity.toNumber(),
        unitPrice: item.unitPrice.toNumber(),
        discountTotal: item.discountTotal.toNumber(),
        subtotal: item.subtotal.toNumber(),
        taxTotal: item.taxTotal.toNumber(),
        total: item.total.toNumber(),
      })),
    };
  }

  async completeSale(tenantId: string, user: AuthenticatedUser, dto: CompleteSaleDto) {
    const membership = await this.ensureCanUsePos(tenantId, user);

    if (this.isAdminMembership(membership)) {
      throw new ForbiddenException(
        'Admins cannot complete POS sales. Cashiers must charge orders.',
      );
    }

    const orderId = dto.orderId;
    if (!orderId) {
      throw new ForbiddenException('Direct POS sales are disabled. Load an order to charge.');
    }
    this.ensureSupportedPaymentMethod(dto.paymentMethod);

    const completed = await this.runSerializable(async (tx) => {
      const cashSession = await this.findCashSessionForSale(
        tx,
        tenantId,
        user.id,
        dto.cashSessionId,
      );
      const order = await this.claimOrderForSale(tx, tenantId, user.id, cashSession.id, orderId);
      const documentType = order.fiscalDocumentTypeSnapshot;
      this.ensurePaymentMethodMatchesFiscalDocument(dto.paymentMethod, documentType);
      const electronic = isElectronicFiscalDocumentType(documentType);
      if (electronic) {
        await this.fiscalSequences.assertElectronicAvailable(
          tenantId,
          documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ? 31 : 32,
        );
      }
      if (
        !isSalesFiscalDocumentType(documentType) ||
        !fiscalDocumentTypeMatchesPurpose(order.fiscalPurpose, documentType)
      ) {
        throw new BadRequestException(
          'The sales order fiscal purpose and document snapshot are inconsistent.',
        );
      }
      if (dto.documentType && dto.documentType !== documentType) {
        throw new BadRequestException(
          'El tipo de comprobante fue fijado por la orden y no puede cambiarse al cobrar.',
        );
      }
      if (dto.customerId !== undefined) {
        const requestedCustomerId = dto.customerId?.trim() || null;
        if (requestedCustomerId !== order.customerId) {
          throw new BadRequestException(
            'Invoice customer is fixed by the sales order and cannot be changed at checkout.',
          );
        }
      }
      if (!electronic && documentType !== InvoiceDocumentType.LOCAL_SALE_NOTE) {
        throw new BadRequestException(
          'Caja solo puede emitir Nota de venta, E32 o E31 para las órdenes actuales.',
        );
      }

      const computed = await this.computeSaleFromOrder(order);

      if (!computed.items.length) {
        throw new BadRequestException('Sale must include at least one item.');
      }
      if (order && !computed.total.eq(order.total)) {
        throw new BadRequestException('Sales order totals are inconsistent and must be reviewed.');
      }

      const customerId = order.customerId ?? undefined;
      const isCreditSale = order.paymentMode === SalePaymentMode.CREDIT;
      if (isCreditSale && customerId) {
        await this.lockCustomer(tx, tenantId, customerId);
      }
      const customer = customerId
        ? await tx.customer.findFirst({
            where: {
              id: customerId,
              tenantId,
            },
          })
        : null;

      if (customerId && !customer) {
        throw new NotFoundException('Customer not found for tenant.');
      }

      if (isCreditSale) {
        if (
          !customer ||
          !order.creditApproval ||
          order.creditApproval.status !== CreditApprovalStatus.APPROVED
        ) {
          throw new BadRequestException(
            'Credit sale requires a registered customer and administrator approval.',
          );
        }
        if (
          customer.status !== CustomerStatus.ACTIVE ||
          !customer.creditEnabled ||
          customer.creditStatus !== CustomerCreditStatus.ACTIVE
        ) {
          throw new BadRequestException('Customer credit is disabled, blocked, or inactive.');
        }
        if (!order.dueDate) {
          throw new BadRequestException('Approved credit sale is missing its due date.');
        }
        if (
          order.creditApproval.tenantId !== tenantId ||
          order.creditApproval.salesOrderId !== order.id ||
          order.creditApproval.customerId !== customer.id ||
          !order.creditApproval.approvedById ||
          !order.creditApproval.approvedAt
        ) {
          throw new BadRequestException('Credit approval is inconsistent with the sales order.');
        }
        const expectedInitialPayment = computed.total
          .mul(order.initialPaymentRate)
          .toDecimalPlaces(2);
        const expectedFinancedAmount = computed.total
          .sub(expectedInitialPayment)
          .toDecimalPlaces(2);
        if (
          !order.initialPaymentOption ||
          !order.creditTermOption ||
          !order.initialPaymentAmount.eq(expectedInitialPayment) ||
          !order.creditApproval.requestedTotal.eq(computed.total) ||
          !order.creditApproval.initialPaymentAmount.eq(expectedInitialPayment) ||
          !order.creditApproval.financedAmount.eq(expectedFinancedAmount) ||
          order.creditApproval.initialPaymentOption !== order.initialPaymentOption ||
          order.creditApproval.creditTermOption !== order.creditTermOption ||
          businessDateKey(order.creditApproval.dueDate) !== businessDateKey(order.dueDate)
        ) {
          throw new BadRequestException('Approved credit terms do not match the sales order.');
        }
        if (businessDateKey(order.dueDate) <= businessDateKey(new Date())) {
          throw new BadRequestException('Credit due date must still be in the future at checkout.');
        }

        const outstanding = await tx.invoice.aggregate({
          where: {
            tenantId,
            customerId: customer.id,
            paymentMode: SalePaymentMode.CREDIT,
            status: {
              notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.VOID, InvoiceStatus.VOIDED],
            },
          },
          _sum: { balance: true },
        });
        const currentBalance = outstanding._sum.balance ?? new Prisma.Decimal(0);
        if (
          currentBalance.add(expectedFinancedAmount).gt(customer.creditLimit) &&
          !order.creditApproval.exceedsCreditLimit
        ) {
          throw new BadRequestException(
            'Current customer debt now exceeds the approved credit limit. A new approval is required.',
          );
        }
      }

      // The persisted subtotal is already net of line discounts. DGII's
      // DGII's RD$250,000 E32 identification threshold is evaluated before ITBIS.
      const netAmountBeforeTaxes = computed.subtotal.toDecimalPlaces(2);
      const requiresConsumerIdentity =
        documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32 &&
        netAmountBeforeTaxes.gte(250_000);
      const fiscalCustomerSnapshot = readFiscalCustomerSnapshot(order.fiscalCustomerSnapshot);
      if (
        fiscalCustomerSnapshot?.verification &&
        !this.isFreshFiscalIdentityVerification(
          fiscalCustomerSnapshot.verification.verifiedAt,
          new Date(),
        )
      ) {
        throw new BadRequestException(
          'La validación fiscal de la orden venció. Confirma nuevamente los datos fiscales antes de cobrar.',
        );
      }
      const hasVerifiedFiscalIdentity = Boolean(fiscalCustomerSnapshot?.verification);
      if (
        fiscalCustomerSnapshot &&
        fiscalCustomerSnapshot.id !== null &&
        fiscalCustomerSnapshot.id !== order.customerId
      ) {
        throw new BadRequestException(
          'The sales order fiscal customer snapshot is inconsistent with its customer.',
        );
      }
      if (
        isFiscalCreditDocumentType(documentType) &&
        (!fiscalCustomerSnapshot ||
          (fiscalCustomerSnapshot.documentType !== DocumentType.RNC &&
            fiscalCustomerSnapshot.documentType !== DocumentType.CEDULA) ||
          !hasVerifiedFiscalIdentity)
      ) {
        throw new BadRequestException(
          `${documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ? 'E31' : 'B01'} requiere confirmar un RNC o cédula verificado por DGII o validado manualmente por un administrador.`,
        );
      }
      if (requiresConsumerIdentity && (!fiscalCustomerSnapshot || !hasVerifiedFiscalIdentity)) {
        throw new BadRequestException(
          `Las facturas ${documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32 ? 'E32' : 'B02'} de RD$250,000 o más antes de ITBIS requieren una identidad verificada.`,
        );
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          rnc: true,
          legalName: true,
          commercialName: true,
          address: true,
          phone: true,
          email: true,
          branding: { select: { logoUrl: true } },
        },
      });
      if (
        !tenant?.rnc?.trim() ||
        (!validateDominicanRnc(tenant.rnc) && !validateDominicanCedula(tenant.rnc)) ||
        !tenant.legalName?.trim() ||
        !tenant.commercialName?.trim() ||
        !tenant.address?.trim() ||
        !tenant.phone?.trim() ||
        !tenant.email?.trim()
      ) {
        throw new BadRequestException(
          'Issuer tax identity, legal name, commercial name, address, phone, and email must be configured.',
        );
      }

      await this.lockOpenCashSessionForUser(tx, tenantId, user.id, cashSession.id);
      const sequence =
        electronic || documentType === InvoiceDocumentType.LOCAL_SALE_NOTE
          ? null
          : await this.fiscalSequences.reserve(tx, tenantId, documentType);
      const localSaleNumber =
        documentType === InvoiceDocumentType.LOCAL_SALE_NOTE
          ? await this.reserveLocalSaleNumber(tx, tenantId)
          : null;
      const requiredPayment = isCreditSale ? order.initialPaymentAmount : computed.total;
      const payment = this.getPaymentAmounts(
        dto.amountReceived,
        computed.total,
        dto.paymentMethod,
        requiredPayment,
      );
      const paidAmount = payment.paidAmount;
      const balance = computed.total.sub(paidAmount).toDecimalPlaces(2);
      const status = this.getInvoiceStatus(paidAmount, computed.total);
      const issuedAt = new Date();
      const invoiceNumber = electronic
        ? `RIV-ECF-PENDING-${order.id}`
        : localSaleNumber !== null
          ? `RIV-${localSaleNumber.toString().padStart(10, '0')}`
          : `RIV-${sequence!.ncf}`;

      let invoice = await tx.invoice.create({
        data: {
          tenantId,
          customerId: customer?.id ?? null,
          documentType,
          invoiceNumber,
          ncf: sequence?.ncf ?? null,
          eNcf: null,
          fiscalSequenceId: sequence?.id ?? null,
          fiscalAuthorizationNumber: sequence?.authorizationNumber ?? null,
          fiscalValidUntil: sequence?.validUntil ?? null,
          fiscalIssuerSnapshot: {
            rnc: normalizeDominicanDocument(tenant.rnc),
            legalName: tenant.legalName.trim(),
            commercialName: tenant.commercialName.trim(),
            address: tenant.address.trim(),
            phone: tenant.phone.trim(),
            email: tenant.email.trim(),
            logoUrl: tenant.branding?.logoUrl ?? null,
            pointOfSale: cashSession.cashRegister.name,
            pointOfSaleLocation: cashSession.cashRegister.location,
          },
          fiscalCustomerSnapshot: fiscalCustomerSnapshot ?? Prisma.JsonNull,
          status: electronic ? InvoiceStatus.DRAFT : status,
          fiscalStatus:
            electronic || documentType === InvoiceDocumentType.LOCAL_SALE_NOTE
              ? InvoiceFiscalStatus.NOT_APPLICABLE
              : InvoiceFiscalStatus.LOCAL_ISSUED,
          subtotal: computed.subtotal,
          taxTotal: computed.taxTotal,
          discountTotal: computed.discountTotal,
          total: computed.total,
          paidAmount,
          amountReceived: payment.amountReceived,
          changeAmount: payment.changeAmount,
          balance,
          paymentMode: isCreditSale ? SalePaymentMode.CREDIT : SalePaymentMode.CASH,
          paymentMethod: dto.paymentMethod,
          issuedById: user.id,
          cashSessionId: cashSession.id,
          issuedAt: electronic ? null : issuedAt,
          dueDate: isCreditSale ? order.dueDate : electronic ? null : issuedAt,
          items: {
            create: computed.items.map((item) => ({
              productId: item.productId,
              sku: item.sku,
              barcode: item.barcode,
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unitPrice: item.unitPrice,
              originalUnitPrice: item.originalUnitPrice,
              fiscalItemKind: item.fiscalItemKind,
              discountTotal: item.discountTotal,
              taxCategory: item.taxCategory,
              taxRate: item.taxRate,
              taxTotal: item.taxTotal,
              subtotal: item.subtotal,
              total: item.total,
            })),
          },
        },
        include: {
          customer: true,
          items: true,
          payments: true,
          electronicDocument: true,
        },
      });

      if (electronic) {
        const dispatch = buildElectronicFiscalDispatch(invoice, {
          tenantId,
          issuerRnc: normalizeDominicanDocument(tenant.rnc),
          operationId: `pos-${invoice.id}`,
          issuedOn: businessDateKey(issuedAt),
          incomeType: '01',
        });
        await tx.$executeRaw`
          INSERT INTO corestack_erp_fiscal.dispatch
            (tenant_id,issuer_rnc,environment,invoice_id,operation_id,request_text,payload_sha256)
          VALUES (
            ${tenantId},${normalizeDominicanDocument(tenant.rnc)},'production',${invoice.id},
            ${`pos-${invoice.id}`},${dispatch.requestText},${dispatch.payloadSha256}
          )
        `;
        invoice = await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            status: InvoiceStatus.PENDING_ECF,
            fiscalStatus: InvoiceFiscalStatus.PENDING_SEQUENCE,
            issuedAt,
          },
          include: {
            customer: true,
            items: true,
            payments: true,
            electronicDocument: true,
          },
        });
      }

      for (const item of [...computed.items].sort((a, b) =>
        a.productId.localeCompare(b.productId),
      )) {
        await this.applyInventoryForSale(tx, {
          tenantId,
          item,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          userId: user.id,
          fromOrder: true,
        });
      }

      if (paidAmount.gt(0)) {
        await tx.payment.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            method: dto.paymentMethod,
            amount: paidAmount,
            status: PaymentStatus.COMPLETED,
            userId: user.id,
            cashSessionId: cashSession.id,
            paidAt: issuedAt,
          },
        });

        await tx.cashMovement.create({
          data: {
            tenantId,
            cashSessionId: cashSession.id,
            userId: user.id,
            type: CashMovementType.SALE_PAYMENT,
            amount: paidAmount,
            method: dto.paymentMethod,
            reason: 'Pago de venta POS',
            reference: invoice.invoiceNumber,
            invoiceId: invoice.id,
          },
        });
      }

      await tx.employeeActivityLog.createMany({
        data: [
          {
            tenantId,
            userId: user.id,
            cashSessionId: cashSession.id,
            action: EmployeeLogAction.CREATE_SALE,
            entity: 'Invoice',
            entityId: invoice.id,
            invoiceId: invoice.id,
            amount: computed.total,
            metadata: {
              invoiceNumber,
              ncf: sequence?.ncf ?? null,
              electronicPending: electronic,
              paymentMethod: dto.paymentMethod,
              amountReceived: payment.amountReceived.toString(),
              changeAmount: payment.changeAmount.toString(),
              orderNumber: order?.orderNumber,
              status: invoice.status,
              destination: SalesOrderDestination.CASH_SALE,
              clientName: order.clientName ?? customer?.name,
              fiscalName: fiscalCustomerSnapshot?.name ?? null,
              fiscalIdentitySource: fiscalCustomerSnapshot?.verification?.source ?? null,
              fiscalDocumentLast4: fiscalCustomerSnapshot?.documentNumber.slice(-4) ?? null,
            },
          },
          {
            tenantId,
            userId: user.id,
            cashSessionId: cashSession.id,
            action: EmployeeLogAction.ISSUE_INVOICE,
            entity: 'Invoice',
            entityId: invoice.id,
            invoiceId: invoice.id,
            amount: computed.total,
            metadata: {
              invoiceNumber,
              ncf: sequence?.ncf ?? null,
              electronicPending: electronic,
              documentType,
              amountReceived: payment.amountReceived.toString(),
              changeAmount: payment.changeAmount.toString(),
              orderNumber: order?.orderNumber,
              status: invoice.status,
              destination: SalesOrderDestination.CASH_SALE,
              clientName: order.clientName ?? customer?.name,
              fiscalName: fiscalCustomerSnapshot?.name ?? null,
              fiscalIdentitySource: fiscalCustomerSnapshot?.verification?.source ?? null,
              fiscalDocumentLast4: fiscalCustomerSnapshot?.documentNumber.slice(-4) ?? null,
            },
          },
          ...(order
            ? [
                {
                  tenantId,
                  userId: user.id,
                  cashSessionId: cashSession.id,
                  action: EmployeeLogAction.COMPLETE_SALES_ORDER,
                  entity: 'SalesOrder',
                  entityId: order.id,
                  invoiceId: invoice.id,
                  amount: computed.total,
                  metadata: {
                    orderNumber: order.orderNumber,
                    invoiceNumber,
                    sourceDestination: order.orderNumber.startsWith('COT-')
                      ? SalesOrderDestination.QUOTATION
                      : order.destination,
                    sourceStatus: SalesOrderStatus.COMPLETED,
                    clientName: order.clientName,
                  },
                },
              ]
            : []),
        ],
      });

      if (order) {
        await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            status: SalesOrderStatus.COMPLETED,
            completedById: user.id,
            invoiceId: invoice.id,
            completedAt: issuedAt,
            claimExpiresAt: null,
          },
        });
      }

      if (isCreditSale && customer) {
        const aggregate = await tx.invoice.aggregate({
          where: {
            tenantId,
            customerId: customer.id,
            paymentMode: SalePaymentMode.CREDIT,
            status: {
              notIn: [InvoiceStatus.CANCELLED, InvoiceStatus.VOID, InvoiceStatus.VOIDED],
            },
          },
          _sum: { balance: true },
        });
        await tx.customer.update({
          where: { id: customer.id },
          data: { creditBalance: aggregate._sum.balance ?? new Prisma.Decimal(0) },
        });
      }

      return tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: {
          customer: true,
          items: true,
          payments: true,
          electronicDocument: true,
          issuedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          cashSession: {
            include: {
              cashRegister: true,
            },
          },
        },
      });
    });
    // Only after the serializable transaction commits. A failed wake must not
    // report a saved payment as failed; the durable scanner recovers the hint.
    if (isElectronicFiscalDocumentType(completed.documentType)) {
      try { this.fiscalDispatch?.wake(); }
      catch { this.logger.warn('ELECTRONIC_FISCAL_WAKE_DEFERRED'); }
    }
    return completed;
  }

  private async claimOrderForSale(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    cashSessionId: string,
    orderId: string,
  ) {
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + claimTtlMs);

    const claimed = await tx.salesOrder.updateMany({
      where: {
        id: orderId,
        tenantId,
        destination: SalesOrderDestination.CASH_SALE,
        invoiceId: null,
        status: SalesOrderStatus.IN_CASHIER,
        claimedById: userId,
        claimedCashSessionId: cashSessionId,
        claimExpiresAt: { gt: now },
      },
      data: {
        status: SalesOrderStatus.IN_CASHIER,
        claimedById: userId,
        claimedCashSessionId: cashSessionId,
        claimedAt: now,
        claimExpiresAt,
        releasedAt: null,
      },
    });

    if (claimed.count !== 1) {
      const existing = await tx.salesOrder.findFirst({
        where: { id: orderId, tenantId },
        select: {
          id: true,
          status: true,
          claimedById: true,
          invoiceId: true,
        },
      });

      if (!existing) {
        throw new NotFoundException('Pending sales order not found for tenant.');
      }

      if (existing.status === SalesOrderStatus.COMPLETED || existing.invoiceId) {
        throw new BadRequestException('Sales order has already been completed.');
      }

      if (existing.status === SalesOrderStatus.CANCELLED) {
        throw new BadRequestException('Sales order has already been cancelled.');
      }

      throw new BadRequestException('Sales order is already claimed by another cashier.');
    }

    return tx.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
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
  }

  private isFreshFiscalIdentityVerification(verifiedAt: string, checkedAt: Date) {
    const verifiedAtMs = Date.parse(verifiedAt);
    if (!Number.isFinite(verifiedAtMs)) {
      return false;
    }

    const ageMs = checkedAt.getTime() - verifiedAtMs;
    return ageMs >= -fiscalIdentityFutureSkewMs && ageMs <= claimTtlMs;
  }

  private async computeSale(
    tenantId: string,
    items: PosSaleItemDto[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    if (!items.length) {
      throw new BadRequestException('Sale must include at least one item.');
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
        id: {
          in: Array.from(quantitiesByProduct.keys()),
        },
        status: ProductStatus.ACTIVE,
      },
    });

    if (products.length !== quantitiesByProduct.size) {
      throw new NotFoundException('One or more POS products do not belong to tenant.');
    }

    const computedItems: ComputedSaleLine[] = allocateFiscalTaxByRate(products.map((product) => {
      const quantity = new Prisma.Decimal(quantitiesByProduct.get(product.id) ?? 0);
      const unitPrice = product.salePrice.gt(0) ? product.salePrice : product.price;
      const subtotal = quantity.mul(unitPrice).toDecimalPlaces(2);
      const discountTotal = new Prisma.Decimal(0);

      return {
        product,
        productId: product.id,
        sku: product.sku,
        barcode: product.barcode,
        description: product.name,
        quantity,
        unit: product.unit,
        reservedQuantity: 0,
        unitPrice,
        originalUnitPrice: unitPrice,
        fiscalItemKind: resolveFiscalItemKind(product),
        discountTotal,
        taxCategory: product.taxCategory,
        taxRate: product.taxRate,
        subtotal,
        taxTotal: new Prisma.Decimal(0),
        total: subtotal,
      };
    }));

    for (const item of computedItems) {
      const quantity = item.quantity.toNumber();
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

      if (item.product.trackInventory && availableStock < quantity) {
        throw new BadRequestException(`Insufficient available stock for ${item.product.name}.`);
      }
    }

    return {
      items: computedItems,
      subtotal: computedItems
        .reduce((sum, item) => sum.add(item.subtotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      discountTotal: computedItems
        .reduce((sum, item) => sum.add(item.discountTotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      taxTotal: computedItems
        .reduce((sum, item) => sum.add(item.taxTotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      total: computedItems
        .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
    };
  }

  private async computeSaleFromOrder(order: {
    items: Array<{
      productId: string | null;
      sku: string | null;
      barcode: string | null;
      description: string;
      quantity: Prisma.Decimal;
      unit: ProductUnit;
      reservedQuantity: number;
      unitPrice: Prisma.Decimal;
      originalUnitPrice: Prisma.Decimal | null;
      fiscalItemKind: Product['fiscalItemKind'];
      discountTotal: Prisma.Decimal;
      taxCategory: TaxCategory;
      taxRate: Prisma.Decimal;
      taxTotal: Prisma.Decimal;
      subtotal: Prisma.Decimal;
      total: Prisma.Decimal;
      product: Product | null;
    }>;
  }) {
    const computedItems: ComputedSaleLine[] = order.items.map((item) => {
      if (!item.productId || !item.product) {
        throw new BadRequestException('Sales order contains an unavailable product.');
      }

      return {
        product: item.product,
        productId: item.productId,
        sku: item.sku,
        barcode: item.barcode,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        reservedQuantity: item.reservedQuantity,
        unitPrice: item.unitPrice,
        // Preserve the frozen order unit and explicit classification. Legacy
        // NULL classifications are repaired deterministically from that
        // snapshot, never from mutable catalogue pricing or inventory state.
        originalUnitPrice: item.originalUnitPrice ?? null,
        fiscalItemKind: resolveFiscalItemKind(item),
        discountTotal: item.discountTotal,
        taxCategory: item.taxCategory,
        taxRate: item.taxRate,
        taxTotal: item.taxTotal,
        subtotal: item.subtotal,
        total: item.total,
      };
    });

    for (const item of computedItems) {
      const quantity = item.quantity.toNumber();

      if (
        item.product.trackInventory &&
        requiresWholeQuantity(item.unit) &&
        !Number.isInteger(quantity)
      ) {
        throw new BadRequestException(
          `Tracked product ${item.description} requires whole quantities.`,
        );
      }

      if (item.product.trackInventory && Math.abs(item.reservedQuantity - quantity) > 1e-9) {
        throw new BadRequestException(
          `Inventory reservation is incomplete for ${item.description}.`,
        );
      }

      if (item.product.trackInventory && item.product.stock < quantity) {
        throw new BadRequestException(`Insufficient stock for ${item.description}.`);
      }
    }

    return {
      items: computedItems,
      subtotal: computedItems
        .reduce((sum, item) => sum.add(item.subtotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      discountTotal: computedItems
        .reduce((sum, item) => sum.add(item.discountTotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      taxTotal: computedItems
        .reduce((sum, item) => sum.add(item.taxTotal), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
      total: computedItems
        .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0))
        .toDecimalPlaces(2),
    };
  }

  private async applyInventoryForSale(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      item: ComputedSaleLine;
      invoiceId: string;
      invoiceNumber: string;
      userId: string;
      fromOrder: boolean;
    },
  ) {
    const { tenantId, item, invoiceId, invoiceNumber, userId, fromOrder } = args;

    if (!item.product.trackInventory) {
      return;
    }

    const quantity = item.quantity.toNumber();
    if (requiresWholeQuantity(item.product.unit) && !Number.isInteger(quantity)) {
      throw new BadRequestException(
        `Tracked product ${item.description} requires whole quantities.`,
      );
    }

    const updated = fromOrder
      ? await tx.$queryRaw<Array<{ stock: number; reservedStock: number }>>`
          UPDATE "Product"
          SET
            "stock" = "stock" - ${quantity},
            "reservedStock" = GREATEST("reservedStock" - ${item.reservedQuantity}, 0)
          WHERE "id" = ${item.productId}
            AND "tenantId" = ${tenantId}
            AND "trackInventory" = TRUE
            AND "stock" >= ${quantity}
            AND "reservedStock" >= ${item.reservedQuantity}
          RETURNING "stock", "reservedStock"
        `
      : await tx.$queryRaw<Array<{ stock: number; reservedStock: number }>>`
          UPDATE "Product"
          SET "stock" = "stock" - ${quantity}
          WHERE "id" = ${item.productId}
            AND "tenantId" = ${tenantId}
            AND "trackInventory" = TRUE
            AND ("stock" - "reservedStock") >= ${quantity}
          RETURNING "stock", "reservedStock"
        `;

    if (updated.length !== 1) {
      const message = fromOrder
        ? `Insufficient stock for ${item.description}.`
        : `Insufficient available stock for ${item.description}.`;
      throw new BadRequestException(message);
    }

    const newStock = updated[0].stock;
    const previousStock = newStock + quantity;

    await tx.inventoryMovement.create({
      data: {
        tenantId,
        productId: item.productId,
        type: InventoryMovementType.SALE,
        quantity,
        previousStock,
        newStock,
        unitCost: item.product.cost,
        reason: fromOrder ? 'Venta POS facturada desde orden' : 'Venta POS facturada',
        reference: invoiceNumber,
        invoiceId,
        createdById: userId,
      },
    });
  }

  private async findCashSessionForSale(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    cashSessionId?: string,
  ) {
    const session = await tx.cashSession.findFirst({
      where: {
        tenantId,
        openedById: userId,
        status: CashSessionStatus.OPEN,
        ...(cashSessionId ? { id: cashSessionId } : {}),
      },
      orderBy: {
        openedAt: 'desc',
      },
      include: {
        cashRegister: true,
      },
    });

    if (!session) {
      throw new BadRequestException(
        'An open cash session for this cashier is required to complete POS sales.',
      );
    }

    return session;
  }

  private async lockCustomer(tx: Prisma.TransactionClient, tenantId: string, customerId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Customer"
      WHERE "id" = ${customerId}
        AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;

    if (rows.length !== 1) {
      throw new NotFoundException('Customer not found for tenant.');
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
      FOR UPDATE
    `;
    if (rows.length !== 1) {
      throw new BadRequestException('Selected cash session was not found.');
    }
    const openSession = await tx.cashSession.findFirst({
      where: {
        id: cashSessionId,
        tenantId,
        openedById: userId,
        status: CashSessionStatus.OPEN,
      },
      select: { id: true },
    });
    if (!openSession) {
      throw new BadRequestException('Selected cash session is no longer open for this cashier.');
    }
  }

  private resolveOrderFiscalDetails(
    purpose: FiscalDocumentPurpose,
    issuanceMode: FiscalIssuanceMode,
    inlineCustomerSnapshot: ReturnType<typeof buildInlineFiscalCustomerSnapshot>,
    requestedDocumentType?: InvoiceDocumentType,
  ) {
    const familyDocumentType = resolveCheckoutDocumentType(purpose, issuanceMode);
    const documentType = requestedDocumentType ?? familyDocumentType;

    if (documentType === InvoiceDocumentType.LOCAL_SALE_NOTE) {
      if (purpose !== FiscalDocumentPurpose.CONSUMER) {
        throw new BadRequestException(
          'La nota de venta solo puede utilizarse para una venta de consumo.',
        );
      }
    } else if (documentType !== familyDocumentType) {
      throw new BadRequestException('Caja solo permite seleccionar Nota de venta, E32 o E31.');
    }

    if (purpose === FiscalDocumentPurpose.FISCAL_CREDIT) {
      if (!inlineCustomerSnapshot) {
        throw new BadRequestException(
          `${documentType === InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31 ? 'E31' : 'B01'} requiere digitar un RNC o cédula válida en Caja para esta factura.`,
        );
      }

      return { documentType, customerSnapshot: inlineCustomerSnapshot };
    }

    if (inlineCustomerSnapshot) {
      return { documentType, customerSnapshot: inlineCustomerSnapshot };
    }
    return { documentType, customerSnapshot: null };
  }

  private async reserveLocalSaleNumber(tx: Prisma.TransactionClient, tenantId: string) {
    const sequence = await tx.localSaleSequence.upsert({
      where: { tenantId },
      create: { tenantId, nextNumber: 2n },
      update: { nextNumber: { increment: 1n } },
      select: { nextNumber: true },
    });

    return sequence.nextNumber - 1n;
  }

  private posOrderInclude() {
    return {
      customer: true,
      createdBy: { select: { id: true, name: true, email: true } },
      completedBy: { select: { id: true, name: true, email: true } },
      claimedBy: { select: { id: true, name: true, email: true } },
      claimedCashSession: {
        include: {
          cashRegister: true,
        },
      },
      invoice: { select: { id: true, invoiceNumber: true, total: true } },
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
    };
  }

  private async ensureCanCreateDirectSale(tenantId: string, user: AuthenticatedUser) {
    const membership = await this.ensureCanUsePos(tenantId, user);

    if (!this.isAdminMembership(membership)) {
      throw new ForbiddenException('Only admins can create direct POS sales.');
    }

    return membership;
  }

  private async ensureCanUsePos(tenantId: string, user: AuthenticatedUser) {
    const membership =
      user.memberships.find((candidate) =>
        ([Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN] as Role[]).includes(candidate.role),
      ) ?? user.memberships.find((candidate) => candidate.tenantId === tenantId);

    if (
      !membership ||
      (!membership.canUsePos && ![...adminRoles, Role.CASHIER].includes(membership.role))
    ) {
      throw new ForbiddenException('Employee does not have POS access.');
    }

    if (!this.isAdminMembership(membership)) {
      const employee = await this.prisma.employeeProfile.findFirst({
        where: {
          tenantId,
          userId: user.id,
          status: EmployeeStatus.ACTIVE,
        },
        select: { id: true },
      });

      if (!employee) {
        throw new ForbiddenException('Employee profile must be active to use POS.');
      }
    }

    return membership;
  }

  private isAdminMembership(membership: AuthenticatedUser['memberships'][number]) {
    return adminRoles.includes(membership.role);
  }

  private ensureSupportedPaymentMethod(paymentMethod: PaymentMethod) {
    const supportedMethods: PaymentMethod[] = [
      PaymentMethod.CASH,
      PaymentMethod.CARD,
      PaymentMethod.TRANSFER,
    ];
    if (!supportedMethods.includes(paymentMethod)) {
      throw new BadRequestException('POS payments only support cash, card, or transfer.');
    }
  }

  private ensurePaymentMethodMatchesFiscalDocument(
    paymentMethod: PaymentMethod,
    documentType: InvoiceDocumentType,
  ) {
    if (
      paymentMethod === PaymentMethod.CARD &&
      documentType === InvoiceDocumentType.LOCAL_SALE_NOTE
    ) {
      throw new BadRequestException('Los pagos con tarjeta requieren seleccionar E32 o E31.');
    }

    if (
      paymentMethod === PaymentMethod.CASH &&
      documentType === InvoiceDocumentType.CONSUMER_ELECTRONIC_32
    ) {
      throw new BadRequestException('Los pagos en efectivo requieren Nota de venta o E31.');
    }
  }

  /**
   * A completed POS sale writes the invoice, payment, cash movement, inventory,
   * order state, customer balance, local NCF and audit trail together.
   * Remote database latency can make that safely exceed Prisma's 5 second default.
   */
  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const attempts = 3;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
          throw new ServiceUnavailableException(
            'El cobro tardó demasiado y se revirtió por seguridad. Inténtalo nuevamente.',
          );
        }

        const canRetry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < attempts;
        if (!canRetry) {
          throw error;
        }
      }
    }

    throw new ServiceUnavailableException(
      'No se pudo completar el cobro por concurrencia. Inténtalo nuevamente.',
    );
  }

  private getPaymentAmounts(
    amountReceived: number | undefined,
    total: Prisma.Decimal,
    paymentMethod: PaymentMethod,
    requiredPayment: Prisma.Decimal = total,
  ) {
    const required = requiredPayment.toDecimalPlaces(2);
    if (required.lt(0) || required.gt(total)) {
      throw new BadRequestException('Required payment amount is invalid.');
    }
    const tendered = new Prisma.Decimal(amountReceived ?? required).toDecimalPlaces(2);

    if (tendered.lt(0)) {
      throw new BadRequestException('Amount received cannot be negative.');
    }

    if (required.isZero() && !tendered.isZero()) {
      throw new BadRequestException('This credit sale has no initial payment to collect.');
    }

    if (paymentMethod === PaymentMethod.CASH && tendered.lt(required)) {
      throw new BadRequestException('Cash received must cover the required initial payment.');
    }

    if (paymentMethod !== PaymentMethod.CASH && !tendered.eq(required)) {
      throw new BadRequestException(
        'Card and transfer payments must equal the required initial payment.',
      );
    }

    return {
      paidAmount: required,
      amountReceived: tendered,
      changeAmount:
        paymentMethod === PaymentMethod.CASH && tendered.gt(required)
          ? tendered.sub(required).toDecimalPlaces(2)
          : new Prisma.Decimal(0),
    };
  }

  private getInvoiceStatus(paidAmount: Prisma.Decimal, total: Prisma.Decimal) {
    if (paidAmount.gte(total)) {
      return InvoiceStatus.PAID;
    }

    if (paidAmount.gt(0)) {
      return InvoiceStatus.PARTIALLY_PAID;
    }

    return InvoiceStatus.ISSUED;
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

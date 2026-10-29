import { loadDashboardSnapshot, loadProductSalesSnapshot } from './dashboard-snapshot';
import { Injectable } from '@nestjs/common';
import {
  CashMovementType,
  CorporateUnitStatus,
  FiscalSequenceStatus,
  InvoiceStatus,
  Prisma,
  OrderExceptionStatus,
  OrderSource,
  PaymentMethod,
  ProductionStage,
  PurchaseOrderStatus,
  SalesOrderDestination,
  SalesOrderStatus,
} from '@qorvex/database';
import { addBusinessDays, businessDateKey } from '../../common/utils/business-date';
import { PrismaService } from '../../prisma/prisma.service';

const pendingInvoiceStatuses: InvoiceStatus[] = [
  InvoiceStatus.ISSUED,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.PENDING_ECF,
];

const terminalPurchaseOrderStatuses: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.RECEIVED,
  PurchaseOrderStatus.CANCELLED,
];

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(tenantId: string) {
    const now = new Date();
    const dateKey = businessDateKey(now);
    const [year, month] = dateKey.split('-').map(Number);
    const todayStart = new Date(dateKey + 'T00:00:00-04:00');
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    const accountingTodayKey = businessDateKey(now);
    const accountingTomorrowKey = businessDateKey(addBusinessDays(1, now));
    const accountingDueSoonEndKey = businessDateKey(addBusinessDays(8, now));

    const monthStart = new Date(Date.UTC(year, month - 1, 1, 4));
    const nextMonthStart = new Date(Date.UTC(year, month, 1, 4));
    const seriesStart = new Date(Date.UTC(year, month - 6, 1, 4));

    const {
      paymentsForMonth,
      paymentsForToday,
      returnsMonth,
      returnsToday,
      pendingReturnsAggregate,
      invoiceStatusCounts,
      activeCustomers,
      activeEmployees,
      openCashSessionDetails,
      orderStatusCounts,
      completedOrdersToday,
      completedReturns,
      pendingReturns,
      recentInvoices,
      recentReturns,
      recentCashMovements,
      recentEmployeeLogs,
      fiscalSequences,
      productsForStock,
      paymentsForSeries,
      returnsForSeries,
      quotationSalesInCashier,
      completedQuotationSalesToday,
      receivableInvoicesForAccounting,
      payableInvoicesForAccounting,
      purchaseOrdersForAccounting,
      awaitingReceiptCount,
      draftReceiptsCount,
      draftReceiptItemsForAccounting,
      pendingCreditApprovals,
      creditApprovalsExceedingLimit,
      recentAuditActivity,
      cashMovementsToday,
      invoicesToday,
      productionOrders,
      channelInvoicesThisMonth,
      collections,
      channelReturns,
    } = await loadDashboardSnapshot(this.prisma, tenantId, {
      todayStart,
      tomorrowStart,
      monthStart,
      nextMonthStart,
      seriesStart,
    });

    const activeProducts = productsForStock.length;
    const lowStockProductsList = productsForStock.filter(
      (product) =>
        product.trackInventory && product.stock - product.reservedStock <= product.minStock,
    );
    const productsInStock = productsForStock.filter((product) => product.stock > 0).length;
    const categoryCounts = new Map<string, number>();
    for (const product of productsForStock) {
      const categoryName = product.category?.name?.trim() || 'Sin categoría';
      categoryCounts.set(categoryName, (categoryCounts.get(categoryName) ?? 0) + 1);
    }
    const productCategories = Array.from(categoryCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((first, second) => second.count - first.count || first.name.localeCompare(second.name))
      .slice(0, 5);
    const recentInventoryAlerts = lowStockProductsList.slice(0, 5);
    const grossSalesMonth = this.decimalToNumber(paymentsForMonth._sum.total);
    const grossSalesToday = this.decimalToNumber(paymentsForToday._sum.total);
    const refundsMonth = this.decimalToNumber(returnsMonth._sum.refundAmount);
    const refundsToday = this.decimalToNumber(returnsToday._sum.refundAmount);
    const netSalesMonth = grossSalesMonth - refundsMonth;
    const netSalesToday = grossSalesToday - refundsToday;
    const pendingReturnAmount = this.decimalToNumber(pendingReturnsAggregate._sum.refundAmount);
    const countOrders = (status: SalesOrderStatus, destination?: SalesOrderDestination) =>
      orderStatusCounts
        .filter(
          (entry) => entry.status === status && (!destination || entry.destination === destination),
        )
        .reduce((total, entry) => total + groupedCount(entry), 0);
    const totalOrders = orderStatusCounts.reduce((total, entry) => total + groupedCount(entry), 0);
    const completedOrders = countOrders(SalesOrderStatus.COMPLETED);
    const pendingOrders = countOrders(
      SalesOrderStatus.SENT_TO_CASHIER,
      SalesOrderDestination.CASH_SALE,
    );
    const claimedOrders = countOrders(SalesOrderStatus.IN_CASHIER, SalesOrderDestination.CASH_SALE);
    const pendingQuotations = countOrders(
      SalesOrderStatus.QUOTATION,
      SalesOrderDestination.QUOTATION,
    );
    const otherOrders = Math.max(
      totalOrders - completedOrders - pendingOrders - claimedOrders - pendingQuotations,
      0,
    );
    const countInvoicesByStatus = (...statuses: InvoiceStatus[]) =>
      invoiceStatusCounts
        .filter((entry) => statuses.includes(entry.status))
        .reduce((total, entry) => total + groupedCount(entry), 0);
    const pendingInvoices = countInvoicesByStatus(...pendingInvoiceStatuses);
    const paidInvoices = countInvoicesByStatus(InvoiceStatus.PAID, InvoiceStatus.ACCEPTED);
    const draftInvoices = countInvoicesByStatus(InvoiceStatus.DRAFT);
    const cancelledInvoices = countInvoicesByStatus(
      InvoiceStatus.CANCELLED,
      InvoiceStatus.VOID,
      InvoiceStatus.VOIDED,
    );
    const openCashSessions = openCashSessionDetails.length;
    const quotationSalesInCashierAmount = this.sumOrderAmount(quotationSalesInCashier);
    const completedQuotationSalesTodayAmount = this.sumOrderAmount(completedQuotationSalesToday);
    const receivablesAccounting = this.buildAgingSummary(receivableInvoicesForAccounting, {
      todayKey: accountingTodayKey,
      tomorrowKey: accountingTomorrowKey,
      dueSoonEndKey: accountingDueSoonEndKey,
    });
    const payablesAccounting = this.buildAgingSummary(payableInvoicesForAccounting, {
      todayKey: accountingTodayKey,
      tomorrowKey: accountingTomorrowKey,
      dueSoonEndKey: accountingDueSoonEndKey,
    });
    const purchaseOrdersAccounting = {
      draftCount: purchaseOrdersForAccounting.filter(
        (order) => order.status === PurchaseOrderStatus.DRAFT,
      ).length,
      underReviewCount: purchaseOrdersForAccounting.filter(
        (order) =>
          order.status === PurchaseOrderStatus.REQUESTED ||
          order.status === PurchaseOrderStatus.UNDER_REVIEW,
      ).length,
      awaitingInvoiceCount: purchaseOrdersForAccounting.filter(
        (order) => order.status === PurchaseOrderStatus.ISSUED && !order.supplierInvoice,
      ).length,
      overdueCount: purchaseOrdersForAccounting.filter(
        (order) =>
          Boolean(order.expectedDeliveryDate) &&
          !terminalPurchaseOrderStatuses.includes(order.status) &&
          businessDateKey(order.expectedDeliveryDate!) < accountingTodayKey,
      ).length,
      partiallyReceivedCount: purchaseOrdersForAccounting.filter(
        (order) => order.status === PurchaseOrderStatus.PARTIALLY_RECEIVED,
      ).length,
      awaitingReceiptCount,
    };
    const itemsWithDifferenceCount = draftReceiptItemsForAccounting.filter(
      (item) =>
        Math.abs(
          this.decimalToNumber(item.quantityReceived) - this.decimalToNumber(item.quantityInvoiced),
        ) > 0.000001,
    ).length;
    const cashInTypes: CashMovementType[] = [
      CashMovementType.SALE_PAYMENT,
      CashMovementType.CREDIT_PAYMENT,
      CashMovementType.CASH_IN,
    ];
    const cashOutTypes: CashMovementType[] = [
      CashMovementType.CASH_OUT,
      CashMovementType.REFUND,
      CashMovementType.SUPPLIER_PAYMENT,
    ];
    const cashMovements = cashMovementsToday.filter(
      (movement) => !movement.method || movement.method === PaymentMethod.CASH,
    );
    const cashEntries = cashMovements.filter((movement) => cashInTypes.includes(movement.type));
    const cashExits = cashMovements.filter((movement) => cashOutTypes.includes(movement.type));
    const salesEntries = paymentsForSeries.map((invoice) => ({
      paidAt: invoice.issuedAt,
      amount: invoice.total,
    }));
    const salesSeries = this.buildSalesSeries(salesEntries, returnsForSeries, now);
    const previousMonthNetSales = salesSeries.at(-2)?.total ?? 0;
    const operationalOrders = productionOrders.filter(
      (order) => order.exceptionStatus !== OrderExceptionStatus.CANCELLED,
    );
    const openOperationalOrders = operationalOrders.filter(
      (order) => order.productionStage !== ProductionStage.DELIVERED,
    );
    const readyOrders = openOperationalOrders.filter(
      (order) => order.productionStage === ProductionStage.READY,
    );
    const attentionOrders = openOperationalOrders
      .map((order) => {
        const reasons: string[] = [];
        if (order.promisedAt && businessDateKey(order.promisedAt) < dateKey)
          reasons.push('Atrasada');
        if (order.priority === 'URGENT') reasons.push('Urgente');
        if (order.exceptionStatus === OrderExceptionStatus.PROBLEM) reasons.push('Con problema');
        if (order.exceptionStatus === OrderExceptionStatus.PAUSED) reasons.push('Pausada');
        if (order.requiresProduction && !order.designApprovedAt) reasons.push('Diseño pendiente');
        if (
          order.requiresProduction &&
          order.productionStage === ProductionStage.FACTORY &&
          !order.qualityApprovedAt
        )
          reasons.push('Calidad pendiente');
        return { order, reasons };
      })
      .filter((entry) => entry.reasons.length)
      .sort((first, second) => {
        const firstLate = first.reasons.includes('Atrasada') ? 0 : 1;
        const secondLate = second.reasons.includes('Atrasada') ? 0 : 1;
        if (firstLate !== secondLate) return firstLate - secondLate;
        return (
          (first.order.promisedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (second.order.promisedAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
        );
      })
      .slice(0, 8)
      .map(({ order, reasons }) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        clientName: order.clientName ?? 'Cliente general',
        invoiceId: order.invoiceId,
        productionStage: order.productionStage,
        promisedAt: order.promisedAt,
        source: order.source,
        reasons,
      }));
    const activeCorporateOrders = openOperationalOrders.filter((order) => order.isCorporate);
    const activeCorporateUnits = activeCorporateOrders.flatMap((order) => order.corporateUnits);
    const storeRefunds = channelReturns
      .filter((row) => row.invoice.salesOrder?.source !== OrderSource.SHOPIFY)
      .reduce((sum, row) => sum + Number(row.refundAmount), 0);
    const shopifyRefunds = channelReturns
      .filter((row) => row.invoice.salesOrder?.source === OrderSource.SHOPIFY)
      .reduce((sum, row) => sum + Number(row.refundAmount), 0);
    const storeSalesMonth =
      channelInvoicesThisMonth
        .filter((invoice) => invoice.salesOrder?.source !== OrderSource.SHOPIFY)
        .reduce((total, invoice) => total + this.decimalToNumber(invoice.total), 0) - storeRefunds;
    const shopifySalesMonth =
      channelInvoicesThisMonth
        .filter((invoice) => invoice.salesOrder?.source === OrderSource.SHOPIFY)
        .reduce((total, invoice) => total + this.decimalToNumber(invoice.total), 0) -
      shopifyRefunds;

    return {
      collectionsMonth: this.decimalToNumber(collections._sum.amount),
      totalBilledMonth: netSalesMonth,
      totalBilledToday: netSalesToday,
      grossSalesMonth,
      grossSalesToday,
      refundsMonth,
      refundsToday,
      netSalesMonth,
      netSalesToday,
      pendingReturnAmount,
      pendingInvoices,
      paidInvoices,
      draftInvoices,
      cancelledInvoices,
      activeCustomers,
      activeProducts,
      activeEmployees,
      totalOrders,
      completedOrders,
      invoicesToday,
      openCashSessions,
      pendingOrders,
      claimedOrders,
      ordersInCashier: pendingOrders + claimedOrders,
      pendingQuotations,
      quotationSalesInCashier: quotationSalesInCashier.length,
      quotationSalesInCashierAmount,
      completedQuotationSalesToday: completedQuotationSalesToday.length,
      completedQuotationSalesTodayAmount,
      completedOrdersToday,
      pendingReturns,
      completedReturns,
      lowStockProducts: lowStockProductsList.length,
      inventorySummary: {
        productsInStock,
        inStockPercentage: activeProducts
          ? Math.round((productsInStock / activeProducts) * 1000) / 10
          : 0,
      },
      productCategories,
      orderStatusSummary: {
        total: totalOrders,
        completed: completedOrders,
        pendingCashier: pendingOrders + claimedOrders,
        quotations: pendingQuotations,
        other: otherOrders,
      },
      cashToday: {
        entriesAmount: cashEntries.reduce(
          (total, movement) => total + this.decimalToNumber(movement.amount),
          0,
        ),
        entriesCount: cashEntries.length,
        exitsAmount: cashExits.reduce(
          (total, movement) => total + this.decimalToNumber(movement.amount),
          0,
        ),
        exitsCount: cashExits.length,
      },
      previousMonthNetSales,
      production: {
        waiting: operationalOrders.filter(
          (order) => order.productionStage === ProductionStage.WAITING,
        ).length,
        factory: operationalOrders.filter(
          (order) => order.productionStage === ProductionStage.FACTORY,
        ).length,
        ready: operationalOrders.filter((order) => order.productionStage === ProductionStage.READY)
          .length,
        delivered: operationalOrders.filter(
          (order) => order.productionStage === ProductionStage.DELIVERED,
        ).length,
        deliveredToday: operationalOrders.filter(
          (order) => order.deliveredAt !== null && order.deliveredAt >= todayStart,
        ).length,
        late: openOperationalOrders.filter(
          (order) => order.promisedAt !== null && businessDateKey(order.promisedAt) < dateKey,
        ).length,
        urgent: openOperationalOrders.filter((order) => order.priority === 'URGENT').length,
        problems: openOperationalOrders.filter(
          (order) =>
            order.exceptionStatus === OrderExceptionStatus.PROBLEM ||
            order.exceptionStatus === OrderExceptionStatus.PAUSED,
        ).length,
        shopify: openOperationalOrders.filter((order) => order.source === OrderSource.SHOPIFY)
          .length,
      },
      attentionOrders,
      salesByChannel: {
        store: storeSalesMonth,
        shopify: shopifySalesMonth,
      },
      delivery: {
        pickupReady: readyOrders.filter((order) => order.deliveryMethod === 'PICKUP').length,
        deliveryReady: readyOrders.filter((order) => order.deliveryMethod === 'DELIVERY').length,
        provinceReady: readyOrders.filter((order) => order.deliveryMethod === 'PROVINCE_SHIPPING')
          .length,
        promisedToday: openOperationalOrders.filter(
          (order) =>
            order.promisedAt !== null &&
            order.promisedAt >= todayStart &&
            order.promisedAt < tomorrowStart,
        ).length,
        overdue: openOperationalOrders.filter(
          (order) => order.promisedAt !== null && order.promisedAt < now,
        ).length,
      },
      corporate: {
        activeOrders: activeCorporateOrders.length,
        pendingUnits: activeCorporateUnits.filter(
          (unit) => unit.status === CorporateUnitStatus.PENDING,
        ).length,
        inProgressUnits: activeCorporateUnits.filter(
          (unit) => unit.status === CorporateUnitStatus.IN_PROGRESS,
        ).length,
        completedUnits: activeCorporateUnits.filter(
          (unit) => unit.status === CorporateUnitStatus.COMPLETED,
        ).length,
        pendingPartialDeliveries: activeCorporateUnits.filter(
          (unit) => unit.status === CorporateUnitStatus.COMPLETED && unit.deliveredAt === null,
        ).length,
      },
      openCashSessionDetails: openCashSessionDetails.map((session) => ({
        id: session.id,
        registerName: session.cashRegister.name,
        openedByName: session.openedBy.name,
        openingAmount: this.decimalToNumber(session.openingAmount),
        expectedCashAmount: this.calculateExpectedCashAmount(session),
        openedAt: session.openedAt,
      })),
      recentInvoices: recentInvoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer?.name ?? 'Consumidor final',
        status: invoice.status,
        total: this.decimalToNumber(invoice.total),
        cashierName: invoice.issuedBy?.name ?? null,
        issuedAt: invoice.issuedAt,
        createdAt: invoice.createdAt,
      })),
      recentReturns: recentReturns.map((returnRequest) => ({
        id: returnRequest.id,
        status: returnRequest.status,
        reason: returnRequest.reason,
        refundAmount: this.decimalToNumber(returnRequest.refundAmount),
        invoiceId: returnRequest.invoice.id,
        invoiceNumber: returnRequest.invoice.invoiceNumber,
        requestedByName: returnRequest.requestedBy.name,
        resolvedByName: returnRequest.approvedBy?.name ?? returnRequest.rejectedBy?.name ?? null,
        createdAt: returnRequest.createdAt,
        completedAt: returnRequest.completedAt,
      })),
      recentCashMovements: recentCashMovements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        amount: this.decimalToNumber(movement.amount),
        method: movement.method,
        reason: movement.reason,
        reference: movement.reference,
        cashierName: movement.user.name,
        registerName: movement.cashSession.cashRegister.name,
        invoiceNumber: movement.invoice?.invoiceNumber ?? null,
        createdAt: movement.createdAt,
      })),
      recentEmployeeLogs: recentEmployeeLogs.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        amount: this.decimalToNumber(log.amount),
        employeeName: log.user.name,
        invoiceNumber: log.invoice?.invoiceNumber ?? null,
        createdAt: log.createdAt,
      })),
      fiscalSequenceAlerts: fiscalSequences
        .filter(
          (sequence, index, allSequences) =>
            sequence.status === FiscalSequenceStatus.ACTIVE ||
            (!allSequences.some(
              (candidate) =>
                candidate.documentType === sequence.documentType &&
                candidate.status === FiscalSequenceStatus.ACTIVE,
            ) &&
              allSequences.findIndex(
                (candidate) => candidate.documentType === sequence.documentType,
              ) === index),
        )
        .map((sequence) => {
          const total = sequence.endNumber - sequence.startNumber + 1;
          const remaining = Math.max(sequence.endNumber - sequence.nextNumber + 1, 0);
          const threshold = Math.max(25, Math.ceil(total * 0.1));
          const expired =
            sequence.status === FiscalSequenceStatus.EXPIRED ||
            (sequence.validUntil !== null && sequence.validUntil < now);
          const exhausted = sequence.status === FiscalSequenceStatus.EXHAUSTED || remaining === 0;

          return {
            id: sequence.id,
            documentType: sequence.documentType,
            prefix: sequence.prefix,
            nextNumber: sequence.nextNumber,
            endNumber: sequence.endNumber,
            remaining,
            threshold,
            validUntil: sequence.validUntil,
            status: sequence.status,
            severity:
              expired || exhausted || remaining <= Math.max(5, Math.ceil(total * 0.02))
                ? 'critical'
                : 'warning',
            expired,
            exhausted,
          };
        })
        .filter(
          (sequence) =>
            sequence.expired || sequence.exhausted || sequence.remaining <= sequence.threshold,
        ),
      employeeSummary: {
        activeEmployees,
        openCashSessions,
      },
      accounting: {
        receivables: receivablesAccounting,
        payables: payablesAccounting,
        purchaseOrders: purchaseOrdersAccounting,
        receipts: {
          draftCount: draftReceiptsCount,
          itemsWithDifferenceCount,
        },
        creditApprovals: {
          pendingCount: pendingCreditApprovals._count._all,
          pendingFinancedAmount: this.decimalToNumber(pendingCreditApprovals._sum.financedAmount),
          exceedsLimitCount: creditApprovalsExceedingLimit,
        },
      },
      recentAuditActivity: recentAuditActivity.map((activity) => ({
        id: activity.id,
        action: activity.action,
        entity: activity.entity,
        entityId: activity.entityId,
        userName: activity.user?.name ?? null,
        createdAt: activity.createdAt,
      })),
      recentInventoryAlerts,
      salesSeries,
      dailySalesSeries: this.buildDailySalesSeries(salesEntries, returnsForSeries, now),
    };
  }

  async getProductSales(tenantId: string) {
    const now = new Date();
    const [year, month] = businessDateKey(now).split('-').map(Number);
    const salesSince = new Date(Date.UTC(year, month - 12, 1, 4));
    const { products, invoiceItems } = await loadProductSalesSnapshot(
      this.prisma,
      tenantId,
      salesSince,
    );

    const ranking = this.buildProductSalesRanking(
      products,
      invoiceItems.map((item) => ({
        ...item,
        quantity: Prisma.Decimal.max(
          0,
          item.quantity.sub(
            item.returnRequestItems.reduce(
              (sum, row) => sum.add(row.quantity),
              new Prisma.Decimal(0),
            ),
          ),
        ),
        total: Prisma.Decimal.max(
          0,
          item.total.sub(
            item.returnRequestItems.reduce((sum, row) => sum.add(row.total), new Prisma.Decimal(0)),
          ),
        ),
      })),
    );

    return {
      generatedAt: new Date(),
      periodStart: salesSince,
      productCount: products.length,
      productsWithSales: ranking.mostSold.filter((product) => product.quantitySold > 0).length,
      productsWithoutSales: ranking.leastSold.filter((product) => product.quantitySold === 0)
        .length,
      mostSold: ranking.mostSold,
      leastSold: ranking.leastSold,
    };
  }

  private buildSalesSeries(
    payments: Array<{
      paidAt: Date | null;
      amount: { toNumber(): number };
    }>,
    returns: Array<{
      completedAt: Date | null;
      refundAmount: { toNumber(): number };
    }>,
    now: Date,
  ) {
    const buckets = new Map<string, number>();

    for (let index = 5; index >= 0; index -= 1) {
      const [year, month] = businessDateKey(now).split('-').map(Number);
      const date = new Date(Date.UTC(year, month - index - 1, 1, 4));
      buckets.set(this.monthKey(date), 0);
    }

    for (const payment of payments) {
      if (!payment.paidAt) {
        continue;
      }

      const key = this.monthKey(payment.paidAt);
      buckets.set(key, (buckets.get(key) ?? 0) + this.decimalToNumber(payment.amount));
    }

    for (const returnRequest of returns) {
      if (!returnRequest.completedAt) {
        continue;
      }

      const key = this.monthKey(returnRequest.completedAt);
      buckets.set(key, (buckets.get(key) ?? 0) - this.decimalToNumber(returnRequest.refundAmount));
    }

    return Array.from(buckets.entries()).map(([month, total]) => ({
      month,
      total,
    }));
  }

  private buildDailySalesSeries(
    payments: Array<{
      paidAt: Date | null;
      amount: { toNumber(): number };
    }>,
    returns: Array<{
      completedAt: Date | null;
      refundAmount: { toNumber(): number };
    }>,
    now: Date,
  ) {
    const [businessYear, businessMonth] = businessDateKey(now).split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(businessYear, businessMonth, 0)).getUTCDate();
    const buckets = new Map<number, number>(
      Array.from({ length: daysInMonth }, (_, index) => [index + 1, 0]),
    );

    for (const payment of payments) {
      if (
        !payment.paidAt ||
        businessDateKey(payment.paidAt).slice(0, 7) !== businessDateKey(now).slice(0, 7)
      ) {
        continue;
      }

      const day = Number(businessDateKey(payment.paidAt).slice(8));
      buckets.set(day, (buckets.get(day) ?? 0) + this.decimalToNumber(payment.amount));
    }

    for (const returnRequest of returns) {
      if (
        !returnRequest.completedAt ||
        businessDateKey(returnRequest.completedAt).slice(0, 7) !== businessDateKey(now).slice(0, 7)
      ) {
        continue;
      }

      const day = Number(businessDateKey(returnRequest.completedAt).slice(8));
      buckets.set(day, (buckets.get(day) ?? 0) - this.decimalToNumber(returnRequest.refundAmount));
    }

    return Array.from(buckets.entries()).map(([day, total]) => ({ day, total }));
  }

  private monthKey(date: Date) {
    return new Intl.DateTimeFormat('es-DO', {
      month: 'short',
      timeZone: 'America/Santo_Domingo',
    }).format(date);
  }

  private buildProductSalesRanking(
    products: Array<{
      id: string;
      name: string;
      sku: string | null;
      brand: string | null;
      unit: string;
      price: { toNumber(): number };
      category: { id: string; name: string } | null;
      barcode: string | null;
    }>,
    invoiceItems: Array<{
      invoiceId: string;
      productId: string | null;
      sku: string | null;
      barcode: string | null;
      quantity: { toNumber(): number };
      total: { toNumber(): number };
      invoice: {
        issuedAt: Date | null;
        createdAt: Date;
      };
    }>,
  ) {
    const activeProductIds = new Set(products.map((product) => product.id));
    const productIdsBySku = this.buildUniqueProductCodeIndex(products, 'sku');
    const productIdsByBarcode = this.buildUniqueProductCodeIndex(products, 'barcode');
    const aggregates = new Map<
      string,
      {
        quantitySold: number;
        grossAmount: number;
        invoiceIds: Set<string>;
        lastSoldAt: Date | null;
      }
    >();

    for (const item of invoiceItems) {
      const productId =
        (item.productId && activeProductIds.has(item.productId) ? item.productId : null) ??
        this.findProductIdByCode(productIdsBySku, item.sku) ??
        this.findProductIdByCode(productIdsByBarcode, item.barcode);

      if (!productId) {
        continue;
      }

      const aggregate = aggregates.get(productId) ?? {
        quantitySold: 0,
        grossAmount: 0,
        invoiceIds: new Set<string>(),
        lastSoldAt: null,
      };
      const soldAt = item.invoice.issuedAt ?? item.invoice.createdAt;

      aggregate.quantitySold += this.decimalToNumber(item.quantity);
      aggregate.grossAmount += this.decimalToNumber(item.total);
      aggregate.invoiceIds.add(item.invoiceId);

      if (!aggregate.lastSoldAt || soldAt > aggregate.lastSoldAt) {
        aggregate.lastSoldAt = soldAt;
      }

      aggregates.set(productId, aggregate);
    }

    const ranking = products.map((product) => {
      const aggregate = aggregates.get(product.id);

      return {
        productId: product.id,
        name: product.name,
        sku: product.sku,
        brand: product.brand,
        unit: product.unit,
        categoryName: product.category?.name ?? 'Sin categoria',
        currentPrice: this.decimalToNumber(product.price),
        quantitySold: aggregate?.quantitySold ?? 0,
        grossAmount: aggregate?.grossAmount ?? 0,
        invoiceCount: aggregate?.invoiceIds.size ?? 0,
        lastSoldAt: aggregate?.lastSoldAt ?? null,
      };
    });

    return {
      mostSold: [...ranking].sort((first, second) => {
        const quantityDiff = second.quantitySold - first.quantitySold;
        return (
          quantityDiff ||
          second.grossAmount - first.grossAmount ||
          first.name.localeCompare(second.name)
        );
      }),
      leastSold: [...ranking].sort((first, second) => {
        const quantityDiff = first.quantitySold - second.quantitySold;
        return (
          quantityDiff ||
          first.grossAmount - second.grossAmount ||
          first.name.localeCompare(second.name)
        );
      }),
    };
  }

  private buildUniqueProductCodeIndex<
    T extends { id: string; sku: string | null; barcode: string | null },
  >(products: T[], field: 'sku' | 'barcode') {
    const index = new Map<string, string | null>();

    for (const product of products) {
      const code = this.normalizeProductCode(product[field]);
      if (!code) continue;
      index.set(code, index.has(code) ? null : product.id);
    }

    return index;
  }

  private findProductIdByCode(index: Map<string, string | null>, value: string | null) {
    const code = this.normalizeProductCode(value);
    return code ? (index.get(code) ?? null) : null;
  }

  private normalizeProductCode(value: string | null) {
    return value?.trim().toUpperCase() || null;
  }

  private decimalToNumber(value: { toNumber(): number } | null | undefined) {
    return value ? value.toNumber() : 0;
  }

  private buildAgingSummary(
    invoices: Array<{
      balance: { toNumber(): number };
      dueDate: Date | null;
    }>,
    boundaries: {
      todayKey: string;
      tomorrowKey: string;
      dueSoonEndKey: string;
    },
  ) {
    let outstandingBalance = 0;
    let overdueBalance = 0;
    let overdueCount = 0;
    let dueTodayCount = 0;
    let dueSoonCount = 0;

    for (const invoice of invoices) {
      const balance = Math.max(this.decimalToNumber(invoice.balance), 0);

      if (!balance) {
        continue;
      }

      outstandingBalance += balance;

      if (!invoice.dueDate) {
        continue;
      }

      const dueDateKey = businessDateKey(invoice.dueDate);
      if (dueDateKey < boundaries.todayKey) {
        overdueCount += 1;
        overdueBalance += balance;
      } else if (dueDateKey === boundaries.todayKey) {
        dueTodayCount += 1;
      } else if (dueDateKey >= boundaries.tomorrowKey && dueDateKey < boundaries.dueSoonEndKey) {
        dueSoonCount += 1;
      }
    }

    return {
      outstandingBalance,
      overdueBalance,
      overdueCount,
      dueTodayCount,
      dueSoonCount,
      openInvoiceCount: invoices.length,
    };
  }

  private sumOrderAmount(orders: Array<{ total: { toNumber(): number } }>) {
    return orders.reduce((sum, order) => sum + this.decimalToNumber(order.total), 0);
  }

  private getInvoicePaidAmount(invoice: {
    paidAmount: { toNumber(): number };
    total: { toNumber(): number };
  }) {
    const paidAmount = this.decimalToNumber(invoice.paidAmount);
    return paidAmount > 0 ? paidAmount : 0;
  }

  private calculateExpectedCashAmount(session: {
    openingAmount: { toNumber(): number };
    movements: Array<{
      type: CashMovementType;
      amount: { toNumber(): number };
      method: PaymentMethod | null;
    }>;
  }) {
    const negativeMovementTypes: CashMovementType[] = [
      CashMovementType.CASH_OUT,
      CashMovementType.REFUND,
      CashMovementType.SUPPLIER_PAYMENT,
    ];

    return session.movements.reduce((sum, movement) => {
      if (movement.type === CashMovementType.CLOSING) {
        return sum;
      }

      if (movement.method && movement.method !== PaymentMethod.CASH) {
        return sum;
      }

      const amount = this.decimalToNumber(movement.amount);
      return negativeMovementTypes.includes(movement.type) ? sum - amount : sum + amount;
    }, this.decimalToNumber(session.openingAmount));
  }
}

function groupedCount(entry: { _count?: true | { _all?: number } }) {
  return typeof entry._count === 'object' ? (entry._count._all ?? 0) : 0;
}

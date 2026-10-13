import { Prisma, PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

const ALLPA_TENANT_SLUG = 'allpa';
const execute = process.argv.includes('--execute');
const requestedTenantSlug = getArgumentValue('--tenant');
const confirmation = getArgumentValue('--confirm');
const backupMarker = getArgumentValue('--backup-marker');

const operationalCountQueries = (client: Prisma.TransactionClient | PrismaClient, tenantId: string) => ({
  salesOrders: client.salesOrder.count({ where: { tenantId } }),
  salesOrderItems: client.salesOrderItem.count({ where: { salesOrder: { tenantId } } }),
  discountApprovals: client.discountApproval.count({ where: { tenantId } }),
  creditSaleApprovals: client.creditSaleApproval.count({ where: { tenantId } }),
  invoices: client.invoice.count({ where: { tenantId } }),
  invoiceItems: client.invoiceItem.count({ where: { invoice: { tenantId } } }),
  payments: client.payment.count({ where: { tenantId } }),
  electronicDocuments: client.electronicDocument.count({ where: { tenantId } }),
  returnRequests: client.returnRequest.count({ where: { tenantId } }),
  returnRequestItems: client.returnRequestItem.count({ where: { returnRequest: { tenantId } } }),
  storeCredits: client.storeCredit.count({ where: { tenantId } }),
  storeCreditRedemptions: client.storeCreditRedemption.count({ where: { tenantId } }),
  customers: client.customer.count({ where: { tenantId } }),
  inventoryMovements: client.inventoryMovement.count({ where: { tenantId } }),
  warehouseMovements: client.warehouseMovement.count({ where: { tenantId } }),
  suppliers: client.supplier.count({ where: { tenantId } }),
  supplierProducts: client.supplierProduct.count({ where: { tenantId } }),
  purchaseOrders: client.purchaseOrder.count({ where: { tenantId } }),
  purchaseOrderItems: client.purchaseOrderItem.count({ where: { tenantId } }),
  purchaseOrderEvents: client.purchaseOrderEvent.count({ where: { tenantId } }),
  supplierInvoices: client.supplierInvoice.count({ where: { tenantId } }),
  supplierInvoiceItems: client.supplierInvoiceItem.count({ where: { tenantId } }),
  supplierInvoiceAttachments: client.supplierInvoiceAttachment.count({ where: { tenantId } }),
  supplierPayments: client.supplierPayment.count({ where: { tenantId } }),
  goodsReceipts: client.goodsReceipt.count({ where: { tenantId } }),
  goodsReceiptItems: client.goodsReceiptItem.count({ where: { tenantId } }),
  mobileOcrCaptureSessions: client.mobileOcrCaptureSession.count({ where: { tenantId } }),
  cashSessions: client.cashSession.count({ where: { tenantId } }),
  cashMovements: client.cashMovement.count({ where: { tenantId } }),
  fiscalSequences: client.fiscalSequence.count({ where: { tenantId } }),
  importBatches: client.importBatch.count({ where: { tenantId } }),
  importBatchRows: client.importBatchRow.count({ where: { importBatch: { tenantId } } }),
  importRowErrors: client.importRowError.count({ where: { importBatch: { tenantId } } }),
  employeeActivityLogs: client.employeeActivityLog.count({ where: { tenantId } }),
  auditLogs: client.auditLog.count({ where: { tenantId } }),
});

function getArgumentValue(name: string) {
  const inlineArgument = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inlineArgument) return inlineArgument.slice(name.length + 1);

  const argumentIndex = process.argv.indexOf(name);
  return argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
}

function assertTargetTenant() {
  if (requestedTenantSlug !== ALLPA_TENANT_SLUG) {
    throw new Error(`This cleanup is restricted to --tenant=${ALLPA_TENANT_SLUG}.`);
  }
}

async function getOperationalCounts(client: Prisma.TransactionClient | PrismaClient, tenantId: string) {
  const queries = operationalCountQueries(client, tenantId);
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, query]) => [name, await query] as const),
  );
  return Object.fromEntries(entries) as Record<keyof typeof queries, number>;
}

async function getProtectedSnapshot(client: Prisma.TransactionClient | PrismaClient, tenantId: string) {
  const [tenant, companyBranding, cashRegisters, memberships, employeeProfiles, users, products, categories, warehouseStocks] =
    await Promise.all([
      client.tenant.count({ where: { id: tenantId } }),
      client.companyBranding.count({ where: { tenantId } }),
      client.cashRegister.count({ where: { tenantId } }),
      client.membership.count({ where: { tenantId } }),
      client.employeeProfile.count({ where: { tenantId } }),
      client.user.count({ where: { memberships: { some: { tenantId } } } }),
      client.product.findMany({
        where: { tenantId },
        select: { id: true, stock: true, reservedStock: true },
        orderBy: { id: 'asc' },
      }),
      client.productCategory.findMany({
        where: { tenantId },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
      client.warehouseStock.findMany({
        where: { tenantId },
        select: { id: true, productId: true, quantity: true, unitCost: true },
        orderBy: { id: 'asc' },
      }),
    ]);

  return {
    tenant,
    companyBranding,
    cashRegisters,
    memberships,
    employeeProfiles,
    users,
    products,
    categories,
    warehouseStocks,
  };
}

function printCounts(title: string, counts: Record<string, number>) {
  console.log(`\n${title}`);
  for (const [name, count] of Object.entries(counts)) console.log(`- ${name}: ${count}`);
}

function summarizeProtected(snapshot: Awaited<ReturnType<typeof getProtectedSnapshot>>) {
  return {
    tenant: snapshot.tenant,
    companyBranding: snapshot.companyBranding,
    cashRegisters: snapshot.cashRegisters,
    memberships: snapshot.memberships,
    employeeProfiles: snapshot.employeeProfiles,
    users: snapshot.users,
    products: snapshot.products.length,
    productCategories: snapshot.categories.length,
    warehouseStocks: snapshot.warehouseStocks.length,
  };
}

async function cleanOperationalData(tenantId: string) {
  return prisma.$transaction(
    async (tx) => {
      const protectedBefore = await getProtectedSnapshot(tx, tenantId);

      await tx.employeeActivityLog.deleteMany({ where: { tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.cashMovement.deleteMany({ where: { tenantId } });

      await tx.storeCreditRedemption.deleteMany({ where: { tenantId } });
      await tx.storeCredit.deleteMany({ where: { tenantId } });
      await tx.returnRequestItem.deleteMany({ where: { returnRequest: { tenantId } } });
      await tx.returnRequest.deleteMany({ where: { tenantId } });
      await tx.discountApproval.deleteMany({ where: { tenantId } });
      await tx.creditSaleApproval.deleteMany({ where: { tenantId } });
      await tx.salesOrderItem.deleteMany({ where: { salesOrder: { tenantId } } });
      await tx.salesOrder.deleteMany({ where: { tenantId } });
      await tx.electronicDocument.deleteMany({ where: { tenantId } });
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.inventoryMovement.deleteMany({ where: { tenantId } });
      await tx.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
      await tx.invoice.deleteMany({ where: { tenantId } });

      await tx.mobileOcrCaptureSession.deleteMany({ where: { tenantId } });
      await tx.warehouseMovement.deleteMany({ where: { tenantId } });
      await tx.goodsReceiptItem.deleteMany({ where: { tenantId } });
      await tx.goodsReceipt.deleteMany({ where: { tenantId } });
      await tx.supplierInvoiceAttachment.deleteMany({ where: { tenantId } });
      await tx.supplierPayment.deleteMany({ where: { tenantId } });
      await tx.supplierInvoiceItem.deleteMany({ where: { tenantId } });
      await tx.supplierInvoice.deleteMany({ where: { tenantId } });
      await tx.purchaseOrderEvent.deleteMany({ where: { tenantId } });
      await tx.purchaseOrderItem.deleteMany({ where: { tenantId } });
      await tx.purchaseOrder.deleteMany({ where: { tenantId } });
      await tx.supplierProduct.deleteMany({ where: { tenantId } });
      await tx.supplier.deleteMany({ where: { tenantId } });

      await tx.importRowError.deleteMany({ where: { importBatch: { tenantId } } });
      await tx.importBatchRow.deleteMany({ where: { importBatch: { tenantId } } });
      await tx.importBatch.deleteMany({ where: { tenantId } });

      await tx.customer.deleteMany({ where: { tenantId } });
      await tx.cashSession.deleteMany({ where: { tenantId } });
      await tx.fiscalSequence.deleteMany({ where: { tenantId } });

      // Reservations belong to pending orders. Physical inventory is intentionally untouched.
      await tx.product.updateMany({ where: { tenantId }, data: { reservedStock: 0 } });

      const operationalAfter = await getOperationalCounts(tx, tenantId);
      if (Object.values(operationalAfter).some((count) => count !== 0)) {
        throw new Error(`Operational records remain: ${JSON.stringify(operationalAfter)}`);
      }

      const protectedAfter = await getProtectedSnapshot(tx, tenantId);
      const expectedProducts = protectedBefore.products.map((product) => ({ ...product, reservedStock: 0 }));
      const expectedProtected = { ...protectedBefore, products: expectedProducts };
      if (JSON.stringify(expectedProtected) !== JSON.stringify(protectedAfter)) {
        throw new Error('A protected employee, product, inventory, company or cash-register record changed.');
      }

      return { operationalAfter, protectedAfter };
    },
    { maxWait: 20_000, timeout: 180_000 },
  );
}

async function main() {
  assertTargetTenant();

  const tenant = await prisma.tenant.findUnique({
    where: { slug: ALLPA_TENANT_SLUG },
    select: { id: true, name: true, slug: true },
  });
  if (!tenant) throw new Error(`Tenant ${ALLPA_TENANT_SLUG} was not found.`);

  const operationalBefore = await getOperationalCounts(prisma, tenant.id);
  const protectedBefore = await getProtectedSnapshot(prisma, tenant.id);

  console.log(`ALLPA operational cleanup for ${tenant.name} (${tenant.slug})`);
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  printCounts('Records to delete:', operationalBefore);
  printCounts('Protected records:', summarizeProtected(protectedBefore));

  if (!execute) {
    console.log('\nDry-run only. No data was changed.');
    return;
  }

  if (confirmation !== ALLPA_TENANT_SLUG) {
    throw new Error(`Execution requires --confirm=${ALLPA_TENANT_SLUG}.`);
  }
  if (!backupMarker) {
    throw new Error('Execution requires --backup-marker=<verified-backup-path>.');
  }

  console.log(`\nVerified backup: ${backupMarker}`);
  const result = await cleanOperationalData(tenant.id);
  printCounts('Post-cleanup operational records:', result.operationalAfter);
  printCounts('Verified protected records:', summarizeProtected(result.protectedAfter));
  console.log('\nALLPA operational cleanup completed successfully.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

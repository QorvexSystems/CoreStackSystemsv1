import {
  CustomerCreditStatus,
  DocumentType,
  EmployeeStatus,
  FiscalSequenceStatus,
  InvoiceDocumentType,
  MembershipStatus,
  PrismaClient,
  ProductKind,
  ProductStatus,
  ProductUnit,
  Role,
  TaxCategory,
  UserStatus,
} from '../generated/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const demoPassword = process.env.SEED_UNIQUE_DEMO_PASSWORD ?? 'UniqueDemo#2026!';

const demoUsers = [
  {
    email: 'contabilidad@uniquepersonalizado.com',
    name: 'Contabilidad Demo',
    role: Role.ACCOUNTANT,
    employeeCode: 'UP-CON-001',
    jobTitle: 'Contabilidad',
    permissions: {
      canViewReports: true,
      canViewCashLogs: true,
      canReprintReceipt: true,
    },
  },
  {
    email: 'ordenes@uniquepersonalizado.com',
    name: 'Toma de órdenes Demo',
    role: Role.ORDER_TAKER,
    employeeCode: 'UP-ORD-001',
    jobTitle: 'Toma de órdenes',
    permissions: {
      canUsePos: true,
      canOpenCashSession: true,
      canCloseCashSession: true,
      canReprintReceipt: true,
      canTakeOrders: true,
    },
  },
  {
    email: 'fabrica@uniquepersonalizado.com',
    name: 'Producción Demo',
    role: Role.WAREHOUSE_KEEPER,
    employeeCode: 'UP-FAB-001',
    jobTitle: 'Producción y despacho',
    permissions: {},
  },
] as const;

const demoProducts = [
  {
    name: 'Cadena Plata 925',
    sku: 'UP-CAD-001',
    barcode: '746000000001',
    kind: ProductKind.STANDARD,
    material: 'Plata 925',
    measurement: '45 cm',
    price: 1750,
    cost: 850,
    storeStock: 12,
    minStock: 3,
  },
  {
    name: 'Collar Personalizado Niños',
    sku: 'UP-COL-NIN',
    barcode: '746000000002',
    kind: ProductKind.PERSONALIZED,
    material: 'Plata 925',
    measurement: 'Ajustable',
    price: 2950,
    cost: 1300,
    storeStock: 6,
    minStock: 2,
  },
  {
    name: 'Pulsera Personalizada Dijes',
    sku: 'UP-PUL-DIJ',
    barcode: '746000000003',
    kind: ProductKind.PERSONALIZED,
    material: 'Baño de oro',
    measurement: '18 cm',
    price: 2450,
    cost: 1050,
    storeStock: 5,
    minStock: 2,
  },
] as const;

async function main() {
  if (demoPassword.length < 16) {
    throw new Error('SEED_UNIQUE_DEMO_PASSWORD debe tener al menos 16 caracteres.');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: 'unique-personalizado' },
    select: { id: true },
  });

  if (!tenant) {
    throw new Error('Primero ejecuta pnpm db:seed para crear el tenant de Unique Personalizado.');
  }

  const passwordHash = await bcrypt.hash(demoPassword, 12);

  const result = await prisma.$transaction(async (tx) => {
    for (const demoUser of demoUsers) {
      const user = await tx.user.upsert({
        where: { email: demoUser.email },
        update: {},
        create: {
          email: demoUser.email,
          name: demoUser.name,
          passwordHash,
          status: UserStatus.ACTIVE,
        },
      });

      await tx.membership.upsert({
        where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
        update: {
          role: demoUser.role,
          status: MembershipStatus.ACTIVE,
          ...demoUser.permissions,
        },
        create: {
          userId: user.id,
          tenantId: tenant.id,
          role: demoUser.role,
          ...demoUser.permissions,
        },
      });

      await tx.employeeProfile.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        update: {
          employeeCode: demoUser.employeeCode,
          jobTitle: demoUser.jobTitle,
          status: EmployeeStatus.ACTIVE,
        },
        create: {
          tenantId: tenant.id,
          userId: user.id,
          employeeCode: demoUser.employeeCode,
          jobTitle: demoUser.jobTitle,
          status: EmployeeStatus.ACTIVE,
        },
      });
    }

    let category = await tx.productCategory.findFirst({
      where: { tenantId: tenant.id, name: 'Joyas y personalizados' },
    });
    category ??= await tx.productCategory.create({
      data: {
        tenantId: tenant.id,
        name: 'Joyas y personalizados',
        description: 'Catálogo demo de Unique Personalizado.',
      },
    });

    for (const demoProduct of demoProducts) {
      await tx.product.upsert({
        where: { tenantId_sku: { tenantId: tenant.id, sku: demoProduct.sku } },
        update: {},
        create: {
          tenantId: tenant.id,
          categoryId: category.id,
          name: demoProduct.name,
          sku: demoProduct.sku,
          barcode: demoProduct.barcode,
          kind: demoProduct.kind,
          material: demoProduct.material,
          measurement: demoProduct.measurement,
          unit: ProductUnit.UNIT,
          price: demoProduct.price,
          salePrice: demoProduct.price,
          cost: demoProduct.cost,
          taxCategory: TaxCategory.ITBIS_18,
          taxRate: 0.18,
          stock: demoProduct.storeStock,
          minStock: demoProduct.minStock,
          status: ProductStatus.ACTIVE,
          trackInventory: true,
        },
      });

    }

    const admin = await tx.user.findUnique({
      where: { email: process.env.SEED_UNIQUE_ADMIN_EMAIL ?? 'admin@uniquepersonalizado.com' },
      select: { id: true },
    });

    const corporateCustomer = await tx.customer.findFirst({
      where: {
        tenantId: tenant.id,
        documentType: DocumentType.RNC,
        documentNumber: '131999991',
      },
    });

    if (!corporateCustomer) {
      await tx.customer.create({
        data: {
          tenantId: tenant.id,
          name: 'Empresa Demo SRL',
          documentType: DocumentType.RNC,
          documentNumber: '131999991',
          email: 'compras@empresa-demo.test',
          phone: '809-555-0101',
          address: 'Santo Domingo, República Dominicana',
          creditEnabled: true,
          creditLimit: 75000,
          creditTermDays: 30,
          creditStatus: CustomerCreditStatus.ACTIVE,
          creditEnabledAt: new Date(),
          creditEnabledById: admin?.id,
        },
      });
    }

    for (const sequence of [
      { documentType: InvoiceDocumentType.CONSUMER_02, prefix: 'B02' },
      { documentType: InvoiceDocumentType.FISCAL_CREDIT_01, prefix: 'B01' },
    ]) {
      const existing = await tx.fiscalSequence.findFirst({
        where: {
          tenantId: tenant.id,
          documentType: sequence.documentType,
          status: FiscalSequenceStatus.ACTIVE,
        },
      });

      if (!existing) {
        await tx.fiscalSequence.create({
          data: {
            tenantId: tenant.id,
            documentType: sequence.documentType,
            prefix: sequence.prefix,
            startNumber: 1,
            endNumber: 99999999,
            nextNumber: 1,
            status: FiscalSequenceStatus.ACTIVE,
          },
        });
      }
    }

    return {
      users: demoUsers.length,
      products: demoProducts.length,
      customers: 1,
      fiscalSequences: 2,
    };
  });

  console.log('Datos demo de Unique Personalizado listos.');
  console.log(result);
  console.log('Todas las cuentas demo usan SEED_UNIQUE_DEMO_PASSWORD.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

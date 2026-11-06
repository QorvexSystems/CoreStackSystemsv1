'use strict';

const bcrypt = require('../apps/api/node_modules/bcryptjs');
const { PrismaClient, Role, InvoiceDocumentType, FiscalSequenceStatus } = require('../packages/database/generated/client');

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  throw new Error('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (12+ chars) are required');
}

const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash(password, 12);
  const result = await prisma.$transaction(async (tx) => {
    const slug = 'solucionesautomotrizcyr';
    if (await tx.tenant.findUnique({ where: { slug } })) {
      throw new Error('Tenant already exists; refusing to bootstrap twice');
    }
    if (await tx.user.findUnique({ where: { email } })) {
      throw new Error('Admin email already exists; refusing to reuse a user');
    }

    const tenant = await tx.tenant.create({
      data: {
        slug,
        name: 'Soluciones Automotriz C&R',
        commercialName: 'Soluciones Automotriz C&R',
        legalName: 'Soluciones Automotriz C&R',
        branding: {
          create: {
            logoUrl: '/brand/logo-taller.png',
            primaryColor: '#111111',
            accentColor: '#ffffff',
            loginTitle: 'Soluciones Automotriz C&R',
            loginSubtitle: 'Gestión de taller',
          },
        },
      },
    });

    const user = await tx.user.create({
      data: {
        email,
        name: 'Administrador Soluciones Automotriz',
        passwordHash: hash,
        memberships: {
          create: {
            tenantId: tenant.id,
            role: Role.ADMIN,
            canUsePos: true,
            canOpenCashSession: true,
            canCloseCashSession: true,
            canApplyDiscount: true,
            canCancelInvoice: true,
            canVoidInvoice: true,
            canAdjustInventory: true,
            canManageProducts: true,
            canManageEmployees: true,
            canViewReports: true,
            canManageFiscalSequences: true,
            canViewCashLogs: true,
            canReprintReceipt: true,
          },
        },
        employeeProfiles: {
          create: {
            tenantId: tenant.id,
            employeeCode: 'SA-ADM-001',
            jobTitle: 'Administrador general',
          },
        },
      },
    });

    await tx.fiscalSequence.create({
      data: {
        tenantId: tenant.id,
        documentType: InvoiceDocumentType.SALE_NOTE,
        prefix: 'NV',
        startNumber: 1,
        endNumber: 999999999,
        nextNumber: 1,
        status: FiscalSequenceStatus.ACTIVE,
      },
    });
    return { tenantId: tenant.id, userId: user.id, email: user.email };
  });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());

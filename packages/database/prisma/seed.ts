import {
  EmployeeStatus,
  MembershipStatus,
  PrismaClient,
  Role,
  UserStatus,
} from '../generated/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const uniqueAdminEmail = process.env.SEED_UNIQUE_ADMIN_EMAIL ?? 'admin@uniquepersonalizado.com';
const uniqueAdminPassword = process.env.SEED_UNIQUE_ADMIN_PASSWORD;
const coreStackAdminEmail = process.env.SEED_CORESTACK_ADMIN_EMAIL ?? 'soporte@corestack-systems.com';
const coreStackAdminPassword = process.env.SEED_CORESTACK_ADMIN_PASSWORD;

function requireSecret(value: string | undefined, variableName: string) {
  if (!value || value.length < 16) {
    throw new Error(`${variableName} debe contener una contraseña de al menos 16 caracteres.`);
  }

  return value;
}

async function main() {
  const uniquePasswordHash = await bcrypt.hash(
    requireSecret(uniqueAdminPassword, 'SEED_UNIQUE_ADMIN_PASSWORD'),
    12,
  );
  const coreStackPasswordHash = await bcrypt.hash(
    requireSecret(coreStackAdminPassword, 'SEED_CORESTACK_ADMIN_PASSWORD'),
    12,
  );

  const result = await prisma.$transaction(async (tx) => {
    const coreStackTenant = await tx.tenant.upsert({
      where: { slug: 'corestack' },
      update: {
        name: 'CoreStack',
        commercialName: 'CoreStack',
        legalName: 'CoreStack SRL',
        email: 'soporte@corestack-systems.com',
        address: 'Santo Domingo, República Dominicana',
      },
      create: {
        name: 'CoreStack',
        commercialName: 'CoreStack',
        legalName: 'CoreStack SRL',
        slug: 'corestack',
        email: 'soporte@corestack-systems.com',
        address: 'Santo Domingo, República Dominicana',
      },
    });

    await tx.companyBranding.upsert({
      where: { tenantId: coreStackTenant.id },
      update: {
        logoUrl: '/brand/corestack-logo.jpeg',
        primaryColor: '#075ED1',
        accentColor: '#D9AE46',
        loginTitle: 'CoreStack',
        loginSubtitle: 'Tecnología empresarial para negocios que crecen.',
      },
      create: {
        tenantId: coreStackTenant.id,
        logoUrl: '/brand/corestack-logo.jpeg',
        primaryColor: '#075ED1',
        accentColor: '#D9AE46',
        loginTitle: 'CoreStack',
        loginSubtitle: 'Tecnología empresarial para negocios que crecen.',
      },
    });

    const uniqueTenant = await tx.tenant.upsert({
      where: { slug: 'unique-personalizado' },
      update: {
        name: 'Unique Personalizado',
        commercialName: 'Unique Personalizado',
        email: 'info@uniquepersonalizado.com',
        phone: '809-688-0490',
        address: 'Av. 27 de Febrero 275, Santo Domingo, República Dominicana',
      },
      create: {
        name: 'Unique Personalizado',
        commercialName: 'Unique Personalizado',
        slug: 'unique-personalizado',
        email: 'info@uniquepersonalizado.com',
        phone: '809-688-0490',
        address: 'Av. 27 de Febrero 275, Santo Domingo, República Dominicana',
      },
    });

    await tx.companyBranding.upsert({
      where: { tenantId: uniqueTenant.id },
      update: {
        logoUrl: '/brand/logo-brand.png',
        primaryColor: '#9A6B00',
        accentColor: '#075ED1',
        loginTitle: 'Unique Personalizado',
        loginSubtitle: 'Joyas y regalos personalizados',
      },
      create: {
        tenantId: uniqueTenant.id,
        logoUrl: '/brand/logo-brand.png',
        primaryColor: '#9A6B00',
        accentColor: '#075ED1',
        loginTitle: 'Unique Personalizado',
        loginSubtitle: 'Joyas y regalos personalizados',
      },
    });

    const coreStackAdmin = await tx.user.upsert({
      where: { email: coreStackAdminEmail },
      update: {
        name: 'Soporte CoreStack',
        passwordHash: coreStackPasswordHash,
        status: UserStatus.ACTIVE,
      },
      create: {
        email: coreStackAdminEmail,
        name: 'Soporte CoreStack',
        passwordHash: coreStackPasswordHash,
        status: UserStatus.ACTIVE,
      },
    });

    await tx.membership.upsert({
      where: {
        userId_tenantId: {
          userId: coreStackAdmin.id,
          tenantId: coreStackTenant.id,
        },
      },
      update: {
        role: Role.QORVEX_SUPER_ADMIN,
        status: MembershipStatus.ACTIVE,
        canManageEmployees: true,
        canManageFiscalSequences: true,
        canViewCashLogs: true,
        canViewReports: true,
      },
      create: {
        userId: coreStackAdmin.id,
        tenantId: coreStackTenant.id,
        role: Role.QORVEX_SUPER_ADMIN,
        canManageEmployees: true,
        canManageFiscalSequences: true,
        canViewCashLogs: true,
        canViewReports: true,
      },
    });

    const uniqueAdmin = await tx.user.upsert({
      where: { email: uniqueAdminEmail },
      update: {
        name: 'Administrador Unique Personalizado',
        passwordHash: uniquePasswordHash,
        status: UserStatus.ACTIVE,
      },
      create: {
        email: uniqueAdminEmail,
        name: 'Administrador Unique Personalizado',
        passwordHash: uniquePasswordHash,
        status: UserStatus.ACTIVE,
      },
    });

    await tx.membership.upsert({
      where: {
        userId_tenantId: {
          userId: uniqueAdmin.id,
          tenantId: uniqueTenant.id,
        },
      },
      update: {
        role: Role.ADMIN,
        status: MembershipStatus.ACTIVE,
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
        canTakeOrders: true,
      },
      create: {
        userId: uniqueAdmin.id,
        tenantId: uniqueTenant.id,
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
        canTakeOrders: true,
      },
    });

    await tx.employeeProfile.upsert({
      where: {
        tenantId_userId: {
          tenantId: uniqueTenant.id,
          userId: uniqueAdmin.id,
        },
      },
      update: {
        employeeCode: 'UP-ADM-001',
        jobTitle: 'Administrador general',
        status: EmployeeStatus.ACTIVE,
      },
      create: {
        tenantId: uniqueTenant.id,
        userId: uniqueAdmin.id,
        employeeCode: 'UP-ADM-001',
        jobTitle: 'Administrador general',
        status: EmployeeStatus.ACTIVE,
      },
    });

    const existingCashRegister = await tx.cashRegister.findFirst({
      where: { tenantId: uniqueTenant.id, name: 'Caja principal' },
      select: { id: true },
    });

    if (!existingCashRegister) {
      await tx.cashRegister.create({
        data: {
          tenantId: uniqueTenant.id,
          name: 'Caja principal',
          location: 'Tienda principal',
        },
      });
    }

    const existingAudit = await tx.auditLog.findFirst({
      where: {
        tenantId: uniqueTenant.id,
        action: 'UNIQUE_TENANT_BOOTSTRAPPED',
        entity: 'Tenant',
        entityId: uniqueTenant.id,
      },
      select: { id: true },
    });

    if (!existingAudit) {
      await tx.auditLog.create({
        data: {
          tenantId: uniqueTenant.id,
          userId: coreStackAdmin.id,
          action: 'UNIQUE_TENANT_BOOTSTRAPPED',
          entity: 'Tenant',
          entityId: uniqueTenant.id,
          metadata: {
            provider: 'CoreStack',
            operationalDataSeeded: false,
          },
        },
      });
    }

    return {
      coreStackTenantId: coreStackTenant.id,
      uniqueTenantId: uniqueTenant.id,
      uniqueAdminEmail,
      coreStackAdminEmail,
    };
  });

  console.log('Bootstrap de Unique Personalizado completado.');
  console.log(`Tenant Unique: ${result.uniqueTenantId}`);
  console.log(`Tenant CoreStack: ${result.coreStackTenantId}`);
  console.log(`Administrador Unique: ${result.uniqueAdminEmail}`);
  console.log(`Soporte CoreStack: ${result.coreStackAdminEmail}`);
  console.log('Las contraseñas permanecen únicamente en las variables SEED_* del .env.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

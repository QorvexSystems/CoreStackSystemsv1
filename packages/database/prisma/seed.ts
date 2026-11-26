import {
  EmployeeStatus,
  MembershipStatus,
  PrismaClient,
  Role,
  UserStatus,
} from '../generated/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const hotelAdminEmail = process.env.SEED_HOTEL_ADMIN_EMAIL ?? 'admin@hotelancla.local';
const hotelAdminPassword = process.env.SEED_HOTEL_ADMIN_PASSWORD;
const coreStackAdminEmail = process.env.SEED_CORESTACK_ADMIN_EMAIL ?? 'soporte@corestack-systems.com';
const coreStackAdminPassword = process.env.SEED_CORESTACK_ADMIN_PASSWORD;

function requireSecret(value: string | undefined, variableName: string, minimumLength = 16) {
  if (!value || value.length < minimumLength) {
    throw new Error(
      `${variableName} debe contener una contraseña de al menos ${minimumLength} caracteres.`,
    );
  }

  return value;
}

async function main() {
  const hotelPasswordHash = await bcrypt.hash(
    requireSecret(hotelAdminPassword, 'SEED_HOTEL_ADMIN_PASSWORD', 8),
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

    const hotelTenant = await tx.tenant.upsert({
      where: { slug: 'hotel-ancla' },
      update: {
        name: 'Hotel Ancla',
        commercialName: 'Hotel Suite Ancla',
        rnc: '132688521',
        email: 'Serviosanchez2@icloud.com',
        phone: '+1 (829) 318-9431',
        address: 'Frente a la Escuela Laboral Vocacional, Calle Los Maestros #1, Barahona 81000',
      },
      create: {
        name: 'Hotel Ancla',
        commercialName: 'Hotel Suite Ancla',
        slug: 'hotel-ancla',
        rnc: '132688521',
        email: 'Serviosanchez2@icloud.com',
        phone: '+1 (829) 318-9431',
        address: 'Frente a la Escuela Laboral Vocacional, Calle Los Maestros #1, Barahona 81000',
      },
    });

    await tx.companyBranding.upsert({
      where: { tenantId: hotelTenant.id },
      update: {
        logoUrl: '/brand/hotel-ancla-logo.png',
        primaryColor: '#15988D',
        accentColor: '#0E746C',
        loginTitle: 'Hotel Ancla',
        loginSubtitle: 'Operación integral del hotel',
      },
      create: {
        tenantId: hotelTenant.id,
        logoUrl: '/brand/hotel-ancla-logo.png',
        primaryColor: '#15988D',
        accentColor: '#0E746C',
        loginTitle: 'Hotel Ancla',
        loginSubtitle: 'Operación integral del hotel',
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

    const hotelAdmin = await tx.user.upsert({
      where: { email: hotelAdminEmail },
      update: {
        name: 'Administrador Hotel Ancla',
        passwordHash: hotelPasswordHash,
        status: UserStatus.ACTIVE,
      },
      create: {
        email: hotelAdminEmail,
        name: 'Administrador Hotel Ancla',
        passwordHash: hotelPasswordHash,
        status: UserStatus.ACTIVE,
      },
    });

    await tx.membership.upsert({
      where: {
        userId_tenantId: {
          userId: hotelAdmin.id,
          tenantId: hotelTenant.id,
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
        userId: hotelAdmin.id,
        tenantId: hotelTenant.id,
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
          tenantId: hotelTenant.id,
          userId: hotelAdmin.id,
        },
      },
      update: {
        employeeCode: 'HA-ADM-001',
        jobTitle: 'Administrador general',
        status: EmployeeStatus.ACTIVE,
      },
      create: {
        tenantId: hotelTenant.id,
        userId: hotelAdmin.id,
        employeeCode: 'HA-ADM-001',
        jobTitle: 'Administrador general',
        status: EmployeeStatus.ACTIVE,
      },
    });

    const existingCashRegister = await tx.cashRegister.findFirst({
      where: { tenantId: hotelTenant.id, name: 'Caja principal' },
      select: { id: true },
    });

    if (!existingCashRegister) {
      await tx.cashRegister.create({
        data: {
          tenantId: hotelTenant.id,
          name: 'Caja principal',
          location: 'Recepción principal',
        },
      });
    }

    const existingAudit = await tx.auditLog.findFirst({
      where: {
        tenantId: hotelTenant.id,
        action: 'HOTEL_TENANT_BOOTSTRAPPED',
        entity: 'Tenant',
        entityId: hotelTenant.id,
      },
      select: { id: true },
    });

    if (!existingAudit) {
      await tx.auditLog.create({
        data: {
          tenantId: hotelTenant.id,
          userId: coreStackAdmin.id,
          action: 'HOTEL_TENANT_BOOTSTRAPPED',
          entity: 'Tenant',
          entityId: hotelTenant.id,
          metadata: {
            provider: 'CoreStack',
            operationalDataSeeded: false,
          },
        },
      });
    }

    return {
      coreStackTenantId: coreStackTenant.id,
      hotelTenantId: hotelTenant.id,
      hotelAdminEmail,
      coreStackAdminEmail,
    };
  });

  console.log('Bootstrap de Hotel Ancla completado.');
  console.log(`Tenant Hotel Ancla: ${result.hotelTenantId}`);
  console.log(`Tenant CoreStack: ${result.coreStackTenantId}`);
  console.log(`Administrador Hotel Ancla: ${result.hotelAdminEmail}`);
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

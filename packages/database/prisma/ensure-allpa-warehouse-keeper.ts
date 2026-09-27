import {
  EmployeeStatus,
  MembershipStatus,
  PrismaClient,
  Role,
  UserStatus,
} from '../generated/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const warehousePermissions = {
  canUsePos: false,
  canOpenCashSession: false,
  canCloseCashSession: false,
  canApplyDiscount: false,
  canCancelInvoice: false,
  canVoidInvoice: false,
  canAdjustInventory: false,
  canManageProducts: false,
  canManageEmployees: false,
  canViewReports: false,
  canManageFiscalSequences: false,
  canViewCashLogs: false,
  canReprintReceipt: false,
  canTakeOrders: false,
};

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'allpa' } });
  if (!tenant) throw new Error('No se encontró el tenant ALLPA.');

  const email = 'almacenista@allpa.local';
  const existingUser = await prisma.user.findUnique({ where: { email } });
  const user = existingUser
    ? await prisma.user.update({
        where: { id: existingUser.id },
        data: { name: 'Almacenista ALLPA', status: UserStatus.ACTIVE },
      })
    : await prisma.user.create({
        data: {
          email,
          name: 'Almacenista ALLPA',
          phone: '809-555-0104',
          passwordHash: await bcrypt.hash(
            process.env.WAREHOUSE_KEEPER_PASSWORD ?? 'DemoPassword123!',
            12,
          ),
          status: UserStatus.ACTIVE,
        },
      });

  await prisma.$transaction([
    prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      create: {
        userId: user.id,
        tenantId: tenant.id,
        role: Role.WAREHOUSE_KEEPER,
        status: MembershipStatus.ACTIVE,
        ...warehousePermissions,
      },
      update: {
        role: Role.WAREHOUSE_KEEPER,
        status: MembershipStatus.ACTIVE,
        ...warehousePermissions,
      },
    }),
    prisma.employeeProfile.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        employeeCode: 'ALL-ALM-001',
        jobTitle: 'Almacenista',
        hireDate: new Date('2026-09-25T00:00:00.000Z'),
        status: EmployeeStatus.ACTIVE,
      },
      update: {
        employeeCode: 'ALL-ALM-001',
        jobTitle: 'Almacenista',
        status: EmployeeStatus.ACTIVE,
      },
    }),
  ]);

  console.log(`Usuario ${email} listo para el tenant ${tenant.name}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

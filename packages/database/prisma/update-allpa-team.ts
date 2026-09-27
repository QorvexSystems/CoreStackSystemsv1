import { MembershipStatus, Prisma, PrismaClient, Role, UserStatus } from '../generated/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const adminPermissions = {
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
};

async function main() {
  const heinPassword = process.env.ALLPA_HEIN_PASSWORD;
  if (!heinPassword) {
    throw new Error('Define ALLPA_HEIN_PASSWORD antes de ejecutar este script.');
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: 'allpa' } });
  if (!tenant) throw new Error('No se encontró el tenant ALLPA.');

  const [billingUser, cashUser, heinCollision] = await Promise.all([
    prisma.user.findUnique({
      where: { email: 'facturacion2@allpa.local' },
      include: {
        memberships: { where: { tenantId: tenant.id } },
        employeeProfiles: { where: { tenantId: tenant.id } },
      },
    }),
    prisma.user.findUnique({
      where: { email: 'caja@allpa.local' },
      include: {
        memberships: { where: { tenantId: tenant.id } },
        employeeProfiles: { where: { tenantId: tenant.id } },
      },
    }),
    prisma.user.findUnique({ where: { email: 'hein@allpa.local' } }),
  ]);

  if (!billingUser) throw new Error('No se encontró facturacion2@allpa.local.');
  if (billingUser.employeeProfiles[0]?.employeeCode !== 'ALP-ORD-001') {
    throw new Error('El código de facturacion2 no coincide con ALP-ORD-001.');
  }
  if (!billingUser.memberships.length) {
    throw new Error('facturacion2 no pertenece al tenant ALLPA.');
  }

  if (!cashUser) throw new Error('No se encontró caja@allpa.local.');
  if (cashUser.employeeProfiles[0]?.employeeCode !== 'ALP-CAJ-001') {
    throw new Error('El código de caja no coincide con ALP-CAJ-001.');
  }
  if (!cashUser.memberships.length) throw new Error('caja no pertenece al tenant ALLPA.');
  if (heinCollision && heinCollision.id !== cashUser.id) {
    throw new Error('Ya existe otro usuario con el correo hein@allpa.local.');
  }

  const passwordHash = await bcrypt.hash(heinPassword, 12);

  await prisma.$transaction([
    prisma.employeeProfile.deleteMany({
      where: { tenantId: tenant.id, userId: billingUser.id },
    }),
    prisma.membership.deleteMany({
      where: { tenantId: tenant.id, userId: billingUser.id },
    }),
    prisma.user.update({
      where: { id: billingUser.id },
      data: { status: UserStatus.DISABLED, passwordHash: null },
    }),
    prisma.user.update({
      where: { id: cashUser.id },
      data: {
        name: 'Hein - ALLPA',
        email: 'hein@allpa.local',
        passwordHash,
        status: UserStatus.ACTIVE,
      },
    }),
    prisma.membership.update({
      where: { id: cashUser.memberships[0].id },
      data: {
        role: Role.ADMIN,
        status: MembershipStatus.ACTIVE,
        ...adminPermissions,
      },
    }),
    prisma.employeeProfile.update({
      where: { id: cashUser.employeeProfiles[0].id },
      data: { jobTitle: 'Administrador' },
    }),
  ]);

  let billingRemoval: 'physical' | 'disabled' = 'disabled';
  try {
    await prisma.user.delete({ where: { id: billingUser.id } });
    billingRemoval = 'physical';
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
      throw error;
    }
  }

  const updatedHein = await prisma.user.findUniqueOrThrow({
    where: { email: 'hein@allpa.local' },
    include: {
      memberships: { where: { tenantId: tenant.id } },
      employeeProfiles: { where: { tenantId: tenant.id } },
    },
  });

  console.log(
    JSON.stringify({
      removedEmployee: 'facturacion2@allpa.local',
      removalMode: billingRemoval,
      updatedEmployee: {
        name: updatedHein.name,
        email: updatedHein.email,
        employeeCode: updatedHein.employeeProfiles[0]?.employeeCode,
        role: updatedHein.memberships[0]?.role,
        status: updatedHein.status,
      },
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

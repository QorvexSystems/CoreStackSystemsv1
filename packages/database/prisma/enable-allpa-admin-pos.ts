import { MembershipStatus, PrismaClient, Role } from '../generated/client';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'allpa' } });
  if (!tenant) throw new Error('No se encontró el tenant ALLPA.');

  const result = await prisma.membership.updateMany({
    where: {
      tenantId: tenant.id,
      role: Role.ADMIN,
      status: MembershipStatus.ACTIVE,
    },
    data: {
      canUsePos: true,
      canOpenCashSession: true,
      canCloseCashSession: true,
    },
  });

  console.log(`Acceso completo a caja habilitado para ${result.count} administrador(es) de ALLPA.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

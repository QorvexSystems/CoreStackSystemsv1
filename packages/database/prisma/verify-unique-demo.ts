import { Role, PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: 'unique-personalizado' },
    include: {
      memberships: {
        where: { role: { in: [Role.ACCOUNTANT, Role.ORDER_TAKER, Role.WAREHOUSE_KEEPER] } },
      },
      products: { where: { sku: { in: ['UP-CAD-001', 'UP-COL-NIN', 'UP-PUL-DIJ'] } } },
      customers: { where: { documentNumber: '131999991' } },
      fiscalSequences: { where: { prefix: { in: ['B01', 'B02'] } } },
    },
  });

  assert(tenant, 'No existe el tenant unique-personalizado.');
  assert(tenant.memberships.length >= 3, 'Faltan usuarios demo o sus roles.');
  assert(tenant.products.length === 3, 'Faltan productos demo.');
  assert(tenant.customers.length === 1, 'Falta el cliente corporativo demo.');
  assert(tenant.fiscalSequences.length >= 2, 'Faltan secuencias fiscales de prueba.');
  assert(
    tenant.products.every((product) => product.stock > 0),
    'Un producto demo no tiene existencia en tienda.',
  );

  console.log('Verificación demo completada correctamente.');
  console.log({
    roles: tenant.memberships.length,
    products: tenant.products.length,
    customers: tenant.customers.length,
    fiscalSequences: tenant.fiscalSequences.length,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

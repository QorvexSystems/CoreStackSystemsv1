const { PrismaClient } = require('@qorvex/database');
const db = new PrismaClient();
(async () => {
  const duplicates = await db.$queryRawUnsafe(
    `SELECT "tenantId", "cashRegisterId", COUNT(*)::int AS count FROM "CashSession" WHERE "status" = 'OPEN' GROUP BY "tenantId", "cashRegisterId" HAVING COUNT(*) > 1`,
  );
  const invalidStock = await db.product.count({
    where: { OR: [{ stock: { lt: 0 } }, { reservedStock: { lt: 0 } }] },
  });
  console.log({ duplicateOpenRegisters: duplicates.length, invalidStock });
  if (duplicates.length || invalidStock)
    throw new Error('Revisar datos existentes antes de migrar. No se ha modificado ningún dato.');
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

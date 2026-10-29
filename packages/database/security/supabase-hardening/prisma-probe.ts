import { PrismaClient } from '../../generated/client';

const prisma = new PrismaClient();
async function main() {
try {
  const [tenants, products, orders, invoices, movements, users, webProducts, nonces] = await Promise.all([
    prisma.tenant.count(), prisma.product.count(), prisma.salesOrder.count(), prisma.invoice.count(),
    prisma.inventoryMovement.count(), prisma.user.count(), prisma.webProduct.count(), prisma.channelNonce.count(),
  ]);
  if (![tenants, products, orders, invoices, movements, users, webProducts, nonces].every((n) => n >= 1)) {
    throw new Error('Synthetic business/authentication fixture is incomplete');
  }
  const authUser = await prisma.user.findUnique({ where: { email: 'operator@security.test' } });
  if (!authUser?.passwordHash) throw new Error('Backend could not read custom authentication data');

  await prisma.$transaction(async (tx) => {
    await tx.product.create({ data: { id: 'security-crud-probe', tenantId: 'tenant-security', name: 'CRUD probe', sku: 'SEC-PROBE', price: 1 } });
    await tx.product.update({ where: { id: 'security-crud-probe' }, data: { name: 'CRUD probe updated' } });
    await tx.product.delete({ where: { id: 'security-crud-probe' } });
    await tx.channelNonce.create({ data: { id: 'nonce-probe', keyId: 'security-test', nonce: 'unique-probe', expiresAt: new Date(Date.now()+60_000) } });
    await tx.channelNonce.delete({ where: { id: 'nonce-probe' } });
  });
  console.log(JSON.stringify({ tenants, products, orders, invoices, movements, users, webProducts, nonces, prismaCrud: 'PASS', customAuthRead: 'PASS' }));
} finally {
  await prisma.$disconnect();
}
}
main().catch((error) => { console.error(error); process.exitCode = 1; });


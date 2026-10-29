require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const { createCoreStackApiApp } = require('../dist/bootstrap');
const { PrismaService } = require('../dist/prisma/prisma.service');
const fs = require('node:fs/promises');

Logger.overrideLogger(['error']);

process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = '';
process.env.ENABLE_EMAIL_DELIVERY = 'false';

const paths = [
  '/dashboard/summary',
  '/dashboard/product-sales',
  '/orders/kanban/board',
  '/orders?status=OPEN',
  '/orders?status=QUOTATION',
  '/orders/products/search',
  '/products',
  '/invoices',
  '/returns',
  '/customers',
  '/receivables',
  '/receivables/customers',
  '/cash/registers',
  '/cash/sessions',
  '/cash/movements',
  '/purchase-orders',
  '/receipts',
  '/supplier-invoices',
  '/supplier-invoices/payables/summary',
  '/suppliers',
  '/employees',
  '/credit-approvals',
  '/fiscal-sequences',
  '/fiscal-sequences/alerts',
  '/audit/logs',
  '/employee-logs',
  '/imports',
];

let app;
(async () => {
  app = await createCoreStackApiApp();
  await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  const db = app.get(PrismaService);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'unique-personalizado' } });
  const membership = await db.membership.findFirstOrThrow({
    where: { tenantId: tenant.id, role: 'ADMIN', status: 'ACTIVE' },
    include: { user: true },
  });
  const token = await app
    .get(JwtService)
    .signAsync(
      { sub: membership.userId, email: membership.user.email },
      { secret: app.get(ConfigService).getOrThrow('JWT_SECRET'), expiresIn: '15m' },
    );
  const headers = { Authorization: 'Bearer ' + token, 'x-tenant-id': tenant.id };
  const selectedPaths =
    process.argv[3] === 'critical'
      ? paths.filter((path) => ['/orders/kanban/board', '/cash/sessions'].includes(path))
      : paths;
  for (const path of selectedPaths) {
    const started = performance.now();
    try {
      const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(90000) });
      const body = await response.text();
      if (process.argv[2] && ['/orders/kanban/board', '/cash/sessions'].includes(path)) {
        await fs.writeFile(process.argv[2] + '-' + path.replaceAll('/', '_') + '.json', body);
      }
      console.log(
        JSON.stringify({
          path,
          status: response.status,
          ms: Math.round(performance.now() - started),
          bytes: body.length,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({ path, error: error.message, ms: Math.round(performance.now() - started) }),
      );
    }
  }
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
  });

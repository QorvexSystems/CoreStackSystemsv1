require('reflect-metadata');
const assert = require('node:assert/strict');
const { Logger } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const { createCoreStackApiApp } = require('../dist/bootstrap');
const { PrismaService } = require('../dist/prisma/prisma.service');
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = ''; // Never contact Shopify from this test.
process.env.ENABLE_EMAIL_DELIVERY = 'false';
let app;
(async () => {
  Logger.overrideLogger(['error']);
  app = await createCoreStackApiApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = 'http://127.0.0.1:' + address.port;
  const db = app.get(PrismaService);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'unique-personalizado' } });
  const roles = ['ADMIN', 'ORDER_TAKER', 'WAREHOUSE_KEEPER', 'ACCOUNTANT'];
  let passed = 0;
  for (const role of roles) {
    const membership = await db.membership.findFirstOrThrow({
      where: { tenantId: tenant.id, role, status: 'ACTIVE', user: { status: 'ACTIVE' } },
      include: { user: true },
    });
    // Sign a short-lived test token in memory; never change users or print secrets.
    const token = await app
      .get(JwtService)
      .signAsync(
        { sub: membership.userId, email: membership.user.email },
        { secret: app.get(ConfigService).getOrThrow('JWT_SECRET'), expiresIn: '2m' },
      );
    const headers = {
      Authorization: 'Bearer ' + token,
      'x-tenant-id': tenant.id,
      'Content-Type': 'application/json',
    };
    const cases =
      role === 'WAREHOUSE_KEEPER'
        ? [
            ['/warehouse/products', 404],
            ['/orders/kanban/board', 200],
            ['/invoices', 403],
            ['/products', 403],
          ]
        : role === 'ORDER_TAKER'
          ? [
              ['/products', 200],
              ['/customers', 200],
              ['/invoices', 200],
              ['/receivables', 200],
              ['/production', 404],
            ]
          : role === 'ACCOUNTANT'
            ? [
                ['/products', 200],
                ['/receivables', 200],
                ['/dashboard/summary', 200],
              ]
            : [
                ['/dashboard/summary', 200],
                ['/dashboard/product-sales', 200],
                ['/integrations/shopify/status', 200],
                ['/warehouse/stock', 404],
                ['/warehouse/movements', 404],
                ['/warehouse/dispatches/pending', 404],
                ['/inventory/movements', 404],
              ];
    for (const [path, expected] of cases) {
      const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(45000) });
      const body = await response.json();
      if (response.status === 500 && path === '/dashboard/summary') {
        const { DashboardService } = require('../dist/modules/dashboard/dashboard.service');
        await app.get(DashboardService).getSummary(tenant.id);
      }
      assert.equal(
        response.status,
        expected,
        role + ' ' + path + ': ' + JSON.stringify(body).slice(0, 150),
      );
      if (role === 'WAREHOUSE_KEEPER' && path === '/orders/kanban/board') {
        for (const order of body) {
          assert.equal(order.total, undefined);
          assert.equal(order.invoice, undefined);
          for (const item of order.items) {
            assert.equal(item.product?.price, undefined);
            assert.equal(item.product?.cost, undefined);
            assert.equal(item.product?.stock, undefined);
          }
        }
      }
      if (path === '/dashboard/summary' && expected === 200)
        assert.equal(typeof body.collectionsMonth, 'number');
      passed++;
      console.log('OK HTTP: ' + role + ' ' + path + ' => ' + response.status);
    }
    if (role === 'ORDER_TAKER' || role === 'WAREHOUSE_KEEPER') {
      const response = await fetch(base + '/products', { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 403);
      passed++;
    }
  }
  console.log(JSON.stringify({ passed, externalRequests: false, userAccountsChanged: false }));
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
  });

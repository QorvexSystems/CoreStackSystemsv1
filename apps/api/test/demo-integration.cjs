require('reflect-metadata');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@qorvex/database');
const {
  CreditApprovalsService,
} = require('../dist/modules/credit-approvals/credit-approvals.service');
const { OrdersService } = require('../dist/modules/orders/orders.service');
const { PosService } = require('../dist/modules/pos/pos.service');
const { ReceivablesService } = require('../dist/modules/receivables/receivables.service');
const { ReturnsService } = require('../dist/modules/returns/returns.service');
const { ShopifyService } = require('../dist/modules/shopify/shopify.service');
const { createHmac } = require('node:crypto');
const { DashboardService } = require('../dist/modules/dashboard/dashboard.service');
const db = new PrismaClient();
const rollback = new Error('ROLLBACK_TEST_SUCCESS');
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log('OK: ' + name);
};
(async () => {
  await db.$transaction(
    async (tx) => {
      // Services share the transaction; no requests leave this process.
      const scoped = new Proxy(tx, {
        get(target, key) {
          if (key === '$transaction')
            return (operation) =>
              typeof operation === 'function' ? operation(scoped) : Promise.all(operation);
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { slug: 'unique-personalizado' } });
      const member = await tx.membership.findFirstOrThrow({
        where: { tenantId: tenant.id, role: 'ADMIN', status: 'ACTIVE' },
        include: { user: true },
      });
      const user = { ...member.user, memberships: [member] };
      const noopMail = {
        sendOrderReady: async () => ({ sent: false, error: 'Desactivado en pruebas' }),
      };
      const noopShopify = { syncProductIfConfigured: async () => ({ configured: false }) };
      const orders = new OrdersService(scoped, noopMail);
      const pos = new PosService(scoped, noopMail, noopShopify);
      const receivables = new ReceivablesService(scoped);
      const returns = new ReturnsService(scoped, noopShopify);
      const dashboard = new DashboardService(scoped);
      const dashboardBefore = await dashboard.getSummary(tenant.id);
      const product = await tx.product.findFirstOrThrow({
        where: { tenantId: tenant.id, sku: 'UP-COL-NIN' },
      });
      const register = await tx.cashRegister.create({
        data: { tenantId: tenant.id, name: 'TEST-ROLLBACK-' + Date.now() },
      });
      const cash = await tx.cashSession.create({
        data: {
          tenantId: tenant.id,
          cashRegisterId: register.id,
          openedById: user.id,
          openingAmount: 0,
        },
      });
      let order = await orders.create(tenant.id, user, {
        clientName: 'Cliente prueba transaccional',
        promisedDate: '2026-11-10',
        inventorySource: 'SALES_INVENTORY',
        items: [
          {
            productId: product.id,
            quantity: 1,
            personalization: { children: 2, material: 'Plata' },
          },
        ],
      });
      const productionBoard = await orders.getKanban(tenant.id, user);
      check(
        'Producción muestra orden activa con sus artículos',
        productionBoard.some(
          (entry) =>
            entry.id === order.id && entry.items.some((item) => item.productId === product.id),
        ),
      );
      const reserved = await tx.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      check(
        'Crear orden personalizada reserva existencias de Productos',
        reserved.reservedStock === product.reservedStock + 1 && reserved.stock === product.stock,
      );
      check('La factura inicial es borrador no fiscal', order.invoice.status === 'DRAFT');
      await assert.rejects(orders.updateWorkflow(tenant.id, user, order.id, { stage: 'READY' }));
      checks.push('No mover órdenes antes del cobro');
      await orders.claim(tenant.id, user, order.id, { cashSessionId: cash.id });
      const checkoutStartedAt = performance.now();
      const sale = await pos.completeSale(tenant.id, user, {
        orderId: order.id,
        cashSessionId: cash.id,
        paymentMethod: 'TRANSFER',
        paymentAmount: 100,
        amountReceived: 100,
      });
      console.log(`TIEMPO: servicio de cobro en transacción de prueba ${Math.round(performance.now() - checkoutStartedAt)} ms`);
      check(
        'Cobro devuelve factura lista para imprimir con emisor, artículos y pago',
        sale.tenant?.id === tenant.id &&
          sale.tenant.rnc === tenant.rnc &&
          sale.items.length === 1 &&
          sale.payments.length === 1 &&
          sale.issuedBy.id === user.id &&
          Boolean(sale.cashSession.cashRegister) && Boolean(sale.ncf),
      );
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: order.invoiceId },
        include: { items: true },
      });
      check(
        'Anticipo conserva balance y emite NCF una vez',
        invoice.paidAmount.eq(100) &&
          invoice.balance.eq(invoice.total.sub(100)) &&
          Boolean(invoice.ncf),
      );
      check('Factura conserva personalización', invoice.items[0].personalization.children === 2);
      const dashboardAfterSale = await dashboard.getSummary(tenant.id);
      check(
        'Dashboard contabiliza venta, orden y caja con datos reales',
        Math.abs(
          dashboardAfterSale.grossSalesMonth -
            dashboardBefore.grossSalesMonth -
            invoice.total.toNumber(),
        ) < 0.01 &&
          dashboardAfterSale.totalOrders === dashboardBefore.totalOrders + 1 &&
          dashboardAfterSale.openCashSessions === dashboardBefore.openCashSessions + 1,
      );
      const sold = await tx.product.findUniqueOrThrow({ where: { id: product.id } });
      check(
        'Cobro consume existencia y libera reserva una vez',
        sold.stock === product.stock - 1 && sold.reservedStock === product.reservedStock,
      );
      await orders.updateWorkflow(tenant.id, user, order.id, { stage: 'READY' });
      await orders.updateWorkflow(tenant.id, user, order.id, { stage: 'FACTORY' });
      const factoryMember = await tx.membership.findFirstOrThrow({
        where: { tenantId: tenant.id, role: 'WAREHOUSE_KEEPER', status: 'ACTIVE' },
        include: { user: true },
      });
      const factoryUser = { ...factoryMember.user, memberships: [factoryMember] };
      const factoryCard = (await orders.getKanban(tenant.id, factoryUser)).find(
        (entry) => entry.id === order.id,
      );
      check(
        'Fábrica recibe trabajo personalizado sin precios, facturas ni stock físico',
        Boolean(factoryCard) &&
          factoryCard.total === undefined &&
          factoryCard.invoice === undefined &&
          factoryCard.items[0].product.stock === undefined &&
          factoryCard.items[0].product.cost === undefined,
      );
      await orders.updateWorkflow(tenant.id, user, order.id, { stage: 'READY' });
      checks.push('Orden cobrada salta y retrocede etapas sin aprobaciones intermedias');
      await assert.rejects(
        orders.updateWorkflow(tenant.id, user, order.id, { stage: 'DELIVERED' }),
      );
      checks.push('No entregar anticipo con balance');
      await receivables.createPayment(tenant.id, user, invoice.id, {
        cashSessionId: cash.id,
        amount: invoice.balance.toNumber(),
        method: 'CARD',
      });
      await orders.updateWorkflow(tenant.id, user, order.id, { stage: 'DELIVERED' });
      check(
        'Abono con tarjeta permite cerrar entrega',
        (await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).productionStage ===
          'DELIVERED',
      );
      const request = await returns.create(tenant.id, user, {
        invoiceId: invoice.id,
        reason: 'Prueba con reversión',
        refundMethod: 'TRANSFER',
        items: [{ invoiceItemId: invoice.items[0].id, quantity: 1, restock: true }],
      });
      await returns.approve(tenant.id, user, request.id, {
        cashSessionId: cash.id,
        refundMethod: 'TRANSFER',
      });
      const restocked = await tx.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      check(
        'Devolución reintegra existencias de Productos una sola vez',
        restocked.stock === product.stock,
      );
      const credited = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      check(
        'Devolución total deja factura acreditada y pago neto cero',
        credited.status === 'CREDITED' && credited.paidAmount.eq(0),
      );
      const dashboardAfterReturn = await dashboard.getSummary(tenant.id);
      check(
        'Dashboard descuenta devolución y conserva el balance neto',
        Math.abs(
          dashboardAfterReturn.refundsMonth -
            dashboardBefore.refundsMonth -
            invoice.total.toNumber(),
        ) < 0.01 &&
          Math.abs(dashboardAfterReturn.netSalesMonth - dashboardBefore.netSalesMonth) < 0.01,
      );
      let corporate = await orders.create(tenant.id, user, {
        clientName: 'Empresa prueba',
        promisedDate: '2026-11-10',
        isCorporate: true,
        inventorySource: 'SALES_INVENTORY',
        items: [{ productId: product.id, quantity: 2 }],
      });
      await orders.addCorporateUnits(tenant.id, user, corporate.id, {
        units: [
          { recipientName: 'Ana', salesOrderItemId: corporate.items[0].id },
          { recipientName: 'Luis', salesOrderItemId: corporate.items[0].id },
        ],
      });
      const corporateCard = (await orders.getKanban(tenant.id, user)).find(
        (entry) => entry.id === corporate.id,
      );
      check(
        'Producción agrupa dos regalos empresariales en una tarjeta',
        corporateCard?.corporateUnits.length === 2 &&
          corporateCard.corporateUnits.some((unit) => unit.recipientName === 'Ana') &&
          corporateCard.corporateUnits.some((unit) => unit.recipientName === 'Luis'),
      );
      const corporateFactoryCard = (await orders.getKanban(tenant.id, factoryUser)).find(
        (entry) => entry.id === corporate.id,
      );
      check(
        'Fábrica puede consultar el encargo empresarial sin importes ni facturas',
        Boolean(corporateFactoryCard) &&
          corporateFactoryCard.total === undefined &&
          corporateFactoryCard.invoice === undefined,
      );
      await assert.rejects(
        orders.addCorporateUnits(tenant.id, user, corporate.id, {
          units: [{ recipientName: 'Extra', salesOrderItemId: corporate.items[0].id }],
        }),
      );
      checks.push('Destinatarios empresariales no exceden cantidad vendida');
      await orders.cancel(tenant.id, user, corporate.id, { reason: 'Cancelar prueba' });
      const released = await tx.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      check(
        'Cancelación libera reservas sin descontar existencia',
        released.reservedStock === product.reservedStock && released.stock === product.stock,
      );
      const normal = await tx.product.findFirstOrThrow({
        where: { tenantId: tenant.id, sku: 'UP-CAD-001' },
      });
      const shopify = new ShopifyService(scoped, {
        get: (key, fallback) =>
          ({
            SHOPIFY_CLIENT_SECRET: 'test-secret',
            SHOPIFY_STORE_DOMAIN: 'test.myshopify.com',
            SHOPIFY_TENANT_SLUG: 'unique-personalizado',
          })[key] ?? fallback,
      });
      const webhook = async (method, payload) => {
        const raw = Buffer.from(JSON.stringify(payload));
        return shopify[method](raw, payload, {
          shopDomain: 'test.myshopify.com',
          hmac: createHmac('sha256', 'test-secret').update(raw).digest('base64'),
        });
      };
      const payload = {
        id: '9000000000001',
        order_number: 90000001,
        currency: 'DOP',
        financial_status: 'paid',
        total_price: '118',
        total_discounts: '0',
        line_items: [
          {
            id: '900001',
            sku: normal.sku,
            quantity: 1,
            price: '100',
            tax_lines: [{ price: '18' }],
          },
        ],
      };
      const online = await webhook('receiveOrder', payload);
      const duplicate = await webhook('receiveOrder', payload);
      check('Webhook Shopify repetido no duplica orden', duplicate.duplicate === true);
      const afterOnline = await tx.product.findUniqueOrThrow({ where: { id: normal.id } });
      check('Shopify consume una sola unidad', afterOnline.stock === normal.stock - 1);
      await webhook('receiveOrderPaid', payload);
      const refund = {
        id: 'refund-test-1',
        order_id: payload.id,
        refund_line_items: [{ line_item_id: '900001', quantity: 1, restock_type: 'return' }],
        transactions: [{ kind: 'refund', status: 'success', amount: '118' }],
      };
      await webhook('receiveRefund', refund);
      const duplicateRefund = await webhook('receiveRefund', refund);
      check('Reembolso Shopify es idempotente', duplicateRefund.duplicate === true);
      check(
        'Reembolso Shopify repone una sola unidad',
        (await tx.product.findUniqueOrThrow({ where: { id: normal.id } })).stock === normal.stock,
      );
      const historical = await orders.create(
        tenant.id,
        user,
        {
          clientName: 'Cliente histórico',
          promisedDate: '2026-11-10',
          items: [{ productId: normal.id, quantity: 1, unitPrice: 200 }],
        },
        {
          reference: 'ROLLBACK-IMPORT',
          paidAmount: 236,
          inventoryAlreadyDeducted: true,
          stage: 'READY',
          source: 'STORE',
          designApproved: false,
          qualityApproved: false,
        },
      );
      check(
        'Importación conserva precio histórico sin descontar stock otra vez',
        historical.invoice.total.eq(236) &&
          (await tx.product.findUniqueOrThrow({ where: { id: normal.id } })).stock === normal.stock,
      );
      await assert.rejects(
        orders.create(
          tenant.id,
          user,
          {
            promisedDate: '2026-11-10',
            items: [{ productId: normal.id, quantity: 1, unitPrice: 200 }],
          },
          {
            reference: 'ROLLBACK-IMPORT',
            paidAmount: 236,
            inventoryAlreadyDeducted: true,
            stage: 'READY',
            source: 'STORE',
            designApproved: false,
            qualityApproved: false,
          },
        ),
      );
      checks.push('Referencia histórica repetida no duplica documentos');

      const express = await orders.create(tenant.id, user, {
        destination: 'CASH_SALE',
        isExpress: true,
        inventorySource: 'SALES_INVENTORY',
        items: [{ productId: normal.id, quantity: 1 }],
      });
      check('Venta exprés permite omitir nombre y cliente registrado', !express.clientName && !express.customerId);
      check('Venta exprés no requiere fecha prometida', express.promisedAt === null);
      check(
        'Venta exprés no aparece en Kanban',
        !(await orders.getKanban(tenant.id, user)).some((item) => item.id === express.id),
      );
      await orders.claim(tenant.id, user, express.id, { cashSessionId: cash.id });
      await pos.completeSale(tenant.id, user, {
        orderId: express.id,
        cashSessionId: cash.id,
        paymentMethod: 'CASH',
        amountReceived: 100000,
      });
      const expressPaid = await tx.salesOrder.findUniqueOrThrow({ where: { id: express.id } });
      check(
        'Venta exprés se factura y entrega al cobrar',
        expressPaid.status === 'COMPLETED' &&
          expressPaid.productionStage === 'DELIVERED' &&
          Boolean(expressPaid.invoiceId) &&
          Boolean(expressPaid.deliveredAt),
      );

      const creditCustomer = await tx.customer.findFirstOrThrow({
        where: { tenantId: tenant.id, documentNumber: '131999991' },
      });
      const approvals = new CreditApprovalsService(scoped);
      const creditOrder = await orders.create(tenant.id, user, {
        clientName: creditCustomer.name,
        customerId: creditCustomer.id,
        promisedDate: '2026-11-10',
        paymentMode: 'CREDIT',
        initialPaymentOption: 'NONE',
        creditTermOption: 'CUSTOMER_DEFAULT',
        items: [{ productId: normal.id, quantity: 1 }],
      });
      await approvals.approve(tenant.id, user, creditOrder.creditApproval.id, {});
      check(
        'Crédito aprobado conserva factura borrador',
        (await tx.invoice.findUniqueOrThrow({ where: { id: creditOrder.invoiceId } })).status ===
          'DRAFT',
      );
      await orders.claim(tenant.id, user, creditOrder.id, { cashSessionId: cash.id });
      await pos.completeSale(tenant.id, user, {
        orderId: creditOrder.id,
        cashSessionId: cash.id,
        paymentMethod: 'CASH',
        amountReceived: 0,
      });
      const creditInvoice = await tx.invoice.findUniqueOrThrow({
        where: { id: creditOrder.invoiceId },
      });
      check(
        'Venta crédito sin anticipo conserva deuda emitida',
        creditInvoice.balance.eq(creditInvoice.total) && creditInvoice.status !== 'DRAFT',
      );
      await orders.updateWorkflow(tenant.id, user, creditOrder.id, { stage: 'READY' });
      await orders.updateWorkflow(tenant.id, user, creditOrder.id, { stage: 'DELIVERED' });
      checks.push('Crédito autorizado permite entregar con balance');
      const rejectedOrder = await orders.create(tenant.id, user, {
        clientName: creditCustomer.name,
        customerId: creditCustomer.id,
        promisedDate: '2026-11-10',
        paymentMode: 'CREDIT',
        initialPaymentOption: 'NONE',
        creditTermOption: 'CUSTOMER_DEFAULT',
        items: [{ productId: normal.id, quantity: 1 }],
      });
      await approvals.reject(tenant.id, user, rejectedOrder.creditApproval.id, {
        reason: 'Prueba rechazo',
      });
      check(
        'Rechazar crédito cancela también su borrador',
        (await tx.invoice.findUniqueOrThrow({ where: { id: rejectedOrder.invoiceId } })).status ===
          'CANCELLED',
      );
      throw rollback;
    },
    { timeout: 300000, maxWait: 10000 },
  );
})()
  .catch((error) => {
    if (error === rollback)
      console.log(JSON.stringify({ passed: checks.length, rolledBack: true, checks }, null, 2));
    else {
      console.error(error);
      process.exitCode = 1;
    }
  })
  .finally(() => db.$disconnect());

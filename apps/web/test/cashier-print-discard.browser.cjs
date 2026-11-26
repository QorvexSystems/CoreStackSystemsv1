// Run against the isolated release web server, never the live API.
// All API responses, sales and print registrations below are synthetic.
const assert = require('node:assert/strict');
const { chromium } = require('/app/apps/web/node_modules/playwright');
const base = process.env.RIVNU_QA_URL || 'http://127.0.0.1:3038';
const now = new Date().toISOString();
const identity = {
  name: 'Empresa de prueba', documentType: 'RNC', documentNumber: '101850043',
  verification: { source: 'DGII_OFFICIAL', verifiedAt: now, sourceUpdatedAt: now, registryStatus: 'ACTIVO' },
};
const product = {
  id: 'qa-product', name: 'Producto sintético', sku: 'QA', price: '100', salePrice: '100',
  unit: 'UNIT', taxRate: '0.18', taxCategory: 'ITBIS_18', fiscalItemKind: 'GOOD',
  status: 'ACTIVE', stock: 10, reservedStock: 1, trackInventory: true,
};
const line = { id: 'qa-line', productId: product.id, product, description: product.name,
  quantity: '1', reservedQuantity: 1, unitPrice: '100', subtotal: '100',
  taxRate: '0.18', taxTotal: '18', total: '118', discountTotal: '0', unit: 'UNIT' };
const cashier = { id: 'qa-cashier', name: 'Cajero de prueba', email: 'test@example.invalid' };
const cash = { id: 'qa-cash', status: 'OPEN', openedBy: cashier, openedAt: now,
  openingAmount: '100', expectedCashAmount: '100', cashRegister: { id: 'qa-register', name: 'Caja prueba', status: 'ACTIVE' } };

async function scenario(browser, kind, action, reject = false) {
  const electronic = kind !== 'LOCAL_SALE_NOTE';
  const credit = kind === 'FISCAL_CREDIT_ELECTRONIC_31';
  const encf = electronic ? `${credit ? 'E31' : 'E32'}0000000001` : null;
  let order = { id: 'qa-order', orderNumber: 'ORD-QA', status: 'SENT_TO_CASHIER',
    destination: 'CASH_SALE', paymentMode: 'CASH', fiscalPurpose: credit ? 'FISCAL_CREDIT' : 'CONSUMER',
    fiscalDocumentTypeSnapshot: kind, fiscalCustomerSnapshot: credit ? identity : null,
    fiscalIssuanceMode: 'ELECTRONIC_ECF', clientName: 'Empresa de prueba',
    createdBy: { id: 'qa-taker', name: 'Tomador de prueba' }, createdAt: now, sentToCashierAt: now,
    subtotal: '100', taxTotal: '18', discountTotal: '0', total: '118', invoiceId: null,
    items: [line], creditApproval: null, claimedBy: null };
  const invoice = { id: 'qa-invoice', tenantId: 'qa-tenant', invoiceNumber: electronic ? `RIV-${encf}` : 'RIV-0000000001',
    documentType: kind, eNcf: encf, ncf: null, status: electronic ? 'PENDING_ECF' : 'PAID',
    fiscalStatus: electronic ? 'PENDING_SIGNATURE' : 'NOT_APPLICABLE',
    issuedAt: now, createdAt: now, paymentMethod: 'CASH', paymentMode: 'CASH',
    subtotal: '100', taxTotal: '18', total: '118', paidAmount: '118', balance: '0',
    amountReceived: '118', changeAmount: '0', discountTotal: '0', items: [line], payments: [],
    issuedBy: cashier, cashSession: cash, receiptPrintCount: 0,
    fiscalCustomerSnapshot: credit ? identity : null,
    fiscalIssuerSnapshot: { legalName: 'Emisor de prueba', rnc: '101010632', commercialName: 'Prueba', address: 'Dirección de prueba' },
    tenant: { name: 'Prueba', legalName: 'Emisor de prueba' },
  };
  const representation = { scope: { tenantId: 'qa-tenant', issuerRnc: '101010632', environment: 'production' },
    title: credit ? 'Factura de crédito fiscal electrónica' : 'Factura de consumo electrónica',
    encf, issuer: 'Emisor de prueba', issuerRnc: '101010632', total: '118', issuedOn: '2026-11-12',
    signedAt: now, securityCode: 'TEST12', qrUrl: 'https://example.invalid/qa-only', qrVersion: 8,
    signedSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), sections: [], lines: [[]] };
  const writes = [], errors = [];
  let invoiceReads = 0, printAttempts = 0, removed = false, cancelFails = action === 'discard-fails';
  const acceptanceRead = action === 'delayed-print' ? 5 : 2;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'qorvex_session_active', value: '1', url: base }]);
  await context.addInitScript(({ cashier }) => {
    localStorage.setItem('qorvex_session', JSON.stringify({ accessToken: 'synthetic-only', tenantId: 'qa-tenant',
      tenantName: 'Prueba', role: 'CASHIER', permissions: { canUsePos: true }, user: cashier,
      expiresAt: Date.now() + 3600000 }));
    window.__prints = [];
    window.print = () => window.__prints.push({ qr: !!document.querySelector('article svg'), text: document.body.innerText });
  }, { cashier });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'rivnu-api.corestack-systems.com') {
      if (request.url().startsWith(base)) return route.continue();
      return route.abort(); // No contact with DGII or any real external service.
    }
    const path = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({status:204,headers:{'access-control-allow-origin':base,'access-control-allow-headers':'*'}});
    if (request.method() !== 'GET') writes.push(path);
    let data = [];
    let status = 200;
    if (path === '/cash/sessions/current') data = cash;
    else if (path === '/cash/sessions') data = [cash];
    else if (path === '/cash/registers') data = [cash.cashRegister];
    else if (path === '/orders') data = removed ? [] : [order];
    else if (path === '/orders/qa-order/claim') {
      order = { ...order, status: 'IN_CASHIER', claimedBy: cashier, claimedById: cashier.id, claimedCashSession: cash };
      data = order;
    } else if (path === '/orders/qa-order/release') {
      order = { ...order, status: 'SENT_TO_CASHIER', claimedBy: null };
      data = order;
    } else if (path === '/orders/qa-order/cancel') {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (cancelFails) { status = 400; data = { message: 'No se pudo eliminar la orden de prueba.' }; }
      else { removed = true; data = { ...order, status: 'CANCELLED' }; }
    } else if (path === '/pos/sales/complete') {
      removed = true;
      data = invoice;
    } else if (path === '/invoices/qa-invoice') {
      invoiceReads++;
      data = invoiceReads < acceptanceRead || !electronic ? invoice : { ...invoice,
        status: reject ? 'REJECTED' : 'ACCEPTED', fiscalStatus: reject ? 'REJECTED' : 'ACCEPTED' };
    } else if (path === '/invoices/qa-invoice/fiscal-progress') {
      invoiceReads++;
      data = { id: invoice.id, tenantId: invoice.tenantId,
        invoiceNumber: invoice.invoiceNumber, documentType: invoice.documentType,
        eNcf: invoice.eNcf,
        status: invoiceReads < acceptanceRead ? invoice.status : reject ? 'REJECTED' : 'ACCEPTED',
        fiscalStatus: invoiceReads < acceptanceRead ? invoice.fiscalStatus : reject ? 'REJECTED' : 'ACCEPTED',
        electronicDocument: null };
    } else if (path === '/invoices/qa-invoice/print') {
      assert.ok(!electronic || invoiceReads >= 2, 'No print before fiscal acceptance');
      printAttempts++;
      if (action === 'retry-print' && printAttempts === 1) {
        status = 400;
        data = { message: 'La representación impresa verificada todavía no está disponible.' };
      } else {
        data = { printNumber: 1, action: 'PRINT_RECEIPT', isReprint: false, registeredAt: now,
          ...(electronic ? { representation } : {}) };
      }
    } else if (path.includes('/fiscal-details')) {
      const body = request.postDataJSON();
      order = { ...order, fiscalDocumentTypeSnapshot: body.invoiceDocumentType, fiscalPurpose: body.fiscalPurpose };
      data = order;
    }
    else if (path.includes('/tax-identities/lookup')) data = { outcome: 'VERIFIED', documentType: 'RNC',
      documentNumber: identity.documentNumber, fiscalName: identity.name, source: 'DGII_OFFICIAL', checkedAt: now };
    await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': base }, body: JSON.stringify(data) });
  });
  try {
    await page.goto(`${base}/pos`);
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    await page.getByRole('button', { name: 'Eliminar factura', exact: true }).waitFor();
    if (action.startsWith('discard')) {
      await page.getByRole('button', { name: 'Eliminar factura', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Eliminar factura sin cobrar' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Volver', exact: true }).click();
      assert.equal(writes.filter(p => p.endsWith('/cancel')).length, 0);
      await page.getByRole('button', { name: 'Eliminar factura', exact: true }).click();
      await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
      if (cancelFails) {
        await page.getByText('No se pudo eliminar la orden de prueba.', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Volver', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: 'Eliminar factura', exact: true }).isEnabled(), true);
      } else {
        await page.getByText('No hay tickets pendientes de cobro.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Eliminar factura', exact: true }).count(), 0);
      }
      assert.equal(writes.filter(p => p.endsWith('/cancel')).length, 1);
      assert.equal(writes.filter(p => p === '/pos/sales/complete' || p.includes('/invoices/')).length, 0);
    } else {
      if (kind === 'CONSUMER_ELECTRONIC_32') await page.getByLabel('Metodo de pago', { exact: true }).selectOption('CARD');
      else await page.locator('#amountReceived').fill('11800');
      await page.getByRole('button', { name: electronic ? 'Cobrar y emitir e-CF' : 'Facturar e imprimir', exact: true }).click();
      if (kind === 'CONSUMER_ELECTRONIC_32') await page.getByRole('button', { name: 'Sí, facturar', exact: true }).click();
      await page.waitForURL('**/pos/receipts/qa-invoice?autoPrint=1');
      if (action === 'delayed-print') {
        await page.getByText('Venta cobrada. Preparando la factura.').waitFor();
        assert.equal((await page.evaluate(() => window.__prints)).length, 0);
      }
      if (reject) {
        await page.waitForFunction(() => document.body.innerText.includes('cuando DGII acepte'));
        await page.waitForTimeout(2500);
        assert.equal((await page.evaluate(() => window.__prints)).length, 0);
      } else {
        await page.waitForFunction(() => window.__prints.length === 1);
        await page.waitForTimeout(2500);
        const prints = await page.evaluate(() => window.__prints);
        assert.equal(prints.length, 1, 'Auto print must run once only');
        assert.equal(prints[0].qr, electronic);
        if (electronic) assert.ok(prints[0].text.includes(encf));
        assert.equal(writes.filter(p => p.endsWith('/print')).length, action === 'retry-print' ? 2 : 1);
        if (action === 'manual-fallback') {
          await page.getByRole('button', { name: 'Abrir impresión' }).click();
          assert.equal((await page.evaluate(() => window.__prints)).length, 2);
          assert.equal(writes.filter(p => p.endsWith('/print')).length, 1);
        }
      }
      assert.equal(writes.filter(p => p === '/pos/sales/complete').length, 1);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${kind} ${action}${reject ? ' rejected: no print' : ''}`);
  } catch (error) {
    console.error('SYNTHETIC_BROWSER_STATE', { kind, action, url: page.url(), errors,
      text: await page.locator('body').innerText() });
    throw error;
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const kind of ['FISCAL_CREDIT_ELECTRONIC_31', 'CONSUMER_ELECTRONIC_32', 'LOCAL_SALE_NOTE']) {
      await scenario(browser, kind, 'print');
    }
    await scenario(browser, 'FISCAL_CREDIT_ELECTRONIC_31', 'delayed-print');
    await scenario(browser, 'CONSUMER_ELECTRONIC_32', 'delayed-print');
    await scenario(browser, 'FISCAL_CREDIT_ELECTRONIC_31', 'retry-print');
    await scenario(browser, 'FISCAL_CREDIT_ELECTRONIC_31', 'manual-fallback');
    await scenario(browser, 'FISCAL_CREDIT_ELECTRONIC_31', 'print', true);
    await scenario(browser, 'CONSUMER_ELECTRONIC_32', 'discard');
    await scenario(browser, 'CONSUMER_ELECTRONIC_32', 'discard-fails');
    await scenario(browser, 'LOCAL_SALE_NOTE', 'discard');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

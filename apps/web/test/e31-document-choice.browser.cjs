// Shared synthetic browser regression for the ALLPA and RIVNU E31 selectors.
// Every API request is intercepted; no invoice or DGII request is created.
const assert = require('node:assert/strict');
const { chromium } = require('/app/apps/web/node_modules/playwright');
const app = process.env.E31_TEST_APP;
if (!['allpa', 'rivnu'].includes(app)) throw new Error('E31_TEST_APP must be allpa or rivnu');
const base = 'http://127.0.0.1:3000';
const now = new Date().toISOString();
const numbers = { RNC: '101850043', CEDULA: '00113918205' };
const cashier = { id: 'qa-cashier', name: 'Caja QA', email: 'qa@example.invalid' };
const cash = { id: 'qa-cash', status: 'OPEN', openedAt: now, openedBy: cashier,
  openingAmount: '100', expectedCashAmount: '100', cashRegister: { id: 'qa-register', name: 'Caja QA', status: 'ACTIVE' } };
const product = { id: 'qa-product', name: 'Producto QA', price: '118', salePrice: '118',
  unit: 'UNIT', stock: 10, reservedStock: 1, trackInventory: true, taxRate: '0.18', status: 'ACTIVE' };

async function scenario(browser, type, outcome, switchType = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'qorvex_session_active', value: '1', url: base }]);
  await context.addInitScript(({ app, cashier }) => localStorage.setItem('qorvex_session', JSON.stringify({
    accessToken: 'synthetic-only', tenantId: 'qa-tenant', tenantName: 'QA', tenantSlug: app, salePricesIncludeTax: true,
    role: 'CASHIER', user: cashier, permissions: { canUsePos: true }, expiresAt: Date.now() + 3600000,
  })), { app, cashier });
  let order = { id: 'qa-order', orderNumber: 'ORD-QA', tenantId: 'qa-tenant', status: 'SENT_TO_CASHIER',
    clientName: 'Cliente de prueba', createdAt: now, sentToCashierAt: now, createdBy: cashier,
    destination: 'CASH_SALE', paymentMode: 'CASH', inventorySource: 'WAREHOUSE',
    fiscalPurpose: 'CONSUMER', fiscalDocumentTypeSnapshot: 'LOCAL_SALE_NOTE', fiscalCustomerSnapshot: null,
    fiscalIssuanceMode: 'ELECTRONIC_ECF', electronicInvoiceRequested: false, customerId: null,
    total: '118', subtotal: '100', taxTotal: '18', discountTotal: '0', discountRate: '0',
    items: [{ id: 'qa-line', productId: product.id, product, description: product.name, quantity: '1',
      unitPrice: '100', originalUnitPrice: '100', regularTotal: '118', subtotal: '100', taxTotal: '18', total: '118',
      discountTotal: '0', reservedQuantity: 1, unit: 'UNIT', taxRate: '0.18' }] };
  const queries = [], saves = [], checkouts = [], errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== `${app}-api.corestack-systems.com`) return request.url().startsWith(base) ? route.continue() : route.abort();
    const headers = { 'access-control-allow-origin': base, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let data = [], status = 200;
    const path = url.pathname;
    if (path === '/cash/sessions/current') data = cash;
    else if (path === '/cash/registers') data = [cash.cashRegister];
    else if (path === '/cash/sessions') data = [cash];
    else if (path === '/orders') data = [order];
    else if (path === '/orders/qa-order/claim') { order = { ...order, status: 'IN_CASHIER', claimedBy: cashier, claimedById: cashier.id, claimedCashSession: cash }; data = order; }
    else if (path === '/tax-identities/lookup' || path === '/pos/rnc/lookup') {
      const input = app === 'rivnu' ? request.postDataJSON() : { documentType: url.searchParams.get('documentType'), documentNumber: url.searchParams.get('rnc') };
      queries.push(input);
      const selectedOutcome = input.documentNumber.replace(/\D/g, '') === numbers.RNC && switchType ? 'VERIFIED' : outcome;
      data = { documentType: input.documentType, documentNumber: input.documentNumber.replace(/\D/g, ''),
        outcome: selectedOutcome, fiscalName: selectedOutcome === 'VERIFIED' ? 'Contribuyente sintético' : null,
        source: 'DGII_OFFICIAL', sourceUpdatedAt: now, checkedAt: now, registryStatus: selectedOutcome === 'NON_ACTIVE' ? 'SUSPENDIDO' : 'ACTIVO' };
    } else if (path === '/pos/orders/qa-order/fiscal-details') {
      const input = request.postDataJSON(); saves.push(input);
      order = { ...order, fiscalPurpose: input.fiscalPurpose, fiscalDocumentTypeSnapshot: input.invoiceDocumentType,
        fiscalCustomerSnapshot: input.documentType ? { id: null, name: 'Contribuyente sintético', operationalName: order.clientName,
          documentType: input.documentType, documentNumber: input.documentNumber.replace(/\D/g, ''),
          verification: { outcome: 'VERIFIED', source: 'DGII_OFFICIAL', verifiedAt: now, sourceUpdatedAt: now, registryStatus: 'ACTIVO' } } : null };
      data = order;
    } else if (path === '/pos/sales/complete') {
      checkouts.push(request.postDataJSON()); status = 400; data = { message: 'SYNTHETIC_STOP_NO_INVOICE' };
    } else if (request.method() !== 'GET') throw new Error(`Unexpected synthetic write ${path}`);
    await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(data) });
  });
  try {
    await page.goto(`${base}/pos`);
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    if (app === 'allpa') await page.locator('#documentType').selectOption('FISCAL_CREDIT_ELECTRONIC_31');
    else await page.getByRole('button', { name: /Crédito fiscal · E31/ }).click();
    const select = page.locator(app === 'allpa' ? '#fiscalDocumentType' : '#posFiscalDocumentType');
    const number = page.locator(app === 'allpa' ? '#fiscalDocumentNumber' : '#posFiscalDocumentNumber');
    const submit = page.getByRole('button', { name: app === 'allpa' ? 'Facturar e imprimir' : 'Cobrar y emitir e-CF', exact: true });
    await select.waitFor();
    assert.equal(await select.isEnabled(), true);
    assert.equal(await select.evaluate((element, id) => !!(element.compareDocumentPosition(document.querySelector(id)) & Node.DOCUMENT_POSITION_FOLLOWING), app === 'allpa' ? '#fiscalDocumentNumber' : '#posFiscalDocumentNumber'), true);
    await page.locator('#amountReceived').fill('11800');
    if (switchType) {
      await number.fill(numbers.RNC);
      await page.waitForFunction(() => document.body.innerText.includes('Contribuyente sintético'));
      await page.waitForFunction(id => !document.querySelector(id).disabled, app === 'allpa' ? '#fiscalDocumentType' : '#posFiscalDocumentType');
    }
    await select.selectOption(type);
    assert.equal(await number.inputValue(), '', 'Changing document type clears the previous number');
    const value = outcome === 'INVALID' ? '00113918200' : numbers[type];
    const lookupResponse = !['VERIFIED', 'INVALID'].includes(outcome)
      ? page.waitForResponse(response => response.url().includes(app === 'allpa' ? '/rnc/lookup' : '/tax-identities/lookup') && response.request().method() !== 'OPTIONS')
      : null;
    await number.fill(value);
    if (outcome === 'VERIFIED') {
      await page.waitForFunction(label => Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === label && !button.disabled), app === 'allpa' ? 'Facturar e imprimir' : 'Cobrar y emitir e-CF');
      assert.ok(queries.some(query => query.documentType === type && query.documentNumber.replace(/\D/g, '') === numbers[type]));
      if (app === 'rivnu') {
        assert.ok(saves.some(save => save.documentType === type && save.documentNumber.replace(/\D/g, '') === numbers[type]));
      }
      await submit.click();
      await page.waitForFunction(() => document.body.innerText.includes('SYNTHETIC_STOP_NO_INVOICE'));
      assert.equal(checkouts.length, 1);
      if (app === 'allpa') {
        assert.equal(checkouts[0].fiscalDocumentType, type);
        assert.equal(checkouts[0].fiscalDocumentNumber.replace(/\D/g, ''), numbers[type]);
      }
    } else {
      if (lookupResponse) await lookupResponse;
      await page.waitForTimeout(500);
      assert.equal(await submit.isDisabled(), true);
      assert.equal(checkouts.length, 0);
      assert.ok(!saves.some(save => save.documentType === type));
      if (outcome === 'INVALID') assert.equal(queries.filter(query => query.documentType === type).length, 0);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${app} E31 ${type} ${outcome}${switchType ? ' after RNC switch' : ''}`);
  } catch (error) {
    console.error('SYNTHETIC_BROWSER_STATE', { app, type, outcome, errors, text: await page.locator('body').innerText() });
    throw error;
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    await scenario(browser, 'RNC', 'VERIFIED');
    await scenario(browser, 'CEDULA', 'VERIFIED');
    await scenario(browser, 'CEDULA', 'VERIFIED', true);
    for (const outcome of ['NOT_FOUND', 'NON_ACTIVE', 'INVALID']) await scenario(browser, 'CEDULA', outcome);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

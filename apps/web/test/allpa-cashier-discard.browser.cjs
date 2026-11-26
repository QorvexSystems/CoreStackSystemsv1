// All data and API actions are synthetic. Run only against the QA container.
const assert = require('node:assert/strict');
const { chromium } = require('/app/apps/web/node_modules/playwright');
const base = process.env.ALLPA_QA_URL || 'http://127.0.0.1:3000';
const now = new Date().toISOString();
const cashier = { id: 'qa-cashier', name: 'Operador de prueba', email: 'qa@example.invalid' };
const cash = { id: 'qa-cash', status: 'OPEN', openedBy: cashier, openedAt: now,
  openingAmount: '100', expectedCashAmount: '100', cashRegister: { id: 'qa-register', name: 'Caja QA', status: 'ACTIVE' } };
const product = { id: 'qa-product', name: 'Producto de prueba', salePrice: '118', price: '118',
  stock: 10, reservedStock: 1, trackInventory: true, unit: 'UNIT', taxRate: '0.18', status: 'ACTIVE' };

async function scenario(browser, mode, role = 'CASHIER') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'qorvex_session_active', value: '1', url: base }]);
  await context.addInitScript(({ cashier, role }) => localStorage.setItem('qorvex_session', JSON.stringify({
    accessToken: 'synthetic-only', tenantId: 'qa-tenant', tenantName: 'ALLPA QA', tenantSlug: 'allpa',
    salePricesIncludeTax: true, role, user: cashier, permissions: { canUsePos: true }, expiresAt: Date.now() + 3600000,
  })), { cashier, role });
  let order = { id: 'qa-order', orderNumber: 'ORD-QA', status: 'SENT_TO_CASHIER',
    tenantId: 'qa-tenant', clientName: 'Cliente de prueba', inventorySource: 'WAREHOUSE',
    destination: 'CASH_SALE', paymentMode: 'CASH', electronicInvoiceRequested: false,
    createdBy: { id: 'qa-taker', name: 'Tomador de prueba' }, createdAt: now, sentToCashierAt: now,
    subtotal: '100', taxTotal: '18', total: '118', discountTotal: '0', discountRate: '0',
    invoiceId: null, creditApproval: null, discountApproval: null,
    items: [{ id: 'qa-item', productId: product.id, product, description: product.name,
      quantity: '1', reservedQuantity: 1, unitPrice: '100', subtotal: '100', taxTotal: '18', total: '118',
      regularTotal: '118', discountTotal: '0', taxRate: '0.18', unit: 'UNIT' }] };
  let removed = false, failOnce = mode === 'retry';
  let unlockClaim;
  const claimGate = mode === 'claim-pending' ? new Promise(resolve => { unlockClaim = resolve; }) : Promise.resolve();
  const writes = [], errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'allpa-api.corestack-systems.com') {
      return request.url().startsWith(base) ? route.continue() : route.abort();
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      'access-control-allow-origin': base, 'access-control-allow-headers': '*',
    } });
    const path = url.pathname;
    if (request.method() !== 'GET') writes.push(path);
    let data = [], status = 200;
    if (path === '/cash/sessions/current') data = cash;
    else if (path === '/cash/sessions') data = [cash];
    else if (path === '/cash/registers') data = [cash.cashRegister];
    else if (path === '/orders') data = removed ? [] : [order];
    else if (path === '/orders/qa-order') data = order;
    else if (path === '/orders/qa-order/claim') {
      await claimGate;
      order = { ...order, status: 'IN_CASHIER', claimedBy: cashier, claimedById: cashier.id,
        claimedCashSession: cash, claimedCashSessionId: cash.id };
      data = order;
    } else if (path === '/orders/qa-order/release') {
      order = { ...order, status: 'SENT_TO_CASHIER', claimedBy: null, claimedById: null };
      data = order;
    } else if (path === '/orders/qa-order/cancel') {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (failOnce) { failOnce = false; status = 400; data = { message: 'No se pudo eliminar la orden de prueba.' }; }
      else { removed = true; order = { ...order, status: 'CANCELLED', claimedById: null }; data = order; }
    } else if (request.method() !== 'GET') {
      throw new Error(`Unexpected synthetic write: ${path}`);
    }
    await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': base }, body: JSON.stringify(data) });
  });
  try {
    await page.goto(`${base}/pos${mode === 'requested' ? '?order=qa-order' : ''}`);
    assert.equal(await page.getByRole('button', { name: 'Eliminar factura', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    const remove = page.getByRole('button', { name: 'Eliminar factura', exact: true });
    await remove.waitFor();
    if (mode === 'claim-pending') {
      assert.equal(await remove.isDisabled(), true, 'No discard during optimistic claim');
      assert.equal(writes.filter(path => path.endsWith('/cancel')).length, 0);
      unlockClaim();
    }
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('Eliminar factura') && !button.disabled));
    if (mode === 'release') {
      await page.getByRole('button', { name: 'Limpiar', exact: true }).first().click();
      await remove.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Cobrar', exact: true }).waitFor();
      assert.equal(writes.filter(path => path.endsWith('/release')).length, 1);
      assert.equal(writes.filter(path => path.endsWith('/cancel')).length, 0);
    } else {
      await remove.click();
      const dialog = page.getByRole('dialog', { name: 'Eliminar factura sin cobrar' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Volver', exact: true }).click();
      assert.equal(writes.filter(path => path.endsWith('/cancel')).length, 0);
      await remove.click();
      await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
      if (mode === 'retry') {
        await page.getByText('No se pudo eliminar la orden de prueba.', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Volver', exact: true }).click();
        assert.equal(await remove.isEnabled(), true);
        await remove.click();
        await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
      }
      await page.getByText('No hay tickets pendientes de cobro.', { exact: true }).waitFor();
      assert.equal(await remove.count(), 0);
      assert.equal(writes.filter(path => path.endsWith('/cancel')).length, mode === 'retry' ? 2 : 1);
      assert.equal(writes.filter(path => path.endsWith('/release')).length, 0);
    }
    assert.ok(writes.every(path => /^\/orders\/qa-order\/(claim|cancel|release)$/.test(path)), 'No invoices, payments or fiscal submissions');
    assert.deepEqual(errors, []);
    console.log(`PASS ALLPA ${role} ${mode}`);
  } catch (error) {
    console.error('SYNTHETIC_BROWSER_STATE', { mode, role, errors, text: await page.locator('body').innerText() });
    throw error;
  } finally { if (unlockClaim) unlockClaim(); await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const mode of ['discard', 'retry', 'release', 'claim-pending', 'requested']) await scenario(browser, mode);
    await scenario(browser, 'discard', 'ORDER_TAKER');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Load the actual pure TypeScript calculation without generating build files.
const source = fs.readFileSync(path.join(__dirname, '../components/operations/pos/payment-summary.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const loaded = { exports: {} };
new Function('exports', compiled.outputText)(loaded.exports);
const { paymentSummary } = loaded.exports;
const calculate = (overrides = {}) => paymentSummary({
  total: 2950, received: 2950, paymentMethod: 'CASH', allowPartial: true, ...overrides,
});

test('efectivo exacto paga toda la factura', () => {
  assert.deepEqual(calculate(), { requiredPayment: 2950, received: 2950, remainingBalance: 0, change: 0, valid: true });
});
test('efectivo mayor aplica solo el total y devuelve la diferencia', () => {
  assert.deepEqual(calculate({ received: 3000 }), { requiredPayment: 2950, received: 3000, remainingBalance: 0, change: 50, valid: true });
});
test('un único monto registra abono y balance para un cliente identificado', () => {
  assert.deepEqual(calculate({ received: 1000 }), { requiredPayment: 1000, received: 1000, remainingBalance: 1950, change: 0, valid: true });
});
test('vacío, cero y negativo no facturan una venta normal sin pago', () => {
  assert.equal(calculate({ received: 0 }).valid, false);
  assert.equal(calculate({ received: -1 }).valid, false);
});
test('venta exprés o consumidor sin identificar requiere el monto completo', () => {
  const result = calculate({ received: 1000, allowPartial: false });
  assert.equal(result.requiredPayment, 2950);
  assert.equal(result.valid, false);
});
test('tarjeta y transferencia admiten abonos pero nunca devuelta', () => {
  for (const paymentMethod of ['CARD', 'TRANSFER']) {
    assert.equal(calculate({ paymentMethod, received: 1000 }).requiredPayment, 1000);
    assert.equal(calculate({ paymentMethod, received: 1000 }).valid, true);
    assert.equal(calculate({ paymentMethod, received: 3000 }).valid, false);
    assert.equal(calculate({ paymentMethod, received: 3000 }).change, 0);
  }
});
test('crédito conserva el inicial autorizado, incluido crédito sin inicial', () => {
  assert.equal(calculate({ initialPayment: 500, received: 1000 }).change, 500);
  assert.equal(calculate({ initialPayment: 500, received: 100 }).valid, false);
  assert.equal(calculate({ initialPayment: 0, received: 0 }).valid, true);
  assert.equal(calculate({ initialPayment: 0, received: 100 }).valid, false);
});
test('cálculo monetario redondea a centavos', () => {
  assert.equal(calculate({ total: 0.3, received: 0.1 }).remainingBalance, 0.2);
  assert.equal(calculate({ total: 0.1, received: 0.3 }).change, 0.2);
});

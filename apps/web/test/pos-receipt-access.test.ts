import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessPath } from '../lib/authorization';
import type { AuthSession } from '../lib/auth-session';

const cashier = {
  role: 'CASHIER',
  permissions: { canUsePos: true, canReprintReceipt: false },
} as AuthSession;

test('cashier can open the POS receipt without gaining access to Facturas', () => {
  assert.equal(canAccessPath(cashier, '/pos/receipts/invoice-id'), true);
  assert.equal(canAccessPath(cashier, '/invoices'), false);
  assert.equal(canAccessPath(cashier, '/invoices/invoice-id'), false);
});

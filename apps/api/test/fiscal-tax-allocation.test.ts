import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@qorvex/database';
import { allocateFiscalTaxByRate } from '../src/common/utils/fiscal-tax-allocation';

const d = (value: string) => new Prisma.Decimal(value);

test('allocates line cents to DGII aggregate tax without changing the taxable base', () => {
  const bases = [
    '115.20', '115.20', '55.00', '50.84', '33.89', '50.84', '33.88',
    '25.42', '16.94', '25.42', '50.84', '254.20', '33.89', '63.55',
  ];
  const lines = allocateFiscalTaxByRate(
    bases.map((subtotal, index) => ({ id: index, subtotal: d(subtotal), taxRate: d('0.18') })),
  );

  assert.equal(lines.reduce((sum, line) => sum.add(line.subtotal), d('0')).toFixed(2), '925.11');
  assert.equal(lines.reduce((sum, line) => sum.add(line.taxTotal), d('0')).toFixed(2), '166.52');
  assert.equal(lines.reduce((sum, line) => sum.add(line.total), d('0')).toFixed(2), '1091.63');
  assert.ok(lines.every((line) => line.taxTotal.gte(0)));
});

test('allocates each tax rate independently and leaves exempt lines at zero', () => {
  const lines = allocateFiscalTaxByRate([
    { subtotal: d('0.03'), taxRate: d('0.18') },
    { subtotal: d('0.03'), taxRate: d('0.18') },
    { subtotal: d('0.03'), taxRate: d('0.16') },
    { subtotal: d('50.00'), taxRate: d('0') },
  ]);

  assert.equal(lines[0]!.taxTotal.add(lines[1]!.taxTotal).toFixed(2), '0.01');
  assert.equal(lines[2]!.taxTotal.toFixed(2), '0.00');
  assert.equal(lines[3]!.taxTotal.toFixed(2), '0.00');
});

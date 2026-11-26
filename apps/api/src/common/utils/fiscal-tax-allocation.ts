import { Prisma } from '@qorvex/database';

type TaxableLine = Readonly<{
  subtotal: Prisma.Decimal;
  taxRate: Prisma.Decimal;
}>;

/**
 * DGII calculates ITBIS from the aggregate taxable base for each rate. ERP
 * lines still need cent values whose sum equals that authoritative aggregate,
 * so the unavoidable rounding remainder is allocated deterministically.
 */
export function allocateFiscalTaxByRate<T extends TaxableLine>(lines: readonly T[]) {
  const result = lines.map((line) => ({
    ...line,
    taxTotal: line.subtotal.mul(line.taxRate).toDecimalPlaces(2),
  }));
  const indexesByRate = new Map<string, number[]>();

  result.forEach((line, index) => {
    const key = line.taxRate.toFixed(6);
    indexesByRate.set(key, [...(indexesByRate.get(key) ?? []), index]);
  });

  for (const indexes of indexesByRate.values()) {
    const rate = result[indexes[0]!]!.taxRate;
    const target = indexes
      .reduce((sum, index) => sum.add(result[index]!.subtotal), new Prisma.Decimal(0))
      .mul(rate)
      .toDecimalPlaces(2);
    const allocated = indexes.reduce(
      (sum, index) => sum.add(result[index]!.taxTotal),
      new Prisma.Decimal(0),
    );
    let remainingCents = target.sub(allocated).mul(100).toNumber();

    if (!Number.isSafeInteger(remainingCents)) {
      throw new Error('FISCAL_TAX_ALLOCATION_INVALID');
    }

    const direction = Math.sign(remainingCents);
    if (direction === 0) continue;
    const adjustment = new Prisma.Decimal(direction).div(100);
    const candidates = [...indexes].sort((left, right) => {
      const leftLine = result[left]!;
      const rightLine = result[right]!;
      const leftResidual = leftLine.subtotal.mul(leftLine.taxRate).sub(leftLine.taxTotal);
      const rightResidual = rightLine.subtotal.mul(rightLine.taxRate).sub(rightLine.taxTotal);
      const comparison = rightResidual.comparedTo(leftResidual) * direction;
      return comparison || left - right;
    });

    let cursor = 0;
    while (remainingCents !== 0) {
      const index = candidates[cursor % candidates.length]!;
      const next = result[index]!.taxTotal.add(adjustment);
      if (next.gte(0)) {
        result[index]!.taxTotal = next;
        remainingCents -= direction;
      }
      cursor++;
      if (cursor > candidates.length * 10_000) {
        throw new Error('FISCAL_TAX_ALLOCATION_EXHAUSTED');
      }
    }
  }

  return result.map((line) => ({
    ...line,
    total: line.subtotal.add(line.taxTotal).toDecimalPlaces(2),
  }));
}

export function summarizeFiscalTax(lines: readonly TaxableLine[]) {
  const allocated = allocateFiscalTaxByRate(lines);
  const subtotal = allocated
    .reduce((sum, line) => sum.add(line.subtotal), new Prisma.Decimal(0))
    .toDecimalPlaces(2);
  const taxTotal = allocated
    .reduce((sum, line) => sum.add(line.taxTotal), new Prisma.Decimal(0))
    .toDecimalPlaces(2);
  return { subtotal, taxTotal, total: subtotal.add(taxTotal).toDecimalPlaces(2) };
}

import { Prisma } from '@qorvex/database';

type SaleLineInput = {
  advertisedUnitPrice: Prisma.Decimal;
  quantity: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  discountRate?: Prisma.Decimal;
  pricesIncludeTax: boolean;
};

export type ComputedSaleAmounts = {
  unitPrice: Prisma.Decimal;
  regularTotal: Prisma.Decimal;
  regularSubtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
};

const one = new Prisma.Decimal(1);
const zero = new Prisma.Decimal(0);

/**
 * Converts the advertised price into the fiscal base and ITBIS snapshot used by
 * orders and invoices. For tax-inclusive tenants, `total` always remains the
 * exact amount shown to the customer and ITBIS is extracted from that amount.
 */
export function computeSaleAmounts({
  advertisedUnitPrice,
  quantity,
  taxRate,
  discountRate = zero,
  pricesIncludeTax,
}: SaleLineInput): ComputedSaleAmounts {
  const discountMultiplier = one.sub(discountRate);

  if (!pricesIncludeTax) {
    const unitPrice = advertisedUnitPrice.mul(discountMultiplier).toDecimalPlaces(2);
    const regularSubtotal = quantity.mul(advertisedUnitPrice).toDecimalPlaces(2);
    const regularTotal = regularSubtotal.add(regularSubtotal.mul(taxRate).toDecimalPlaces(2));
    const subtotal = quantity.mul(unitPrice).toDecimalPlaces(2);
    const discountTotal = regularSubtotal.sub(subtotal).toDecimalPlaces(2);
    const taxTotal = subtotal.mul(taxRate).toDecimalPlaces(2);

    return {
      unitPrice,
      regularTotal,
      regularSubtotal,
      discountTotal,
      subtotal,
      taxTotal,
      total: subtotal.add(taxTotal).toDecimalPlaces(2),
    };
  }

  const regularTotal = quantity.mul(advertisedUnitPrice).toDecimalPlaces(2);
  const total = regularTotal.mul(discountMultiplier).toDecimalPlaces(2);
  const divisor = one.add(taxRate);
  const regularSubtotal = taxRate.gt(0)
    ? regularTotal.div(divisor).toDecimalPlaces(2)
    : regularTotal;
  const subtotal = taxRate.gt(0) ? total.div(divisor).toDecimalPlaces(2) : total;
  const taxTotal = total.sub(subtotal).toDecimalPlaces(2);
  const discountTotal = regularSubtotal.sub(subtotal).toDecimalPlaces(2);
  const unitPrice = quantity.gt(0)
    ? subtotal.div(quantity).toDecimalPlaces(2)
    : new Prisma.Decimal(0);

  return {
    unitPrice,
    regularTotal,
    regularSubtotal,
    discountTotal,
    subtotal,
    taxTotal,
    total,
  };
}

import type { Product } from '@/lib/api';

const fractionalUnits = new Set(['METER', 'FOOT', 'YARD', 'POUND']);
const commonProductPrefix = '__COMMON__:';

export function getCommonProductUnit(sku: string | null | undefined) {
  return sku?.startsWith(commonProductPrefix) ? sku.slice(commonProductPrefix.length) : 'UNIT';
}

export function getProductPrice(product: Product) {
  const salePrice = Number(product.salePrice);
  return salePrice > 0 ? salePrice : Number(product.price);
}

export function getCustomerUnitPrice(product: Product, pricesIncludeTax: boolean) {
  const price = getProductPrice(product);
  return pricesIncludeTax ? price : roundMoney(price * (1 + Number(product.taxRate)));
}

export function calculateSaleAmounts(
  advertisedUnitPrice: number,
  quantity: number,
  taxRate: number,
  discountRate = 0,
  pricesIncludeTax = false,
) {
  if (!pricesIncludeTax) {
    const unitPrice = roundMoney(advertisedUnitPrice * (1 - discountRate));
    const regularSubtotal = roundMoney(advertisedUnitPrice * quantity);
    const regularTotal = roundMoney(regularSubtotal + roundMoney(regularSubtotal * taxRate));
    const subtotal = roundMoney(unitPrice * quantity);
    const taxTotal = roundMoney(subtotal * taxRate);
    return {
      unitPrice,
      regularTotal,
      regularSubtotal,
      discountTotal: roundMoney(Math.max(regularSubtotal - subtotal, 0)),
      subtotal,
      taxTotal,
      total: roundMoney(subtotal + taxTotal),
    };
  }

  const regularTotal = roundMoney(advertisedUnitPrice * quantity);
  const total = roundMoney(regularTotal * (1 - discountRate));
  const regularSubtotal = taxRate > 0 ? roundMoney(regularTotal / (1 + taxRate)) : regularTotal;
  const subtotal = taxRate > 0 ? roundMoney(total / (1 + taxRate)) : total;

  return {
    unitPrice: quantity > 0 ? roundMoney(subtotal / quantity) : 0,
    regularTotal,
    regularSubtotal,
    discountTotal: roundMoney(Math.max(regularSubtotal - subtotal, 0)),
    subtotal,
    taxTotal: roundMoney(total - subtotal),
    total,
  };
}

export function customerDiscountForLine(
  line: {
    regularTotal?: number | string | null;
    total: number | string;
    discountTotal?: number | string | null;
    taxRate?: number | string | null;
  },
  pricesIncludeTax: boolean,
) {
  if (!pricesIncludeTax) return roundMoney(Number(line.discountTotal ?? 0));
  if (line.regularTotal !== null && line.regularTotal !== undefined) {
    return roundMoney(Math.max(Number(line.regularTotal) - Number(line.total), 0));
  }
  // Older records have only the fiscal base discount, not the advertised total.
  return roundMoney(Number(line.discountTotal ?? 0) * (1 + Number(line.taxRate ?? 0)));
}

export function uniqueValues(values: string[]) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function getAvailableStock(product: Product) {
  if (product.inventoryDestination === 'WAREHOUSE') {
    return Math.max(
      Number(product.warehouseStocks?.[0]?.quantity ?? 0) - Number(product.reservedStock),
      0,
    );
  }
  return Math.max(Number(product.stock) - Number(product.reservedStock), 0);
}

export function isStockLimited(product: Product) {
  return product.trackInventory || product.inventoryDestination === 'WAREHOUSE';
}

export function allowsFractionalQuantity(product: Pick<Product, 'unit'>) {
  return fractionalUnits.has(product.unit);
}

export function getQuantityStep(product: Pick<Product, 'unit'>) {
  return allowsFractionalQuantity(product) ? 0.01 : 1;
}

export function getDefaultQuantity(product: Product) {
  if (!isStockLimited(product)) {
    return 1;
  }

  const availableStock = getAvailableStock(product);

  if (allowsFractionalQuantity(product) && availableStock > 0 && availableStock < 1) {
    return roundQuantity(availableStock);
  }

  return 1;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function roundQuantity(value: number) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function formatQuantity(value: number | string | null | undefined) {
  const numericValue = Number(value ?? 0);

  if (!Number.isFinite(numericValue)) {
    return '0';
  }

  return Number.isInteger(numericValue)
    ? String(numericValue)
    : numericValue.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function getProductInitials(product: Product) {
  return product.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
}

export function canAddProduct(product: Product, currentQuantity = 0) {
  if (!isStockLimited(product)) {
    return true;
  }

  return getAvailableStock(product) > currentQuantity;
}

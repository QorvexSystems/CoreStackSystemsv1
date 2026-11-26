import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  FiscalItemKind,
  Prisma,
  ProductUnit,
  SalesOrderPriceLevel,
  TaxCategory,
} from '@qorvex/database';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PosService } from '../src/modules/pos/pos.service';
import { CreateProductDto } from '../src/modules/products/dto/create-product.dto';

const decimal = (value: string) => new Prisma.Decimal(value);
function product(kind: FiscalItemKind | null = FiscalItemKind.GOOD) {
  return {
    id: 'product-1',
    tenantId: 'tenant-rivnu',
    name: 'Synthetic product',
    sku: null,
    barcode: null,
    unit: ProductUnit.UNIT,
    salePrice: decimal('100'),
    price: decimal('120'),
    taxCategory: TaxCategory.ITBIS_18,
    taxRate: decimal('0.18'),
    fiscalItemKind: kind,
    trackInventory: false,
    stock: 0,
    reservedStock: 0,
  };
}

test('order calculation captures the selected original price before discount, without changing totals', async () => {
  const catalogue = product();
  const prisma = { product: { findMany: async () => [catalogue] } };
  const orders = new OrdersService(prisma as never);
  const computed = await orders['computeOrder'](
    'tenant-rivnu',
    [{ productId: catalogue.id, quantity: 2 }],
    prisma as never,
    SalesOrderPriceLevel.DISCOUNT_10,
  );
  assert.equal(computed.items[0].originalUnitPrice.toString(), '100');
  assert.equal(computed.items[0].unitPrice.toString(), '95');
  assert.equal(computed.discountTotal.toString(), '10');
  assert.equal(computed.total.toString(), '224.2');
});

test('order original price uses the same fallback as pricing, not an independent catalogue lookup', async () => {
  const catalogue = { ...product(), salePrice: decimal('0') };
  const prisma = { product: { findMany: async () => [catalogue] } };
  const orders = new OrdersService(prisma as never);
  const computed = await orders['computeOrder']('tenant-rivnu', [
    { productId: catalogue.id, quantity: 1 },
  ]);
  assert.equal(computed.items[0].originalUnitPrice.toString(), '120');
});

test('direct preview calculation preserves explicit classification and defaults legacy products', async () => {
  for (const kind of [FiscalItemKind.GOOD, FiscalItemKind.SERVICE, null]) {
    const catalogue = product(kind);
    const pos = new PosService(
      { product: { findMany: async () => [catalogue] } } as never,
      {} as never,
      {} as never,
    );
    const computed = await pos['computeSale']('tenant-rivnu', [
      { productId: catalogue.id, quantity: 1 },
    ]);
    assert.equal(computed.items[0].originalUnitPrice?.toString(), '100');
    assert.equal(computed.items[0].fiscalItemKind, kind ?? FiscalItemKind.GOOD);
  }
});

test('checkout copies persisted order evidence even when catalogue price and classification changed', async () => {
  const pos = new PosService({} as never, {} as never, {} as never);
  const line = {
    productId: 'product-1',
    sku: null,
    barcode: null,
    description: 'Original description',
    quantity: decimal('2'),
    unit: ProductUnit.UNIT,
    reservedQuantity: 0,
    unitPrice: decimal('95'),
    originalUnitPrice: decimal('100'),
    fiscalItemKind: FiscalItemKind.GOOD,
    discountTotal: decimal('10'),
    taxCategory: TaxCategory.ITBIS_18,
    taxRate: decimal('0.18'),
    taxTotal: decimal('34.20'),
    subtotal: decimal('190'),
    total: decimal('224.20'),
    product: { ...product(FiscalItemKind.SERVICE), salePrice: decimal('999') },
  };
  const computed = await pos['computeSaleFromOrder']({ items: [line] } as never);
  assert.equal(computed.items[0].originalUnitPrice?.toString(), '100');
  assert.equal(computed.items[0].fiscalItemKind, FiscalItemKind.GOOD);
  assert.equal(computed.total.toString(), '224.2');
  const historical = await pos['computeSaleFromOrder']({
    items: [{ ...line, originalUnitPrice: null, fiscalItemKind: null }],
  } as never);
  assert.equal(historical.items[0].originalUnitPrice, null);
  assert.equal(historical.items[0].fiscalItemKind, FiscalItemKind.GOOD);
});

test('product DTO accepts only explicit supported classification or null, never arbitrary inferred values', () => {
  for (const value of ['GOOD', 'SERVICE', null, undefined, 'UNKNOWN', 'good', 1, true]) {
    const dto = plainToInstance(CreateProductDto, {
      name: 'Test',
      price: 100,
      stock: 0,
      minStock: 0,
      fiscalItemKind: value,
    });
    const errors = validateSync(dto);
    assert.equal(
      errors.some((error) => error.property === 'fiscalItemKind'),
      !['GOOD', 'SERVICE', null, undefined].includes(value as never),
    );
  }
});

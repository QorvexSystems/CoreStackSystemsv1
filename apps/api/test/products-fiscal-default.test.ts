import assert from 'node:assert/strict';
import test from 'node:test';
import { FiscalItemKind, Prisma, ProductStatus, ProductUnit, TaxCategory } from '@qorvex/database';
import { ProductsService } from '../src/modules/products/products.service';

const tenantId = 'tenant-rivnu';
const userId = 'admin-rivnu';

test('new products persist an automatic fiscal classification', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    product: {
      findFirst: async () => null,
    },
    $transaction: async <T>(operation: (client: unknown) => Promise<T>) =>
      operation({
        product: {
          create: async (args: { data: Record<string, unknown> }) => {
            writes.push(args.data);
            return { id: 'product-1', ...args.data };
          },
        },
        inventoryMovement: { create: async () => ({ id: 'movement-1' }) },
        employeeActivityLog: { create: async () => ({ id: 'activity-1' }) },
      }),
  };
  const audit = { log: async () => undefined };
  const service = new ProductsService(prisma as never, audit as never, {} as never);

  await service.create(tenantId, userId, {
    name: 'Instalación',
    sku: 'SERV-1',
    barcode: 'SERV0001',
    unit: ProductUnit.SERVICE,
    price: 100,
    stock: 0,
    minStock: 0,
    trackInventory: false,
  });

  assert.equal(writes[0].fiscalItemKind, FiscalItemKind.SERVICE);
});

test('editing any legacy product fills the missing classification without overriding an explicit one', async () => {
  const updates: Array<Record<string, unknown>> = [];
  let currentFiscalKind: FiscalItemKind | null = null;
  const currentProduct = () => ({
    id: 'product-1',
    tenantId,
    name: 'Producto legado',
    sku: 'LEGACY-1',
    barcode: 'LEGACY0001',
    unit: ProductUnit.UNIT,
    price: new Prisma.Decimal(100),
    salePrice: new Prisma.Decimal(100),
    cost: null,
    taxCategory: TaxCategory.ITBIS_18,
    taxRate: new Prisma.Decimal('0.18'),
    fiscalItemKind: currentFiscalKind,
    trackInventory: false,
    stock: 0,
    reservedStock: 0,
    minStock: 0,
    status: ProductStatus.ACTIVE,
  });
  const prisma = {
    product: {
      findFirst: async () => currentProduct(),
    },
    $transaction: async <T>(operation: (client: unknown) => Promise<T>) =>
      operation({
        product: {
          update: async (args: { data: Record<string, unknown> }) => {
            updates.push(args.data);
            return { ...currentProduct(), ...args.data };
          },
        },
        inventoryMovement: { create: async () => ({ id: 'movement-1' }) },
        employeeActivityLog: { create: async () => ({ id: 'activity-1' }) },
      }),
  };
  const audit = { log: async () => undefined };
  const service = new ProductsService(prisma as never, audit as never, {} as never);

  await service.update(tenantId, userId, 'product-1', { unit: ProductUnit.SERVICE });
  assert.equal(updates[0].fiscalItemKind, FiscalItemKind.SERVICE);

  currentFiscalKind = FiscalItemKind.GOOD;
  await service.update(tenantId, userId, 'product-1', { unit: ProductUnit.SERVICE });
  assert.equal(updates[1].fiscalItemKind, FiscalItemKind.GOOD);
});

test('product deletion remains a soft deactivation so frozen sales evidence is retained', async () => {
  const statusWrites: ProductStatus[] = [];
  const product = {
    id: 'product-1',
    tenantId,
    name: 'Producto desactivado',
    sku: 'OLD-1',
    status: ProductStatus.ACTIVE,
  };
  const prisma = {
    product: {
      findFirst: async () => product,
      update: async (args: { data: { status: ProductStatus } }) => {
        statusWrites.push(args.data.status);
        return { ...product, ...args.data };
      },
    },
    employeeActivityLog: { create: async () => ({ id: 'activity-1' }) },
  };
  const audit = { log: async () => undefined };
  const service = new ProductsService(prisma as never, audit as never, {} as never);

  await service.remove(tenantId, userId, product.id);

  assert.deepEqual(statusWrites, [ProductStatus.INACTIVE]);
});

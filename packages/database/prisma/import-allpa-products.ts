import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  BarcodeType,
  ImportRowStatus,
  ImportStatus,
  ImportType,
  InventoryMovementType,
  Prisma,
  PrismaClient,
  ProductInventoryDestination,
  ProductStatus,
  ProductUnit,
  TaxCategory,
} from '../generated/client';

const prisma = new PrismaClient();

const TENANT_SLUG = 'allpa';
const EXPECTED_PRODUCT_COUNT = 724;
const SOURCE_COLUMNS = 6;
const execute = process.argv.includes('--execute');
const sourceArgument = getArgumentValue('--source');
const confirmation = getArgumentValue('--confirm');
const expectedSourceHash = getArgumentValue('--source-sha256')?.toUpperCase();

type SourceProduct = {
  rowNumber: number;
  sku: string;
  name: string;
  cost: number;
  price: number;
  stock: number;
  minStock: number;
};

function getArgumentValue(name: string) {
  const inlineArgument = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inlineArgument) return inlineArgument.slice(name.length + 1);

  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printUsage() {
  console.log('Uso:');
  console.log(
    '  corepack pnpm --filter @qorvex/database import:allpa-products -- --source=<products.psv>',
  );
  console.log('');
  console.log('Aplicar luego de revisar el dry-run:');
  console.log(
    '  corepack pnpm --filter @qorvex/database import:allpa-products -- --source=<products.psv> --source-sha256=<sha256> --confirm=allpa --execute',
  );
}

function parseNonNegativeNumber(value: string, field: string, rowNumber: number) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Fila ${rowNumber}: ${field} no es numerico (${JSON.stringify(value)}).`);
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Fila ${rowNumber}: ${field} debe ser un numero mayor o igual a cero.`);
  }

  return number;
}

function parseSource(buffer: Buffer): SourceProduct[] {
  // Firebird ODS 10.1 stores these legacy strings with a Windows-1252-compatible encoding.
  const contents = new TextDecoder('windows-1252', { fatal: true }).decode(buffer);
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const rowNumber = index + 1;
    const columns = line.split('|').map((column) => column.trim());
    if (columns.length !== SOURCE_COLUMNS) {
      throw new Error(
        `Fila ${rowNumber}: se esperaban ${SOURCE_COLUMNS} columnas y llegaron ${columns.length}.`,
      );
    }

    const [rawSku, rawName, rawCost, rawPrice, rawStock, rawMinStock] = columns;
    const sku = rawSku.toUpperCase();
    const name = rawName.replace(/\s+/g, ' ').trim();
    const cost = parseNonNegativeNumber(rawCost, 'costo', rowNumber);
    const price = parseNonNegativeNumber(rawPrice, 'precio', rowNumber);
    const stock = parseNonNegativeNumber(rawStock, 'stock', rowNumber);
    const minStock = parseNonNegativeNumber(rawMinStock, 'stock minimo', rowNumber);

    if (!sku) throw new Error(`Fila ${rowNumber}: el codigo/SKU es obligatorio.`);
    if (!name) throw new Error(`Fila ${rowNumber}: el nombre es obligatorio.`);
    if (sku.length > 64) throw new Error(`Fila ${rowNumber}: el SKU supera 64 caracteres.`);
    if (price <= 0) throw new Error(`Fila ${rowNumber}: el precio debe ser mayor que cero.`);
    if (!Number.isInteger(stock) || !Number.isInteger(minStock)) {
      throw new Error(`Fila ${rowNumber}: UNIT requiere existencias enteras.`);
    }
    if (/\p{Cc}|\uFFFD/u.test(sku) || /\p{Cc}|\uFFFD/u.test(name)) {
      throw new Error(`Fila ${rowNumber}: contiene caracteres de control o codificacion invalida.`);
    }

    return { rowNumber, sku, name, cost, price, stock, minStock };
  });
}

function validateProducts(products: SourceProduct[]) {
  if (products.length !== EXPECTED_PRODUCT_COUNT) {
    throw new Error(
      `Se esperaban ${EXPECTED_PRODUCT_COUNT} productos y se encontraron ${products.length}.`,
    );
  }

  const skuCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const product of products) {
    skuCounts.set(product.sku, (skuCounts.get(product.sku) ?? 0) + 1);
    const normalizedName = product.name.toLocaleUpperCase('es');
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1);
  }

  const duplicateSkus = [...skuCounts].filter(([, count]) => count > 1);
  if (duplicateSkus.length) {
    throw new Error(`Hay SKU duplicados: ${duplicateSkus.map(([sku]) => sku).join(', ')}.`);
  }

  return {
    duplicateNames: [...nameCounts].filter(([, count]) => count > 1).length,
    zeroCosts: products.filter((product) => product.cost === 0).length,
    belowCost: products.filter((product) => product.cost > product.price).length,
    zeroStock: products.filter((product) => product.stock === 0).length,
    positiveStock: products.filter((product) => product.stock > 0).length,
    totalStock: products.reduce((total, product) => total + product.stock, 0),
    totalCost: products.reduce((total, product) => total + product.cost, 0),
    totalPrice: products.reduce((total, product) => total + product.price, 0),
  };
}

function marginFor(product: SourceProduct) {
  return new Prisma.Decimal(product.price).sub(product.cost).div(product.price).toDecimalPlaces(4);
}

async function inspectExistingCatalog(tenantId: string) {
  const products = await prisma.product.findMany({
    where: { tenantId },
    select: {
      id: true,
      _count: {
        select: {
          inventoryMovements: true,
          warehouseStocks: true,
          warehouseMovements: true,
          supplierProducts: true,
          purchaseOrderItems: true,
          supplierInvoiceItems: true,
          goodsReceiptItems: true,
        },
      },
    },
  });

  const relations = products.reduce<Record<string, number>>((totals, product) => {
    for (const [name, count] of Object.entries(product._count)) {
      totals[name] = (totals[name] ?? 0) + count;
    }
    return totals;
  }, {});

  return { count: products.length, relations };
}

async function migrateProducts(
  tenantId: string,
  actorId: string | undefined,
  products: SourceProduct[],
  sourceFilename: string,
  sourceHash: string,
) {
  await prisma.$transaction(
    async (tx) => {
      const importBatch = await tx.importBatch.create({
        data: {
          tenantId,
          type: ImportType.PRODUCTS,
          filename: sourceFilename,
          status: ImportStatus.VALIDATING,
          totalRows: products.length,
          validRows: products.length,
          createdById: actorId,
        },
      });

      // Historical invoice/order lines retain their snapshots; their nullable productId becomes null.
      // Inventory rows tied to the demo catalog cascade with the products.
      await tx.product.deleteMany({ where: { tenantId } });

      const createdProducts = await tx.product.createManyAndReturn({
        data: products.map((product) => ({
          tenantId,
          name: product.name,
          sku: product.sku,
          barcode: product.sku,
          barcodeType: BarcodeType.CODE128,
          generatedBarcode: false,
          unit: ProductUnit.UNIT,
          price: new Prisma.Decimal(product.price),
          salePrice: new Prisma.Decimal(product.price),
          cost: new Prisma.Decimal(product.cost),
          margin: marginFor(product),
          taxCategory: TaxCategory.EXEMPT,
          taxRate: new Prisma.Decimal(0),
          trackInventory: true,
          inventoryDestination: ProductInventoryDestination.SALES_INVENTORY,
          stock: product.stock,
          reservedStock: 0,
          minStock: product.minStock,
          status: ProductStatus.ACTIVE,
        })),
        select: { id: true, sku: true, name: true, stock: true, cost: true },
      });

      const createdBySku = new Map(createdProducts.map((product) => [product.sku, product]));
      const stockMovements = createdProducts
        .filter((product) => product.stock > 0)
        .map((product) => ({
          tenantId,
          productId: product.id,
          type: InventoryMovementType.INITIAL_STOCK,
          quantity: product.stock,
          previousStock: 0,
          newStock: product.stock,
          unitCost: product.cost,
          reason: 'Migracion inicial desde AbarrotesPDV',
          reference: `ALLPA-LEGACY-${sourceHash.slice(0, 12)}`,
          createdById: actorId,
        }));
      if (stockMovements.length) await tx.inventoryMovement.createMany({ data: stockMovements });

      await tx.importBatchRow.createMany({
        data: products.map((product) => {
          const created = createdBySku.get(product.sku);
          if (!created) throw new Error(`No se encontro el producto creado para ${product.sku}.`);
          return {
            importBatchId: importBatch.id,
            rowNumber: product.rowNumber,
            status: ImportRowStatus.IMPORTED,
            productId: created.id,
            productLabel: `${created.name} (${product.sku})`,
            rawData: {
              codigo: product.sku,
              descripcion: product.name,
              costo: product.cost,
              precio: product.price,
              stock: product.stock,
              stockMinimo: product.minStock,
            },
          };
        }),
      });

      await tx.importBatch.update({
        where: { id: importBatch.id },
        data: {
          status: ImportStatus.IMPORTED,
          importedRows: products.length,
          confirmedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'ALLPA_LEGACY_PRODUCTS_IMPORTED',
          entity: 'ImportBatch',
          entityId: importBatch.id,
          metadata: {
            source: 'AbarrotesPDV/PDVDATA.FDB',
            sourceFilename,
            sourceSha256: sourceHash,
            importedProducts: products.length,
            omittedLegacyFields: ['DEPT', 'PROVID', 'UMEDIDA', 'MAYOREO', 'IMPUESTOS'],
          },
        },
      });
    },
    { maxWait: 20_000, timeout: 180_000 },
  );
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  if (!sourceArgument) throw new Error('Falta --source=<products.psv>.');

  const sourcePath = resolve(sourceArgument);
  const sourceBuffer = readFileSync(sourcePath);
  const sourceHash = createHash('sha256').update(sourceBuffer).digest('hex').toUpperCase();
  const products = parseSource(sourceBuffer);
  const validation = validateProducts(products);

  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
    select: { id: true, name: true, slug: true },
  });
  if (!tenant) throw new Error(`No existe el tenant ${TENANT_SLUG}.`);

  const membership = await prisma.membership.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  const existing = await inspectExistingCatalog(tenant.id);

  console.log(`Migracion de productos para ${tenant.name} (${tenant.slug})`);
  console.log(`Modo: ${execute ? 'EJECUTAR' : 'DRY-RUN'}`);
  console.log(`Fuente: ${sourcePath}`);
  console.log(`SHA-256 fuente: ${sourceHash}`);
  console.log(`Productos validados: ${products.length}`);
  console.log(`Productos existentes que seran reemplazados: ${existing.count}`);
  console.log(`Relaciones actuales del catalogo: ${JSON.stringify(existing.relations)}`);
  console.log(`Stock total: ${validation.totalStock}`);
  console.log(`Productos con stock positivo: ${validation.positiveStock}`);
  console.log(`Productos con stock cero: ${validation.zeroStock}`);
  console.log(`Costos en cero preservados: ${validation.zeroCosts}`);
  console.log(`Costos mayores al precio preservados: ${validation.belowCost}`);
  console.log(`Descripciones duplicadas permitidas: ${validation.duplicateNames}`);
  console.log(`Suma de costos unitarios: ${validation.totalCost.toFixed(2)}`);
  console.log(`Suma de precios unitarios: ${validation.totalPrice.toFixed(2)}`);
  console.log(
    'Transformacion: sin categorias, UNIT, impuesto EXEMPT, SKU y barcode iguales al codigo legado.',
  );

  if (!execute) {
    console.log('Dry-run completado. PostgreSQL no fue modificado.');
    printUsage();
    return;
  }

  if (confirmation !== TENANT_SLUG) {
    throw new Error(`Confirmacion invalida. Usa --confirm=${TENANT_SLUG}.`);
  }
  if (!expectedSourceHash || expectedSourceHash !== sourceHash) {
    throw new Error('El --source-sha256 no coincide con el archivo validado.');
  }

  await migrateProducts(tenant.id, membership?.userId, products, basename(sourcePath), sourceHash);

  const [productCount, stock, importBatch] = await Promise.all([
    prisma.product.count({ where: { tenantId: tenant.id } }),
    prisma.product.aggregate({ where: { tenantId: tenant.id }, _sum: { stock: true } }),
    prisma.importBatch.findFirst({
      where: { tenantId: tenant.id, filename: basename(sourcePath) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, totalRows: true, importedRows: true, invalidRows: true },
    }),
  ]);

  if (productCount !== products.length || stock._sum.stock !== validation.totalStock) {
    throw new Error('La conciliacion posterior no coincide con la fuente.');
  }

  console.log('Migracion aplicada y conciliada correctamente.');
  console.log(JSON.stringify({ productCount, totalStock: stock._sum.stock, importBatch }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

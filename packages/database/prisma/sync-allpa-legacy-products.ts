import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
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
} from '../generated/client';

const prisma = new PrismaClient();
const TENANT_SLUG = 'allpa';
const ORIGINAL_SOURCE_SHA256 = '4A178ACD9B3A753532A6653BBF783D3FBED49BFD97A07B9608BE7BAA6B3E9095';
const ITBIS_MULTIPLIER = new Prisma.Decimal('1.18');

type SourceProduct = {
  rowNumber: number;
  sku: string;
  name: string;
  department: string;
  cost: Prisma.Decimal;
  netPrice: Prisma.Decimal;
  rawStock: number;
  stock: number;
  minStock: number;
};

function argument(name: string) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readProducts(path: string) {
  const buffer = readFileSync(path);
  const hash = createHash('sha256').update(buffer).digest('hex').toUpperCase();
  const contents = new TextDecoder('windows-1252', { fatal: true }).decode(buffer);
  const rows = contents.split(/\r?\n/).filter((line) => line.trim());
  const seen = new Set<string>();
  const products = rows.map((line, index): SourceProduct => {
    const columns = line.split('|').map((value) => value.trim());
    if (columns.length !== 7) throw new Error(`Fila ${index + 1}: se esperaban siete columnas.`);
    const [rawSku, name, department, rawCost, rawPrice, rawStock, rawMinStock] = columns;
    const sku = rawSku.toUpperCase();
    if (!sku || !name || !department || sku.length > 64 || seen.has(sku)) {
      throw new Error(`Fila ${index + 1}: SKU, nombre o departamento invalido o duplicado (${sku}).`);
    }
    if ([sku, name, department].some((value) => /\p{Cc}|\uFFFD/u.test(value))) {
      throw new Error(`Fila ${index + 1}: texto con caracteres de control.`);
    }
    if (![rawCost, rawPrice, rawStock, rawMinStock].every((value) => /^-?\d+(?:\.\d+)?$/.test(value))) {
      throw new Error(`Fila ${index + 1}: dato numerico invalido.`);
    }
    const cost = new Prisma.Decimal(rawCost).toDecimalPlaces(2);
    const netPrice = new Prisma.Decimal(rawPrice).toDecimalPlaces(2);
    const rawStockNumber = Number(rawStock);
    const minStock = Number(rawMinStock);
    if (cost.isNegative() || netPrice.lessThanOrEqualTo(0) || !Number.isSafeInteger(rawStockNumber) ||
        !Number.isSafeInteger(minStock) || minStock < 0) {
      throw new Error(`Fila ${index + 1}: costo, precio o existencia invalida (${sku}).`);
    }
    seen.add(sku);
    return {
      rowNumber: index + 1,
      sku,
      name: name.replace(/\s+/g, ' '),
      department: department.replace(/\s+/g, ' '),
      cost,
      netPrice,
      rawStock: rawStockNumber,
      stock: Math.max(0, rawStockNumber),
      minStock,
    };
  });
  return { hash, products };
}

function catalogPrice(product: SourceProduct) {
  // ALLPA now treats the price from Abarrotes as the final customer price.
  return product.netPrice;
}

function margin(product: SourceProduct) {
  const fiscalBase = catalogPrice(product).div(ITBIS_MULTIPLIER);
  return fiscalBase.sub(product.cost).div(fiscalBase).toDecimalPlaces(4);
}

async function getCatalog(tenantId: string) {
  const [products, categories] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId },
      select: {
        id: true, sku: true, barcode: true, name: true, categoryId: true, cost: true,
        price: true, salePrice: true, stock: true, reservedStock: true, minStock: true,
      },
    }),
    prisma.productCategory.findMany({
      where: { tenantId },
      select: { id: true, name: true },
    }),
  ]);
  return { products, categories };
}

async function main() {
  const sourcePath = argument('--source');
  const baselinePath = argument('--baseline');
  const expectedHash = argument('--source-sha256')?.toUpperCase();
  const backupMarker = argument('--backup-marker');
  const execute = process.argv.includes('--execute');
  if (!sourcePath || !baselinePath) throw new Error('Se requieren --source y --baseline.');

  const source = readProducts(resolve(sourcePath));
  const baseline = readProducts(resolve(baselinePath));
  if (baseline.hash !== ORIGINAL_SOURCE_SHA256) {
    throw new Error('La fuente original no coincide con el registro de la primera importacion.');
  }
  const baselineSkus = new Set(baseline.products.map((product) => product.sku));
  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
    select: { id: true, name: true },
  });
  if (!tenant) {
    throw new Error('No se encontró el tenant ALLPA.');
  }
  const catalog = await getCatalog(tenant.id);
  const bySku = new Map(catalog.products.filter((product) => product.sku).map((product) => [product.sku!.toUpperCase(), product]));
  const categoryByName = new Map(catalog.categories.map((category) => [category.name.toUpperCase(), category.id]));
  const sourceSkus = new Set(source.products.map((product) => product.sku));
  const newProducts = source.products.filter((product) => !bySku.has(product.sku));
  const matched = source.products.filter((product) => bySku.has(product.sku));
  const retained = catalog.products.filter((product) => !product.sku || !sourceSkus.has(product.sku.toUpperCase()));
  const collisions = matched.filter((product) => !baselineSkus.has(product.sku));
  const barcodeOwners = new Map(catalog.products.filter((product) => product.barcode).map((product) => [product.barcode!.toUpperCase(), product.sku?.toUpperCase()]));
  const barcodeCollisions = newProducts.filter((product) => barcodeOwners.has(product.sku));
  const updated = matched.filter((product) => {
    const current = bySku.get(product.sku)!;
    const targetCategory = categoryByName.get(product.department.toUpperCase());
    const grossPrice = catalogPrice(product);
    return current.name !== product.name || current.categoryId !== targetCategory ||
      current.cost?.toDecimalPlaces(2).toString() !== product.cost.toString() ||
      !current.price.equals(grossPrice) || !current.salePrice.equals(grossPrice) ||
      current.stock !== product.stock || current.minStock !== product.minStock;
  });
  const stockChanges = matched.filter((product) => bySku.get(product.sku)!.stock !== product.stock);
  const negativeStock = source.products.filter((product) => product.rawStock < 0);
  const newDepartments = [...new Set(source.products.map((product) => product.department))]
    .filter((name) => !categoryByName.has(name.toUpperCase()));
  const report = {
    source: basename(sourcePath), sourceSha256: source.hash,
    baselineSha256: baseline.hash,
    sourceProducts: source.products.length,
    matchedProducts: matched.length,
    updatedProducts: updated.length,
    unchangedProducts: matched.length - updated.length,
    createdProducts: newProducts.length,
    retainedProducts: retained.length,
    changedStockProducts: stockChanges.length,
    totalSourceStockAfterCorrection: source.products.reduce((total, product) => total + product.stock, 0),
    negativeStockCorrections: negativeStock.map((product) => ({ sku: product.sku, sourceStock: product.rawStock, importedStock: product.stock })),
    newDepartments,
    newProductSkus: newProducts.map((product) => product.sku),
    retainedProductSkus: retained.map((product) => product.sku),
    nameChanges: matched.filter((product) => bySku.get(product.sku)!.name !== product.name).map((product) => product.sku),
    priceChanges: matched.filter((product) => !bySku.get(product.sku)!.price.equals(catalogPrice(product))).map((product) => product.sku),
    costChanges: matched.filter((product) => bySku.get(product.sku)!.cost?.toDecimalPlaces(2).toString() !== product.cost.toString()).map((product) => product.sku),
  };

  console.log(JSON.stringify({ mode: execute ? 'EXECUTE' : 'DRY-RUN', ...report }, null, 2));
  const reportPath = argument('--report');
  if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  if (collisions.length || barcodeCollisions.length) {
    throw new Error(`Colisiones con productos creados en ALLPA: ${[...collisions, ...barcodeCollisions].map((product) => product.sku).join(', ')}`);
  }
  if (!execute) return;
  if (argument('--confirm') !== TENANT_SLUG || expectedHash !== source.hash || !backupMarker) {
    throw new Error('Ejecucion requiere --confirm=allpa, --source-sha256 exacto y --backup-marker.');
  }

  const actor = await prisma.membership.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  const reference = `ALLPA-LEGACY-SYNC-${source.hash.slice(0, 16)}`;
  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({
      data: {
        tenantId: tenant.id, type: ImportType.PRODUCTS, filename: basename(sourcePath),
        status: ImportStatus.VALIDATING, totalRows: source.products.length,
        validRows: source.products.length, createdById: actor?.userId,
      },
    });
    const finalCategories = new Map(categoryByName);
    for (const name of newDepartments) {
      const created = await tx.productCategory.create({
        data: { tenantId: tenant.id, name, status: ProductStatus.ACTIVE },
        select: { id: true },
      });
      finalCategories.set(name.toUpperCase(), created.id);
    }

    const createdIds = new Map<string, string>();
    for (const product of newProducts) {
      const grossPrice = catalogPrice(product);
      const created = await tx.product.create({
        data: {
          tenantId: tenant.id, categoryId: finalCategories.get(product.department.toUpperCase()),
          name: product.name, sku: product.sku, barcode: product.sku,
          barcodeType: BarcodeType.CODE128, generatedBarcode: false,
          unit: ProductUnit.UNIT, price: grossPrice, salePrice: grossPrice,
          cost: product.cost, margin: margin(product),
          trackInventory: true,
          inventoryDestination: ProductInventoryDestination.SALES_INVENTORY,
          stock: product.stock, reservedStock: 0, minStock: product.minStock,
          status: ProductStatus.ACTIVE,
        },
        select: { id: true },
      });
      createdIds.set(product.sku, created.id);
    }
    for (const product of updated) {
      const grossPrice = catalogPrice(product);
      await tx.product.update({
        where: { id: bySku.get(product.sku)!.id },
        data: {
          name: product.name,
          categoryId: finalCategories.get(product.department.toUpperCase()),
          price: grossPrice, salePrice: grossPrice, cost: product.cost,
          margin: margin(product), stock: product.stock, minStock: product.minStock,
        },
      });
    }

    const movementRows = [
      ...stockChanges.map((product) => {
        const before = bySku.get(product.sku)!;
        return {
          tenantId: tenant.id, productId: before.id,
          type: product.stock > before.stock ? InventoryMovementType.ADJUSTMENT_IN : InventoryMovementType.ADJUSTMENT_OUT,
          quantity: Math.abs(product.stock - before.stock),
          previousStock: before.stock, newStock: product.stock,
          unitCost: product.cost, reason: 'Sincronizacion de inventario desde AbarrotesPDV',
          reference, createdById: actor?.userId,
        };
      }),
      ...newProducts.filter((product) => product.stock > 0).map((product) => ({
        tenantId: tenant.id, productId: createdIds.get(product.sku)!,
        type: InventoryMovementType.INITIAL_STOCK,
        quantity: product.stock, previousStock: 0, newStock: product.stock,
        unitCost: product.cost, reason: 'Inventario inicial desde AbarrotesPDV',
        reference, createdById: actor?.userId,
      })),
    ];
    if (movementRows.length) await tx.inventoryMovement.createMany({ data: movementRows });
    await tx.importBatchRow.createMany({
      data: source.products.map((product) => ({
        importBatchId: batch.id, rowNumber: product.rowNumber,
        status: ImportRowStatus.IMPORTED,
        productId: bySku.get(product.sku)?.id ?? createdIds.get(product.sku)!,
        productLabel: `${product.name} (${product.sku})`,
        rawData: {
          sku: product.sku, name: product.name, department: product.department,
          cost: product.cost.toString(), netPrice: product.netPrice.toString(),
          priceWithItbis: catalogPrice(product).toString(), sourceStock: product.rawStock,
          importedStock: product.stock, minStock: product.minStock,
          action: bySku.has(product.sku) ? 'UPDATE_OR_KEEP' : 'CREATE',
        },
      })),
    });
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: ImportStatus.IMPORTED, importedRows: source.products.length, confirmedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id, userId: actor?.userId,
        action: 'ALLPA_LEGACY_PRODUCTS_SYNCED', entity: 'ImportBatch', entityId: batch.id,
        metadata: { ...report, backupMarker, reference },
      },
    });

    const actual = await tx.product.findMany({
      where: { tenantId: tenant.id, sku: { in: [...sourceSkus] } },
      select: { sku: true, name: true, categoryId: true, price: true, salePrice: true, cost: true, stock: true, minStock: true },
    });
    const actualBySku = new Map(actual.map((product) => [product.sku, product]));
    for (const product of source.products) {
      const row = actualBySku.get(product.sku);
      const grossPrice = catalogPrice(product);
      if (!row || row.name !== product.name || row.categoryId !== finalCategories.get(product.department.toUpperCase()) ||
          !row.price.equals(grossPrice) || !row.salePrice.equals(grossPrice) ||
          !row.cost?.equals(product.cost) || row.stock !== product.stock || row.minStock !== product.minStock) {
        throw new Error(`Conciliacion fallida para ${product.sku}.`);
      }
    }
    const finalCount = await tx.product.count({ where: { tenantId: tenant.id } });
    if (finalCount !== catalog.products.length + newProducts.length) {
      throw new Error('El total de productos no coincide con la conciliacion prevista.');
    }
    return { batchId: batch.id, finalCount, movementCount: movementRows.length };
  }, { maxWait: 20_000, timeout: 600_000 });
  console.log(JSON.stringify({ success: true, ...result, sourceSha256: source.hash }, null, 2));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());

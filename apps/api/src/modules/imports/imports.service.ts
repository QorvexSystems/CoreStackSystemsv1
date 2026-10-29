import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DeliveryMethod,
  DispatchLocation,
  DocumentType,
  ImportRowStatus,
  ImportStatus,
  ImportType,
  OrderPriority,
  OrderSource,
  ProductionStage,
  Prisma,
  ProductInventoryDestination,
  ProductStatus,
  ProductKind,
  ProductUnit,
  SalesOrderDestination,
  TaxCategory,
} from '@qorvex/database';
import { readSheet, type CellValue } from 'read-excel-file/node';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import { ProductsService } from '../products/products.service';
import { CustomersService } from '../customers/customers.service';
import { OrdersService } from '../orders/orders.service';

type UploadedImportFile = {
  originalname: string;
  buffer: Buffer;
  size: number;
};

type RawImportRow = Record<string, unknown>;

type PreparedProductImportRow = {
  rowNumber: number;
  rawData: Prisma.InputJsonObject;
  categoryName?: string;
  payload: {
    name: string;
    sku?: string;
    barcode?: string;
    imageUrl?: string;
    brand?: string;
    kind?: ProductKind;
    material?: string;
    measurement?: string;
    unit?: ProductUnit;
    price: number;
    cost?: number;
    taxCategory?: TaxCategory;
    taxRate?: number;
    stock: number;
    minStock?: number;
    status?: ProductStatus;
    trackInventory?: boolean;
  };
};

type ImportRowErrorInput = {
  rowNumber: number;
  field?: string;
  message: string;
  rawData: Prisma.InputJsonObject;
};

type ImportedProductReference = {
  id: string;
  label: string;
};

type ImportBatchRowInput = {
  rowNumber: number;
  status: ImportRowStatus;
  productId?: string;
  productLabel?: string;
  rawData: Prisma.InputJsonObject;
  reasons?: Prisma.InputJsonArray;
};

type ImportRowsQuery = {
  status?: string;
  page?: string | number;
  limit?: string | number;
};

const maxImportRows = 500;
const importPersistenceChunkSize = 100;

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly customersService: CustomersService,
    private readonly ordersService: OrdersService,
  ) {}

  async findAll(tenantId: string) {
    const batches = await this.prisma.importBatch.findMany({
      where: { tenantId },
      select: {
        id: true,
        type: true,
        filename: true,
        status: true,
        totalRows: true,
        validRows: true,
        invalidRows: true,
        importedRows: true,
        createdAt: true,
        confirmedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
        _count: { select: { rows: true, errors: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return batches.map((batch) => ({
      ...batch,
      errorCount: batch._count.errors,
      detailedRowCount: batch._count.rows,
    }));
  }

  async findRows(tenantId: string, id: string, query: ImportRowsQuery) {
    const status = parseImportRowStatus(query.status);
    const { page, limit } = parsePagination(query.page, query.limit);
    const batch = await this.prisma.importBatch.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        type: true,
        filename: true,
        status: true,
        totalRows: true,
        validRows: true,
        invalidRows: true,
        importedRows: true,
        createdAt: true,
        confirmedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
        _count: { select: { rows: true, errors: true } },
      },
    });

    if (!batch) {
      throw new NotFoundException('No se encontro el lote de importacion.');
    }

    if (batch._count.rows > 0) {
      const where = {
        importBatchId: batch.id,
        ...(status ? { status } : {}),
      };
      const [total, rows] = await this.prisma.$transaction([
        this.prisma.importBatchRow.count({ where }),
        this.prisma.importBatchRow.findMany({
          where,
          include: {
            product: {
              select: { id: true, name: true, sku: true, barcode: true, status: true },
            },
          },
          orderBy: { rowNumber: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      return {
        batch: {
          ...batch,
          errorCount: batch._count.errors,
          detailedRowCount: batch._count.rows,
          hasDetailedRows: true,
          hasLegacyErrorRows: false,
        },
        rows: rows.map((row) => ({
          ...row,
          reasons: normalizeRowReasons(row.reasons),
        })),
        pagination: createPagination(page, limit, total),
      };
    }

    // Los lotes creados antes de ImportBatchRow solo contienen ImportRowError.
    // Conservamos esos errores en el detalle sin inventar registros exitosos que
    // nunca se almacenaron en la version anterior.
    const legacyResult =
      status === ImportRowStatus.IMPORTED
        ? { rows: [], total: 0 }
        : await this.getLegacyErrorRows(batch.id, page, limit);

    return {
      batch: {
        ...batch,
        errorCount: batch._count.errors,
        detailedRowCount: batch._count.rows,
        hasDetailedRows: false,
        hasLegacyErrorRows: legacyResult.total > 0,
      },
      rows: legacyResult.rows,
      pagination: createPagination(page, limit, legacyResult.total),
    };
  }

  async importProducts(tenantId: string, userId: string, file?: UploadedImportFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Import file is required.');
    }

    const rows = await readWorkbookRows(file);

    if (rows.length > maxImportRows) {
      throw new BadRequestException(
        `El archivo supera el limite de ${maxImportRows} filas por importacion.`,
      );
    }

    // El lote se registra antes de tocar productos. Asi, incluso si una fila o
    // un proceso posterior falla, queda una referencia trazable de la
    // importacion que la origino.
    const batch = await this.prisma.importBatch.create({
      data: {
        tenantId,
        type: ImportType.PRODUCTS,
        filename: file.originalname || 'productos.xlsx',
        status: ImportStatus.VALIDATING,
        totalRows: rows.length,
        createdById: userId,
      },
      select: { id: true },
    });

    try {
      return await this.processProductRows(batch.id, tenantId, userId, rows);
    } catch (error) {
      await this.markBatchAsFailed(batch.id, rows.length);
      throw error;
    }
  }

  async importCustomers(tenantId: string, userId: string, file?: UploadedImportFile) {
    if (!file?.buffer?.length) throw new BadRequestException('Import file is required.');
    const rows = await readWorkbookRows(file);
    if (rows.length > maxImportRows) {
      throw new BadRequestException(`El archivo supera el limite de ${maxImportRows} filas.`);
    }
    const batch = await this.prisma.importBatch.create({
      data: {
        tenantId,
        type: ImportType.CUSTOMERS,
        filename: file.originalname || 'clientes.xlsx',
        status: ImportStatus.VALIDATING,
        totalRows: rows.length,
        createdById: userId,
      },
      select: { id: true },
    });
    const rowErrors: ImportRowErrorInput[] = [];
    const imported = new Map<number, string>();
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      const normalized = normalizeRow(row);
      const rawData = toJsonObject(row);
      const name = getText(normalized, ['nombre', 'cliente', 'name', 'customer']);
      if (!name) {
        rowErrors.push({
          rowNumber,
          field: 'nombre',
          message: 'El nombre del cliente es requerido.',
          rawData,
        });
        continue;
      }
      try {
        const customer = await this.customersService.create(tenantId, userId, {
          name,
          documentType: parseCustomerDocumentType(
            getText(normalized, ['tipo documento', 'document type', 'tipo']),
          ),
          documentNumber: getText(normalized, [
            'documento',
            'rnc',
            'cedula',
            'cédula',
            'document number',
          ]),
          email: getText(normalized, ['correo', 'email']),
          phone: getText(normalized, ['telefono', 'teléfono', 'phone']),
          address: getText(normalized, ['direccion', 'dirección', 'address']),
        });
        imported.set(rowNumber, customer.name);
      } catch (error) {
        rowErrors.push({ rowNumber, message: getImportErrorMessage(error), rawData });
      }
    }
    const errorsByRow = groupImportErrorsByRow(rowErrors);
    const importRows: ImportBatchRowInput[] = rows.map((row, index) => {
      const rowNumber = index + 2;
      const errors = errorsByRow.get(rowNumber) ?? [];
      return {
        rowNumber,
        status: errors.length ? ImportRowStatus.FAILED : ImportRowStatus.IMPORTED,
        productLabel: imported.get(rowNumber),
        rawData: toJsonObject(row),
        reasons: errors.length ? toImportRowReasons(errors) : undefined,
      };
    });
    const invalidRows = importRows.filter((row) => row.status === ImportRowStatus.FAILED).length;
    return this.persistImportResults({
      batchId: batch.id,
      totalRows: rows.length,
      validRows: rows.length - invalidRows,
      invalidRows,
      importedRows: rows.length - invalidRows,
      importRows,
      rowErrors,
    });
  }

  private importStage(value?: string) {
    const stage = (value ?? 'WAITING').trim().toUpperCase();
    const aliases: Record<string, ProductionStage> = {
      'EN ESPERA': ProductionStage.WAITING,
      'EN FABRICA': ProductionStage.FACTORY,
      'EN FÁBRICA': ProductionStage.FACTORY,
      LISTA: ProductionStage.READY,
    };
    const parsed = aliases[stage] ?? stage;
    if (
      !(
        [
          ProductionStage.WAITING,
          ProductionStage.FACTORY,
          ProductionStage.READY,
        ] as ProductionStage[]
      ).includes(parsed as ProductionStage)
    )
      throw new BadRequestException('Etapa histórica: WAITING, FACTORY o READY.');
    return parsed as ProductionStage;
  }

  async importOpenOrders(tenantId: string, user: AuthenticatedUser, file?: UploadedImportFile) {
    if (!file?.buffer?.length) throw new BadRequestException('Import file is required.');
    const rows = await readWorkbookRows(file);
    if (rows.length > maxImportRows) {
      throw new BadRequestException(`El archivo supera el limite de ${maxImportRows} filas.`);
    }

    const batch = await this.prisma.importBatch.create({
      data: {
        tenantId,
        type: ImportType.OPEN_ORDERS,
        filename: file.originalname || 'ordenes-abiertas.xlsx',
        status: ImportStatus.VALIDATING,
        totalRows: rows.length,
        createdById: user.id,
      },
      select: { id: true },
    });
    const rowErrors: ImportRowErrorInput[] = [];
    const invalidOrderReferences = new Set<string>();
    const groups = new Map<
      string,
      Array<{
        rowNumber: number;
        rawData: Prisma.InputJsonObject;
        normalized: Map<string, unknown>;
        productId: string;
        quantity: number;
      }>
    >();

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      const normalized = normalizeRow(row);
      const rawData = toJsonObject(row);
      const orderReference = getText(normalized, [
        'numero orden',
        'número orden',
        'orden',
        'order number',
      ]);
      const sku = getText(normalized, ['sku', 'codigo producto', 'código producto']);
      const quantity = getQuantity(normalized, ['cantidad', 'quantity', 'unidades']);
      const promisedDate = getBusinessDate(normalized, [
        'fecha prometida',
        'fecha entrega',
        'promised date',
      ]);

      if (!orderReference) {
        rowErrors.push({
          rowNumber,
          field: 'numero orden',
          message: 'El número de orden original es requerido.',
          rawData,
        });
      }
      if (!sku) {
        rowErrors.push({ rowNumber, field: 'sku', message: 'El SKU es requerido.', rawData });
      }
      if (quantity === null || quantity <= 0) {
        rowErrors.push({
          rowNumber,
          field: 'cantidad',
          message: 'La cantidad debe ser mayor que cero.',
          rawData,
        });
      }
      if (!promisedDate) {
        rowErrors.push({
          rowNumber,
          field: 'fecha prometida',
          message: 'Usa una fecha prometida válida en formato AAAA-MM-DD.',
          rawData,
        });
      }
      if (!orderReference || !sku || quantity === null || quantity <= 0 || !promisedDate) {
        if (orderReference) invalidOrderReferences.add(orderReference);
        continue;
      }

      const product = await this.prisma.product.findFirst({
        where: { tenantId, sku, status: ProductStatus.ACTIVE },
        select: { id: true },
      });
      if (!product) {
        invalidOrderReferences.add(orderReference);
        rowErrors.push({
          rowNumber,
          field: 'sku',
          message: `No existe un producto activo con el SKU ${sku}.`,
          rawData,
        });
        continue;
      }

      const group = groups.get(orderReference) ?? [];
      group.push({ rowNumber, rawData, normalized, productId: product.id, quantity });
      groups.set(orderReference, group);
    }

    const importedLabels = new Map<number, string>();
    for (const [orderReference, group] of groups) {
      if (invalidOrderReferences.has(orderReference)) {
        for (const item of group) {
          rowErrors.push({
            rowNumber: item.rowNumber,
            message: `La orden ${orderReference} contiene otra línea inválida y no fue importada parcialmente.`,
            rawData: item.rawData,
          });
        }
        continue;
      }
      const first = group[0];
      const customerDocument = getText(first.normalized, [
        'documento cliente',
        'rnc',
        'cedula',
        'cédula',
      ]);
      const customerName = getText(first.normalized, ['cliente', 'nombre cliente', 'customer']);
      const customer = customerDocument
        ? await this.prisma.customer.findFirst({
            where: { tenantId, documentNumber: customerDocument },
          })
        : customerName
          ? await this.prisma.customer.findFirst({
              where: { tenantId, name: { equals: customerName, mode: 'insensitive' } },
            })
          : null;

      try {
        const headers = [
          ['cliente', 'nombre cliente', 'customer'],
          ['pagado', 'anticipo', 'paid amount'],
          ['inventario', 'origen inventario'],
          ['etapa', 'stage'],
          ['canal', 'origen'],
          ['fecha prometida', 'fecha entrega', 'promised date'],
        ];
        for (const fields of headers) {
          const values = new Set(
            group.map((item) => getText(item.normalized, fields)?.trim()).filter(Boolean),
          );
          if (values.size > 1)
            throw new BadRequestException('La orden tiene cabeceras inconsistentes: ' + fields[0]);
        }
        if (
          group.some((item) => {
            const price = getMoney(item.normalized, ['precio unitario', 'precio', 'unit price']);
            return price === null || price <= 0;
          })
        )
          throw new BadRequestException('Indica el precio unitario histórico de cada línea.');
        if (
          ['fabrica', 'fábrica', 'factory', 'warehouse'].includes(
            getText(first.normalized, ['inventario', 'origen inventario'])?.toLowerCase() ?? '',
          )
        ) {
          throw new BadRequestException(
            'El stock físico de Fábrica fue retirado. Usa Tienda como origen de existencias.',
          );
        }
        const created = await this.ordersService.create(
          tenantId,
          user,
          {
            destination: SalesOrderDestination.CASH_SALE,
            inventorySource: ProductInventoryDestination.SALES_INVENTORY,
            clientName: customerName,
            customerId: customer?.id,
            promisedDate: getBusinessDate(first.normalized, [
              'fecha prometida',
              'fecha entrega',
              'promised date',
            ]),
            priority: isTruthyImportValue(getText(first.normalized, ['urgente', 'urgent']))
              ? OrderPriority.URGENT
              : OrderPriority.NORMAL,
            isCorporate: isTruthyImportValue(
              getText(first.normalized, ['empresarial', 'corporativa', 'corporate']),
            ),
            deliveryMethod: parseDeliveryMethod(
              getText(first.normalized, ['entrega', 'metodo entrega', 'método entrega']),
            ),
            dispatchLocation: parseDispatchLocation(
              getText(first.normalized, ['despacho', 'lugar despacho']),
            ),
            deliveryAddress: getText(first.normalized, ['direccion', 'dirección']),
            deliveryPhone: getText(first.normalized, ['telefono', 'teléfono']),
            notificationEmail: getText(first.normalized, ['correo', 'email']),
            notes: [
              `Orden histórica importada: ${orderReference}.`,
              getText(first.normalized, ['notas', 'nota', 'notes']),
            ]
              .filter(Boolean)
              .join(' '),
            items: group.map((item) => {
              const personalization = {
                charms: getOptionalWholeNumber(item.normalized, ['dijes', 'charms']),
                children: getOptionalWholeNumber(item.normalized, ['ninos', 'niños', 'children']),
                material: getText(item.normalized, ['material']),
                instructions: getText(item.normalized, [
                  'personalizacion',
                  'personalización',
                  'instrucciones',
                ]),
              };
              return {
                productId: item.productId,
                quantity: item.quantity,
                unitPrice:
                  getMoney(item.normalized, ['precio unitario', 'precio', 'unit price']) ??
                  undefined,
                personalization: Object.values(personalization).some((value) => value !== undefined)
                  ? personalization
                  : undefined,
              };
            }),
          },
          {
            reference: orderReference,
            paidAmount: getMoney(first.normalized, ['pagado', 'anticipo', 'paid amount']) ?? 0,
            inventoryAlreadyDeducted: isTruthyImportValue(
              getText(first.normalized, ['inventario descontado', 'stock deducted']),
            ),
            stage: this.importStage(getText(first.normalized, ['etapa', 'stage'])),
            source:
              getText(first.normalized, ['canal', 'origen'])?.toLowerCase() === 'shopify'
                ? OrderSource.SHOPIFY
                : OrderSource.STORE,
            issuedAt: getBusinessDate(first.normalized, ['fecha factura', 'fecha original'])
              ? new Date(
                  getBusinessDate(first.normalized, ['fecha factura', 'fecha original'])! +
                    'T12:00:00-04:00',
                )
              : undefined,
            invoiceNumber: getText(first.normalized, ['factura original', 'numero factura']),
            designApproved: isTruthyImportValue(
              getText(first.normalized, ['diseno aprobado', 'diseño aprobado']),
            ),
            qualityApproved: isTruthyImportValue(getText(first.normalized, ['calidad aprobada'])),
          },
        );
        for (const item of group) importedLabels.set(item.rowNumber, created.orderNumber);
      } catch (error) {
        for (const item of group) {
          rowErrors.push({
            rowNumber: item.rowNumber,
            message: `Orden ${orderReference}: ${getImportErrorMessage(error)}`,
            rawData: item.rawData,
          });
        }
      }
    }

    const errorsByRow = groupImportErrorsByRow(rowErrors);
    const importRows: ImportBatchRowInput[] = rows.map((row, index) => {
      const rowNumber = index + 2;
      const errors = errorsByRow.get(rowNumber) ?? [];
      return {
        rowNumber,
        status: errors.length ? ImportRowStatus.FAILED : ImportRowStatus.IMPORTED,
        productLabel: importedLabels.get(rowNumber),
        rawData: toJsonObject(row),
        reasons: errors.length ? toImportRowReasons(errors) : undefined,
      };
    });
    const invalidRows = importRows.filter((row) => row.status === ImportRowStatus.FAILED).length;
    const importedRows = importRows.length - invalidRows;
    return this.persistImportResults({
      batchId: batch.id,
      totalRows: rows.length,
      validRows: importedRows,
      invalidRows,
      importedRows,
      importRows,
      rowErrors,
    });
  }

  private async processProductRows(
    batchId: string,
    tenantId: string,
    userId: string,
    rows: RawImportRow[],
  ) {
    const preparedRows: PreparedProductImportRow[] = [];
    const rowErrors: ImportRowErrorInput[] = [];

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      const normalized = normalizeRow(row);
      const rawData = toJsonObject(row);
      const errorsBeforeRow = rowErrors.length;
      const name = getText(normalized, ['nombre', 'producto', 'name', 'product']);
      const price = getMoney(normalized, ['precio', 'precio venta', 'sale price', 'price']);
      const stock = getQuantity(normalized, ['stock', 'existencia', 'inventario', 'cantidad']);
      const cost = getOptionalMoney(normalized, ['costo', 'cost']);
      const minStock = getOptionalQuantity(normalized, ['stock minimo', 'min stock', 'minimo']);
      const taxRate = getOptionalTaxRate(normalized, ['itbis', 'tax', 'tax rate', 'impuesto']);

      if (!name) {
        rowErrors.push({
          rowNumber,
          field: 'nombre',
          message: 'El nombre del producto es requerido.',
          rawData,
        });
      }

      if (price === null || price <= 0) {
        rowErrors.push({
          rowNumber,
          field: 'precio',
          message: 'El precio debe ser mayor que cero.',
          rawData,
        });
      }

      if (stock === null || stock < 0) {
        rowErrors.push({
          rowNumber,
          field: 'stock',
          message: 'El stock debe ser un numero mayor o igual a cero.',
          rawData,
        });
      }

      if (errorsBeforeRow !== rowErrors.length) {
        continue;
      }

      preparedRows.push({
        rowNumber,
        rawData,
        categoryName: getText(normalized, ['categoria', 'tipo', 'category']),
        payload: {
          name: name!,
          sku: getText(normalized, ['codigo', 'codigo producto', 'sku']),
          barcode: getText(normalized, ['codigo barras', 'codigo de barras', 'barcode']),
          imageUrl: getText(normalized, ['imagen', 'image', 'image url', 'imageurl']),
          brand: getText(normalized, ['marca', 'proveedor', 'brand', 'supplier']),
          kind: ['personalizado', 'personalized'].includes(
            getText(normalized, ['tipo producto', 'product kind'])?.toLowerCase() ?? '',
          )
            ? ProductKind.PERSONALIZED
            : ProductKind.STANDARD,
          material: getText(normalized, ['material']),
          measurement: getText(normalized, ['medida', 'measurement']),
          unit: getProductUnit(getText(normalized, ['unidad', 'unit'])),
          price: price!,
          cost: cost ?? undefined,
          taxCategory: taxRate === 0 ? TaxCategory.EXEMPT : undefined,
          taxRate: taxRate ?? undefined,
          stock: stock!,
          minStock: minStock ?? undefined,
          status: getProductStatus(getText(normalized, ['estado', 'status'])),
          trackInventory: getOptionalBoolean(normalized, ['control inventario', 'track inventory']),
        },
      });
    }

    const importedProducts = new Map<number, ImportedProductReference>();
    const categoryCache = new Map<string, string>();

    for (const row of preparedRows) {
      try {
        const categoryId = row.categoryName
          ? await this.resolveCategoryId(tenantId, row.categoryName, categoryCache)
          : undefined;

        const product = await this.productsService.create(tenantId, userId, {
          ...row.payload,
          categoryId,
          minStock: row.payload.minStock ?? 0,
        });
        importedProducts.set(row.rowNumber, {
          id: product.id,
          label: getProductLabel(product.name, product.sku),
        });
      } catch (error) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          message: getImportErrorMessage(error),
          rawData: row.rawData,
        });
      }
    }

    const errorsByRow = groupImportErrorsByRow(rowErrors);
    const importRows: ImportBatchRowInput[] = rows.map((row, index) => {
      const rowNumber = index + 2;
      const errors = errorsByRow.get(rowNumber) ?? [];
      const importedProduct = importedProducts.get(rowNumber);

      return {
        rowNumber,
        status: errors.length ? ImportRowStatus.FAILED : ImportRowStatus.IMPORTED,
        productId: importedProduct?.id,
        productLabel: importedProduct?.label,
        rawData: toJsonObject(row),
        reasons: errors.length ? toImportRowReasons(errors) : undefined,
      };
    });
    const invalidRows = importRows.filter((row) => row.status === ImportRowStatus.FAILED).length;
    const importedRows = importRows.filter((row) => row.status === ImportRowStatus.IMPORTED).length;
    const validRows = Math.max(rows.length - invalidRows, 0);

    return this.persistImportResults({
      batchId,
      totalRows: rows.length,
      validRows,
      invalidRows,
      importedRows,
      importRows,
      rowErrors,
    });
  }

  private async persistImportResults(data: {
    batchId: string;
    totalRows: number;
    validRows: number;
    invalidRows: number;
    importedRows: number;
    importRows: ImportBatchRowInput[];
    rowErrors: ImportRowErrorInput[];
  }) {
    const status = data.importedRows > 0 ? ImportStatus.IMPORTED : ImportStatus.FAILED;
    const confirmedAt = data.importedRows > 0 ? new Date() : undefined;
    const batch = await this.prisma.$transaction(async (tx) => {
      for (const chunk of chunkItems(data.importRows, importPersistenceChunkSize)) {
        await tx.importBatchRow.createMany({
          data: chunk.map((row) => ({
            importBatchId: data.batchId,
            rowNumber: row.rowNumber,
            status: row.status,
            productId: row.productId,
            productLabel: row.productLabel,
            rawData: row.rawData,
            reasons: row.reasons,
          })),
        });
      }

      for (const chunk of chunkItems(data.rowErrors, importPersistenceChunkSize)) {
        await tx.importRowError.createMany({
          data: chunk.map((error) => ({
            importBatchId: data.batchId,
            rowNumber: error.rowNumber,
            field: error.field,
            message: error.message,
            rawData: error.rawData,
          })),
        });
      }

      return tx.importBatch.update({
        where: { id: data.batchId },
        data: {
          status,
          totalRows: data.totalRows,
          validRows: data.validRows,
          invalidRows: data.invalidRows,
          importedRows: data.importedRows,
          confirmedAt,
        },
        select: {
          id: true,
          type: true,
          filename: true,
          status: true,
          totalRows: true,
          validRows: true,
          invalidRows: true,
          importedRows: true,
          createdAt: true,
          confirmedAt: true,
          createdBy: { select: { id: true, name: true, email: true } },
          _count: { select: { rows: true, errors: true } },
        },
      });
    });

    return {
      ...batch,
      errorCount: batch._count.errors,
      detailedRowCount: batch._count.rows,
    };
  }

  private async markBatchAsFailed(batchId: string, totalRows: number) {
    try {
      await this.prisma.importBatch.update({
        where: { id: batchId },
        data: {
          status: ImportStatus.FAILED,
          totalRows,
        },
      });
    } catch {
      // Preserve the original import error. A second database failure here is
      // not more useful to the caller and the batch was already created.
    }
  }

  async remove(tenantId: string, userId: string, id: string) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        filename: true,
        type: true,
        status: true,
        totalRows: true,
        importedRows: true,
        invalidRows: true,
        _count: { select: { rows: true, errors: true } },
      },
    });

    if (!batch) {
      throw new NotFoundException('No se encontro el lote de importacion.');
    }

    // Solo se elimina el historial del lote. Ningun producto creado por la
    // importacion se toca; ImportBatchRow usa onDelete: SetNull hacia Product.
    // El log se escribe dentro de la misma transaccion para que no exista un
    // borrado exitoso sin trazabilidad de auditoria.
    await this.prisma.$transaction(async (tx) => {
      await tx.importBatch.delete({ where: { id: batch.id } });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'IMPORT_BATCH_DELETED',
          entity: 'ImportBatch',
          entityId: batch.id,
          metadata: {
            filename: batch.filename,
            type: batch.type,
            status: batch.status,
            totalRows: batch.totalRows,
            importedRows: batch.importedRows,
            invalidRows: batch.invalidRows,
            detailedRowsDeleted: batch._count.rows,
            legacyErrorsDeleted: batch._count.errors,
            productsDeleted: 0,
          },
        },
      });
    });

    return {
      id: batch.id,
      deleted: true,
      productsDeleted: 0,
    };
  }

  private async getLegacyErrorRows(importBatchId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const [countResult, rowNumberResult] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "rowNumber") AS "total"
        FROM "ImportRowError"
        WHERE "importBatchId" = ${importBatchId}
      `),
      this.prisma.$queryRaw<Array<{ rowNumber: number }>>(Prisma.sql`
        SELECT DISTINCT "rowNumber"
        FROM "ImportRowError"
        WHERE "importBatchId" = ${importBatchId}
        ORDER BY "rowNumber" ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `),
    ]);
    const rowNumbers = rowNumberResult.map((row) => row.rowNumber);
    const total = Number(countResult[0]?.total ?? 0);

    if (!rowNumbers.length) {
      return { rows: [], total };
    }

    const errors = await this.prisma.importRowError.findMany({
      where: { importBatchId, rowNumber: { in: rowNumbers } },
      orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
    });
    const errorsByRow = new Map<number, typeof errors>();

    for (const error of errors) {
      const rowErrors = errorsByRow.get(error.rowNumber) ?? [];
      rowErrors.push(error);
      errorsByRow.set(error.rowNumber, rowErrors);
    }

    return {
      total,
      rows: rowNumbers.flatMap((rowNumber) => {
        const rowErrors = errorsByRow.get(rowNumber);

        if (!rowErrors?.length) {
          return [];
        }

        return [
          {
            id: `legacy-${rowErrors[0].id}`,
            rowNumber,
            status: ImportRowStatus.FAILED,
            productId: null,
            productLabel: null,
            product: null,
            rawData: rowErrors[0].rawData ?? {},
            reasons: rowErrors.map((error) =>
              error.field
                ? { field: error.field, message: error.message }
                : { message: error.message },
            ),
            legacy: true,
          },
        ];
      }),
    };
  }

  private async resolveCategoryId(tenantId: string, name: string, cache: Map<string, string>) {
    const normalizedName = name.trim();
    const key = normalizedName.toLowerCase();

    if (cache.has(key)) {
      return cache.get(key);
    }

    const existing = await this.prisma.productCategory.findFirst({
      where: {
        tenantId,
        name: { equals: normalizedName, mode: 'insensitive' },
      },
      select: { id: true },
    });

    if (existing) {
      cache.set(key, existing.id);
      return existing.id;
    }

    const created = await this.prisma.productCategory.create({
      data: {
        tenantId,
        name: normalizedName,
        status: ProductStatus.ACTIVE,
      },
      select: { id: true },
    });

    cache.set(key, created.id);
    return created.id;
  }
}

function parseImportRowStatus(value?: string) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();

  if (normalized === ImportRowStatus.IMPORTED || normalized === ImportRowStatus.FAILED) {
    return normalized as ImportRowStatus;
  }

  throw new BadRequestException('El estado de fila debe ser IMPORTED o FAILED.');
}

function parsePagination(pageInput?: string | number, limitInput?: string | number) {
  const page = parsePositiveInteger(pageInput, 1, 'page');
  const limit = parsePositiveInteger(limitInput, 50, 'limit');

  if (limit > 100) {
    throw new BadRequestException('El limite maximo por pagina es 100.');
  }

  return { page, limit };
}

function parsePositiveInteger(value: string | number | undefined, fallback: number, label: string) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException(`${label} debe ser un entero mayor o igual a 1.`);
  }

  return parsed;
}

function createPagination(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    hasPreviousPage: page > 1,
  };
}

function groupImportErrorsByRow(errors: ImportRowErrorInput[]) {
  const errorsByRow = new Map<number, ImportRowErrorInput[]>();

  for (const error of errors) {
    const rowErrors = errorsByRow.get(error.rowNumber) ?? [];
    rowErrors.push(error);
    errorsByRow.set(error.rowNumber, rowErrors);
  }

  return errorsByRow;
}

function toImportRowReasons(errors: ImportRowErrorInput[]): Prisma.InputJsonArray {
  return errors.map((error) =>
    error.field
      ? ({ field: error.field, message: error.message } as Prisma.InputJsonObject)
      : ({ message: error.message } as Prisma.InputJsonObject),
  );
}

function normalizeRowReasons(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((reason) => {
    if (!reason || typeof reason !== 'object' || Array.isArray(reason)) {
      return [];
    }

    const record = reason as Prisma.JsonObject;

    const message = typeof record.message === 'string' ? record.message : undefined;

    if (!message) {
      return [];
    }

    const field = typeof record.field === 'string' ? record.field : undefined;

    return [field ? { field, message } : { message }];
  });
}

function getProductLabel(name: string, sku?: string | null) {
  return sku ? `${name} (${sku})` : name;
}

function* chunkItems<T>(items: T[], size: number) {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

async function readWorkbookRows(file: UploadedImportFile) {
  if (file.size > 10 * 1024 * 1024) {
    throw new BadRequestException('Import file cannot be larger than 10 MB.');
  }

  const rows = await readSheet(file.buffer);
  const [headerRow, ...dataRows] = rows;

  if (!headerRow?.length) {
    throw new BadRequestException('Import file does not contain sheets.');
  }

  const headers = headerRow.map((header: CellValue | null) => String(header ?? '').trim());

  if (!headers.some(Boolean)) {
    throw new BadRequestException('Import file does not contain headers.');
  }

  return dataRows
    .filter((row) => row.some((value: CellValue | null) => !isBlank(value)))
    .map((row) =>
      headers.reduce<RawImportRow>((record, header, index) => {
        if (header) {
          record[header] = row[index] ?? '';
        }

        return record;
      }, {}),
    );
}

function normalizeRow(row: RawImportRow) {
  const normalized = new Map<string, unknown>();

  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeHeader(key), value);
  }

  return normalized;
}

function normalizeHeader(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getText(row: Map<string, unknown>, keys: string[]) {
  for (const key of keys.map(normalizeHeader)) {
    const value = row.get(key);

    if (value === undefined || value === null) {
      continue;
    }

    const text = String(value).trim();

    if (text) {
      return text;
    }
  }

  return undefined;
}

function getMoney(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);
  const parsed = parseNumericValue(value);

  return parsed === null ? null : Number(parsed.toFixed(2));
}

function getOptionalMoney(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);

  if (isBlank(value)) {
    return null;
  }

  return getMoney(row, keys);
}

function getQuantity(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);
  const parsed = parseNumericValue(value);

  if (parsed === null) {
    return null;
  }

  return Number(parsed.toFixed(3));
}

function getOptionalQuantity(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);

  if (isBlank(value)) {
    return null;
  }

  return getQuantity(row, keys);
}

function getOptionalTaxRate(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);

  if (isBlank(value)) {
    return null;
  }

  const parsed = parseNumericValue(value);

  if (parsed === null || parsed < 0) {
    return null;
  }

  return parsed > 1 ? parsed / 100 : parsed;
}

function getOptionalBoolean(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);

  if (isBlank(value)) {
    return undefined;
  }

  const text = String(value).trim().toLowerCase();

  if (['si', 'yes', 'true', '1'].includes(text)) {
    return true;
  }

  if (['no', 'false', '0'].includes(text)) {
    return false;
  }

  return undefined;
}

function getBusinessDate(row: Map<string, unknown>, keys: string[]) {
  const value = getRawValue(row, keys);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    return text;
  }
  return undefined;
}

function getOptionalWholeNumber(row: Map<string, unknown>, keys: string[]) {
  const value = getQuantity(row, keys);
  return value !== null && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isTruthyImportValue(value?: string) {
  return ['si', 'sí', 'yes', 'true', '1', 'urgente'].includes(value?.trim().toLowerCase() ?? '');
}

function parseDeliveryMethod(value?: string) {
  const normalized = normalizeImportAlias(value);
  if (normalized === 'delivery' || normalized === 'domicilio') return DeliveryMethod.DELIVERY;
  if (normalized === 'provincia' || normalized === 'envio provincia') {
    return DeliveryMethod.PROVINCE_SHIPPING;
  }
  return DeliveryMethod.PICKUP;
}

function parseDispatchLocation(value?: string) {
  return normalizeImportAlias(value) === 'fabrica'
    ? DispatchLocation.FACTORY
    : DispatchLocation.STORE;
}

function getRawValue(row: Map<string, unknown>, keys: string[]) {
  for (const key of keys.map(normalizeHeader)) {
    if (row.has(key)) {
      return row.get(key);
    }
  }

  return undefined;
}

function isBlank(value: unknown) {
  return value === undefined || value === null || String(value).trim() === '';
}

function parseNumericValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (isBlank(value)) {
    return null;
  }

  const text = String(value)
    .replace(/[^\d,.-]/g, '')
    .trim();

  if (!text) {
    return null;
  }

  let normalized = text;

  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replace(/,/g, '');
  } else if (normalized.includes(',')) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(normalized)
      ? normalized.replace(/,/g, '')
      : normalized.replace(',', '.');
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function getProductUnit(value?: string) {
  const key = normalizeImportAlias(value);

  if (!key) {
    return undefined;
  }

  const units: Record<string, ProductUnit> = {
    u: ProductUnit.UNIT,
    und: ProductUnit.UNIT,
    uds: ProductUnit.UNIT,
    unidad: ProductUnit.UNIT,
    unidades: ProductUnit.UNIT,
    unit: ProductUnit.UNIT,
    units: ProductUnit.UNIT,
    caja: ProductUnit.BOX,
    cajas: ProductUnit.BOX,
    box: ProductUnit.BOX,
    boxes: ProductUnit.BOX,
    paquete: ProductUnit.PACK,
    paquetes: ProductUnit.PACK,
    pack: ProductUnit.PACK,
    packs: ProductUnit.PACK,
    saco: ProductUnit.BAG,
    sacos: ProductUnit.BAG,
    bag: ProductUnit.BAG,
    bags: ProductUnit.BAG,
    rollo: ProductUnit.ROLL,
    rollos: ProductUnit.ROLL,
    roll: ProductUnit.ROLL,
    rolls: ProductUnit.ROLL,
    m: ProductUnit.METER,
    metro: ProductUnit.METER,
    metros: ProductUnit.METER,
    meter: ProductUnit.METER,
    meters: ProductUnit.METER,
    mt: ProductUnit.METER,
    mts: ProductUnit.METER,
    pie: ProductUnit.FOOT,
    pies: ProductUnit.FOOT,
    foot: ProductUnit.FOOT,
    feet: ProductUnit.FOOT,
    ft: ProductUnit.FOOT,
    yarda: ProductUnit.YARD,
    yardas: ProductUnit.YARD,
    yard: ProductUnit.YARD,
    yards: ProductUnit.YARD,
    yd: ProductUnit.YARD,
    yds: ProductUnit.YARD,
    libra: ProductUnit.POUND,
    libras: ProductUnit.POUND,
    lb: ProductUnit.POUND,
    lbs: ProductUnit.POUND,
    pound: ProductUnit.POUND,
    pounds: ProductUnit.POUND,
    gal: ProductUnit.GALLON,
    gln: ProductUnit.GALLON,
    galon: ProductUnit.GALLON,
    galones: ProductUnit.GALLON,
    gallon: ProductUnit.GALLON,
    gallons: ProductUnit.GALLON,
    gl: ProductUnit.GALLON,
    l: ProductUnit.LITER,
    lt: ProductUnit.LITER,
    lts: ProductUnit.LITER,
    litro: ProductUnit.LITER,
    litros: ProductUnit.LITER,
    liter: ProductUnit.LITER,
    liters: ProductUnit.LITER,
    kg: ProductUnit.KILOGRAM,
    kgs: ProductUnit.KILOGRAM,
    kilogramo: ProductUnit.KILOGRAM,
    kilogramos: ProductUnit.KILOGRAM,
    kilogram: ProductUnit.KILOGRAM,
    kilograms: ProductUnit.KILOGRAM,
    servicio: ProductUnit.SERVICE,
    servicios: ProductUnit.SERVICE,
    service: ProductUnit.SERVICE,
    services: ProductUnit.SERVICE,
  };

  const compactKey = key.replace(/\s+/g, '');
  const enumKey = compactKey.toUpperCase();
  const enumValue = Object.values(ProductUnit).find((unit) => unit === enumKey);

  return units[key] ?? units[compactKey] ?? enumValue;
}

function normalizeImportAlias(value?: string) {
  return value
    ?.trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getProductStatus(value?: string) {
  const key = value?.trim().toLowerCase();

  if (!key) {
    return ProductStatus.ACTIVE;
  }

  const statuses: Record<string, ProductStatus> = {
    activo: ProductStatus.ACTIVE,
    active: ProductStatus.ACTIVE,
    inactivo: ProductStatus.INACTIVE,
    inactive: ProductStatus.INACTIVE,
    descontinuado: ProductStatus.DISCONTINUED,
    discontinued: ProductStatus.DISCONTINUED,
  };

  return statuses[key] ?? ProductStatus.ACTIVE;
}

function parseCustomerDocumentType(value?: string) {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (normalized === 'rnc') return DocumentType.RNC;
  if (normalized === 'cedula') return DocumentType.CEDULA;
  if (normalized === 'pasaporte' || normalized === 'passport') return DocumentType.PASSPORT;
  return DocumentType.OTHER;
}

function toJsonObject(row: RawImportRow) {
  const output: Record<string, Prisma.InputJsonValue> = {};

  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) {
      continue;
    }

    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      output[key] = value as Prisma.InputJsonValue;
    } else {
      output[key] = String(value);
    }
  }

  return output as Prisma.InputJsonObject;
}

function getImportErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'No se pudo importar esta fila.';
}

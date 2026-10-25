'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Barcode,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Printer,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  deleteProduct,
  generateProductBarcode,
  getProductDepartments,
  getProductLabel,
  getProducts,
} from '@/lib/api';
import { openBarcodeLabelPrintWindow, printBarcodeLabel } from '@/lib/barcode-label-print';
import { brand } from '@/lib/brand';
import {
  getStatusVariant,
  translateBarcodeType,
  translateProductUnit,
  translateStatus,
} from '@/lib/display-labels';
import { formatCurrency } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { formatQuantity } from './pos/pos-utils';
import { ProductFormDialog } from './product-form-dialog';
import { SessionRequired, useCurrentSession } from './session-required';

export function ProductsView() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('ALL');
  const [stockFilter, setStockFilter] = useState<'ALL' | 'LOW' | 'OUT'>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productPendingDeactivation, setProductPendingDeactivation] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    setSearch(searchParams.get('q') ?? '');
    const stock = searchParams.get('stock');
    setStockFilter(stock === 'low' ? 'LOW' : stock === 'out' ? 'OUT' : 'ALL');
    setPage(1);
  }, [searchParams]);

  const productsQuery = useQuery({
    queryKey: ['products', session?.tenantId, search],
    queryFn: () => getProducts(session?.tenantId ?? '', session?.accessToken ?? '', search),
    enabled: Boolean(session),
  });
  const departmentsQuery = useQuery({
    queryKey: ['product-departments', session?.tenantId],
    queryFn: () =>
      getProductDepartments(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });
  const generateMutation = useMutation({
    mutationFn: (productId: string) => {
      if (!session) {
        throw new Error('Sesion requerida.');
      }

      return generateProductBarcode(session.tenantId, session.accessToken, productId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Codigo generado correctamente.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo generar el codigo.');
    },
  });
  const labelMutation = useMutation({
    mutationFn: ({ productId }: { productId: string; printWindow: Window }) => {
      if (!session) {
        throw new Error('Sesion requerida.');
      }

      return getProductLabel(session.tenantId, session.accessToken, productId);
    },
    onSuccess: (label, variables) => {
      try {
        printBarcodeLabel(variables.printWindow, label);
        toast.success('Etiqueta enviada a la impresora', {
          description: `${label.name} - ${label.barcode}`,
        });
      } catch (error) {
        variables.printWindow.close();
        toast.error(error instanceof Error ? error.message : 'No se pudo preparar la etiqueta.');
      }
    },
    onError: (error, variables) => {
      variables.printWindow.close();
      toast.error(error instanceof Error ? error.message : 'No se pudo preparar la etiqueta.');
    },
  });

  function requestProductLabel(productId: string) {
    const printWindow = openBarcodeLabelPrintWindow();
    if (!printWindow) {
      toast.error(
        'El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes e inténtalo de nuevo.',
      );
      return;
    }

    labelMutation.mutate({ productId, printWindow });
  }
  const deleteMutation = useMutation({
    mutationFn: (productId: string) => {
      if (!session) {
        throw new Error('Sesion requerida.');
      }

      return deleteProduct(session.tenantId, session.accessToken, productId);
    },
    onSuccess: async (product) => {
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Producto desactivado', { description: product.name });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo desactivar el producto.');
    },
  });

  if (!session) {
    return <SessionRequired session={session} />;
  }

  const readOnly = session.role === 'ACCOUNTANT';
  const products = productsQuery.data ?? [];
  const stockCounts = products.filter(
    (product) => departmentFilter === 'ALL' || product.category?.id === departmentFilter,
  ).reduce(
    (counts, product) => {
      if (product.status !== 'ACTIVE' || !product.trackInventory) return counts;
      const available = getAvailableStock(product);
      if (available <= 0) counts.out += 1;
      else if (available <= Number(product.minStock)) counts.low += 1;
      return counts;
    },
    { low: 0, out: 0 },
  );
  const filteredProducts = products
    .filter((product) => departmentFilter === 'ALL' || product.category?.id === departmentFilter)
    .filter((product) => {
      if (stockFilter === 'ALL') return true;
      if (product.status !== 'ACTIVE' || !product.trackInventory) return false;
      const available = getAvailableStock(product);
      return stockFilter === 'OUT'
        ? available <= 0
        : available > 0 && available <= Number(product.minStock);
    })
    .sort((left, right) => {
      const departmentOrder = (left.category?.name ?? '').localeCompare(
        right.category?.name ?? '',
        'es',
      );
      return departmentOrder || left.name.localeCompare(right.name, 'es');
    });
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rangeStart = filteredProducts.length ? (currentPage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(currentPage * pageSize, filteredProducts.length);
  const visibleProducts = filteredProducts.slice(rangeStart ? rangeStart - 1 : 0, rangeEnd);

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Productos"
        description={`Catálogo de productos y servicios de ${brand.name}, precios e inventario desde PostgreSQL.`}
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid flex-1 gap-3 sm:grid-cols-[minmax(260px,1fr)_minmax(200px,0.65fr)_minmax(180px,0.55fr)]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              className="bg-white pl-9"
              placeholder="Buscar nombre, SKU, departamento o codigo"
            />
          </div>
          <select
            value={departmentFilter}
            onChange={(event) => {
              setDepartmentFilter(event.target.value);
              setPage(1);
            }}
            className="h-10 rounded-md border border-input bg-white px-3 text-sm"
            aria-label="Filtrar productos por departamento"
            disabled={departmentsQuery.isLoading}
          >
            <option value="ALL">
              {departmentsQuery.isLoading ? 'Cargando departamentos...' : 'Todos los departamentos'}
            </option>
            {(departmentsQuery.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
          <select
            value={stockFilter}
            onChange={(event) => {
              setStockFilter(event.target.value as 'ALL' | 'LOW' | 'OUT');
              setPage(1);
            }}
            className="h-10 rounded-md border border-input bg-white px-3 text-sm"
            aria-label="Filtrar productos por nivel de stock"
          >
            <option value="ALL">Todos los niveles de stock</option>
            <option value="LOW">Stock bajo ({stockCounts.low})</option>
            <option value="OUT">Agotados ({stockCounts.out})</option>
          </select>
        </div>
        {!readOnly ? (
          <Button
            type="button"
            onClick={() => {
              setEditingProductId(null);
              setCreateDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Nuevo producto
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Catalogo</CardTitle>
              <CardDescription>
                {departmentFilter === 'ALL' && stockFilter === 'ALL'
                  ? `${products.length} productos activos o inactivos.`
                  : `${filteredProducts.length} de ${products.length} productos coinciden con los filtros.`}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-label="Leyenda de inventario">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-300" />Stock bajo</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-300" />Agotado</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProductPagination
            page={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={filteredProducts.length}
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
          />

          {productsQuery.isLoading ? (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              Cargando productos...
            </div>
          ) : productsQuery.isError ? (
            <div className="rounded-md border border-danger/20 bg-danger/5 px-4 py-8 text-center">
              <p className="text-sm font-medium text-danger">No se pudo cargar el catálogo.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void productsQuery.refetch()}
              >
                Reintentar
              </Button>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {search || departmentFilter !== 'ALL' || stockFilter !== 'ALL'
                ? 'No hay productos que coincidan con los filtros.'
                : 'No hay productos registrados.'}
            </div>
          ) : null}

          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 md:hidden">
            {visibleProducts.map((product) => {
              const availableStock = getAvailableStock(product);
              const outOfStock = product.trackInventory && availableStock <= 0;
              const lowStock = product.trackInventory
                && !outOfStock
                && availableStock <= Number(product.minStock);
              return (
                <div
                  key={product.id}
                  className={`rounded-md border p-3 ${
                    outOfStock
                      ? 'border-red-200 bg-red-50/80'
                      : lowStock
                        ? 'border-amber-200 bg-amber-50/80'
                        : 'border-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{product.name}</p>
                      <p className="text-xs text-muted-foreground">{product.sku ?? 'Sin SKU'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {product.category?.name ?? 'Sin departamento'} · {translateProductUnit(product.unit)}
                      </p>
                    </div>
                    <Badge variant={getStatusVariant(product.status)}>
                      {translateStatus(product.status)}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <div>
                      <p className="font-semibold">
                        {formatCurrency(getSalePrice(product))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Costo {formatCurrency(Number(product.cost ?? 0))}
                      </p>
                    </div>
                    {product.trackInventory ? (
                      <div className="text-right">
                        <Badge variant={outOfStock ? 'danger' : lowStock ? 'warning' : 'success'}>
                          {outOfStock ? 'Agotado' : lowStock ? 'Stock bajo' : `${formatQuantity(availableStock)} disp.`}
                          {' · '}{formatQuantity(product.reservedStock)} res.
                        </Badge>
                        {(outOfStock || lowStock) ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatQuantity(availableStock)} disp. / mín. {formatQuantity(product.minStock)}
                            {Number(product.minStock) > availableStock
                              ? ` · faltan ${formatQuantity(Number(product.minStock) - availableStock)}`
                              : ''}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <Badge variant="outline">Servicio</Badge>
                    )}
                  </div>
                  {!readOnly ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full bg-white/80"
                      onClick={() => setEditingProductId(product.id)}
                    >
                      <Pencil className="h-4 w-4" />
                      Editar producto
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="hidden md:block">
            <Table wrapperClassName="max-h-[65vh] rounded-md border border-border overflow-auto">
              <TableHeader className="sticky top-0 z-10 bg-card shadow-sm">
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead>Departamento</TableHead>
                  <TableHead>Unidad</TableHead>
                  <TableHead className="text-right">Costo unitario</TableHead>
                  <TableHead className="text-right">Precio con ITBIS</TableHead>
                  <TableHead>Codigo de barras</TableHead>
                  <TableHead>Existencia</TableHead>
                  <TableHead>Estado</TableHead>
                  {!readOnly ? <TableHead className="text-right">Acciones</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleProducts.map((product) => {
                  const availableStock = getAvailableStock(product);
                  const outOfStock = product.trackInventory && availableStock <= 0;
                  const lowStock = product.trackInventory
                    && !outOfStock
                    && availableStock <= Number(product.minStock);
                  return (
                    <TableRow
                      key={product.id}
                      className={
                        outOfStock
                          ? 'group bg-red-50/80 hover:bg-red-100/80'
                          : lowStock
                            ? 'group bg-amber-50/80 hover:bg-amber-100/80'
                            : 'group'
                      }
                    >
                      <TableCell>
                        <div className="font-medium">{product.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {product.sku ?? 'Sin SKU'}
                        </div>
                      </TableCell>
                      <TableCell>{product.category?.name ?? 'Sin departamento'}</TableCell>
                      <TableCell>{translateProductUnit(product.unit)}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(product.cost ?? 0))}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(getSalePrice(product))}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{product.barcode ?? 'Sin codigo'}</div>
                        <div className="text-xs text-muted-foreground">
                          {translateBarcodeType(product.barcodeType)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {product.trackInventory ? (
                          <div>
                            <Badge variant={outOfStock ? 'danger' : lowStock ? 'warning' : 'success'}>
                              {outOfStock ? 'Agotado' : lowStock ? 'Stock bajo' : `${formatQuantity(availableStock)} disp.`}
                              {' · '}{formatQuantity(product.reservedStock)} res.
                            </Badge>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatQuantity(availableStock)} disp. / mín. {formatQuantity(product.minStock)}
                              {Number(product.minStock) > availableStock
                                ? ` · faltan ${formatQuantity(Number(product.minStock) - availableStock)}`
                                : ''}
                            </p>
                          </div>
                        ) : (
                          <Badge variant="outline">Servicio</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusVariant(product.status)}>
                          {translateStatus(product.status)}
                        </Badge>
                      </TableCell>
                      {!readOnly ? (
                        <TableCell className="text-right">
                          <div className="pointer-events-none flex justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                            {!product.barcode ? (
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={() => generateMutation.mutate(product.id)}
                                aria-label="Generar codigo de barras"
                              >
                                <Barcode className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={() => requestProductLabel(product.id)}
                                aria-label="Imprimir etiqueta"
                              >
                                <Printer className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setEditingProductId(product.id)}
                              aria-label={`Editar ${product.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={deleteMutation.isPending}
                              onClick={() =>
                                setProductPendingDeactivation({
                                  id: product.id,
                                  name: product.name,
                                })
                              }
                              aria-label="Desactivar producto"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <ProductPagination
            page={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={filteredProducts.length}
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
          />
        </CardContent>
      </Card>
      <ProductFormDialog
        open={createDialogOpen || Boolean(editingProductId)}
        productId={editingProductId ?? undefined}
        onClose={() => {
          setCreateDialogOpen(false);
          setEditingProductId(null);
        }}
        onSaved={() => {
          setCreateDialogOpen(false);
          setEditingProductId(null);
          setPage(1);
        }}
      />
      <ActionDialog
        open={Boolean(productPendingDeactivation)}
        onClose={() => {
          if (!deleteMutation.isPending) setProductPendingDeactivation(null);
        }}
        title="Desactivar producto"
        description="El producto dejará de estar disponible para nuevas ventas. Su historial, movimientos e inventario se conservarán."
        tone="danger"
        size="sm"
        confirmLabel="Desactivar producto"
        cancelLabel="Cancelar"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          const product = productPendingDeactivation;
          if (!product) return;
          deleteMutation.mutate(product.id, {
            onSuccess: () => setProductPendingDeactivation(null),
          });
        }}
        summary={
          productPendingDeactivation ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Producto
              </p>
              <p className="mt-0.5 font-semibold text-foreground">
                {productPendingDeactivation.name}
              </p>
            </div>
          ) : null
        }
      />
    </div>
  );
}

function ProductPagination({
  page,
  pageCount,
  pageSize,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Mostrar</span>
        <select
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
          aria-label="Productos por bloque"
        >
          {[50, 100, 200].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span>por bloque</span>
      </div>

      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Bloque anterior"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-36 text-center text-sm">
          <span className="font-medium text-foreground">
            {rangeStart}-{rangeEnd}
          </span>{' '}
          <span className="text-muted-foreground">de {total}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label="Bloque siguiente"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function getAvailableStock(product: { stock: number | string; reservedStock: number | string }) {
  return Math.max(Number(product.stock) - Number(product.reservedStock), 0);
}

function getSalePrice(product: { salePrice: number | string; price: number | string }) {
  const salePrice = Number(product.salePrice);
  return salePrice > 0 ? salePrice : Number(product.price);
}

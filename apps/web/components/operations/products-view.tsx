'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Barcode,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CollectionSelect } from '@/components/operations/collection-select';
import { ActionDialog } from '@/components/ui/action-dialog';
import { isAdminSession } from '@/lib/authorization';
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
  getProductLabel,
  getProductCollections,
  getProducts,
  getShopifyIntegrationStatus,
  retryShopifyIntegration,
  syncShopifyProduct,
} from '@/lib/api';
import { openBarcodeLabelPrintWindow, printBarcodeLabel } from '@/lib/barcode-label-print';
import { brand } from '@/lib/brand';
import { getStatusVariant, translateBarcodeType, translateStatus } from '@/lib/display-labels';
import { formatCurrency } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { formatQuantity } from './pos/pos-utils';
import { ProductFormDialog } from './product-form-dialog';
import { SessionRequired, useCurrentSession } from './session-required';
import { WebCatalogPanel } from './web-catalog/web-catalog-panel';

function ProductsInventoryPanel() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [collection, setCollection] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productPendingDeactivation, setProductPendingDeactivation] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get('q');
    if (query) {
      setSearch(query);
    }
  }, []);

  const productsQuery = useQuery({
    queryKey: ['products', session?.tenantId, search, collection],
    queryFn: () =>
      getProducts(session?.tenantId ?? '', session?.accessToken ?? '', search, collection),
    enabled: Boolean(session),
  });
  const collectionsQuery = useQuery({
    queryKey: ['product-collections', session?.tenantId],
    queryFn: () => getProductCollections(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });
  const shopifyStatus = useQuery({
    queryKey: ['shopify-status', session?.tenantId],
    queryFn: () => getShopifyIntegrationStatus(session!.tenantId, session!.accessToken),
    enabled: Boolean(
      session && ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN'].includes(session.role),
    ),
    refetchInterval: 15000,
  });
  const retryMutation = useMutation({
    mutationFn: () => retryShopifyIntegration(session!.tenantId, session!.accessToken),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      toast.info(
        result.configured
          ? 'Reintento completado; revisa los resultados.'
          : 'Shopify está pendiente de configurar.',
      );
    },
    onError: (error) => toast.error(error.message),
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
  const shopifyMutation = useMutation({
    mutationFn: (productId: string) => {
      if (!session) throw new Error('Sesion requerida.');
      return syncShopifyProduct(session.tenantId, session.accessToken, productId);
    },
    onSuccess: async (product) => {
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Producto sincronizado con Shopify.', { description: product.name });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo sincronizar con Shopify.');
    },
  });

  if (!session) {
    return <SessionRequired session={session} />;
  }

  const readOnly = !isAdminSession(session);
  const products = productsQuery.data ?? [];
  const pageCount = Math.max(1, Math.ceil(products.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rangeStart = products.length ? (currentPage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(currentPage * pageSize, products.length);
  const visibleProducts = products.slice(rangeStart ? rangeStart - 1 : 0, rangeEnd);

  return (
    <div className="space-y-6">
      {shopifyStatus.data ? (
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm">
                Shopify: {shopifyStatus.data.configured ? 'configurado' : 'pendiente de configurar'}{' '}
                · {shopifyStatus.data.jobs.filter((job) => job.pending).length} cambios pendientes
              </p>
              <Button
                variant="outline"
                disabled={!shopifyStatus.data.configured || retryMutation.isPending}
                onClick={() => retryMutation.mutate()}
              >
                Reintentar sincronización
              </Button>
            </div>
            {shopifyStatus.data.jobs
              .filter((job) => job.error)
              .map((job) => (
                <p key={job.id} className="text-xs text-red-700">
                  {productsQuery.data?.find((product) => product.id === job.productId)?.name ??
                    job.productId}
                  : {job.error}
                </p>
              ))}
            {shopifyStatus.data.dispatchErrors.map((order) => (
              <p key={order.id} className="text-xs text-red-700">
                {order.orderNumber}: {order.shopifyFulfillmentError}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="bg-white pl-9"
            placeholder="Buscar nombre, SKU, marca o codigo"
          />
        </div>
        <div className="w-full sm:w-72">
          <CollectionSelect
            id="products-collection"
            value={collection}
            options={collectionsQuery.data ?? []}
            onChange={(handle) => {
              setCollection(handle);
              setPage(1);
            }}
          />
        </div>
        {!readOnly ? (
          <Button
            type="button"
            className="sm:ml-auto"
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
              <CardDescription>{products.length} productos activos o inactivos.</CardDescription>
            </div>
            <div
              className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
              aria-label="Leyenda de inventario"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                Stock bajo
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                Agotado
              </span>
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
            total={products.length}
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
          />

          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 md:hidden">
            {visibleProducts.map((product) => {
              const availableStock = getAvailableStock(product);
              const outOfStock = product.trackInventory && availableStock <= 0;
              const lowStock =
                product.trackInventory && !outOfStock && availableStock <= Number(product.minStock);
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
                    </div>
                    <Badge variant={getStatusVariant(product.status)}>
                      {translateStatus(product.status)}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="font-semibold">{formatCurrency(Number(product.price))}</span>
                    {product.trackInventory ? (
                      <Badge variant={outOfStock ? 'danger' : lowStock ? 'warning' : 'success'}>
                        {outOfStock
                          ? 'Agotado'
                          : lowStock
                            ? 'Stock bajo'
                            : `${formatQuantity(availableStock)} disp.`}
                        {' · '}
                        {formatQuantity(product.reservedStock)} res.
                      </Badge>
                    ) : (
                      <Badge variant="outline">Servicio</Badge>
                    )}
                  </div>
                  {!readOnly ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingProductId(product.id)}
                      >
                        <Pencil className="h-4 w-4" /> Editar
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={shopifyMutation.isPending}
                        onClick={() => shopifyMutation.mutate(product.id)}
                      >
                        <RefreshCw className="h-4 w-4" /> Shopify
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          product.barcode
                            ? requestProductLabel(product.id)
                            : generateMutation.mutate(product.id)
                        }
                      >
                        <Barcode className="h-4 w-4" />{' '}
                        {product.barcode ? 'Imprimir etiqueta' : 'Generar código'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={deleteMutation.isPending}
                        onClick={() =>
                          setProductPendingDeactivation({ id: product.id, name: product.name })
                        }
                      >
                        <Trash2 className="h-4 w-4" /> Desactivar
                      </Button>
                    </div>
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
                  <TableHead>Marca</TableHead>
                  <TableHead>Precio</TableHead>
                  <TableHead>Codigo</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Estado</TableHead>
                  {!readOnly ? <TableHead className="text-right">Acciones</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleProducts.map((product) => {
                  const availableStock = getAvailableStock(product);
                  const outOfStock = product.trackInventory && availableStock <= 0;
                  const lowStock =
                    product.trackInventory &&
                    !outOfStock &&
                    availableStock <= Number(product.minStock);
                  return (
                    <TableRow
                      key={product.id}
                      className={
                        outOfStock
                          ? 'bg-red-50/80 hover:bg-red-100/80'
                          : lowStock
                            ? 'bg-amber-50/80 hover:bg-amber-100/80'
                            : undefined
                      }
                    >
                      <TableCell>
                        <div className="font-medium">{product.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {product.sku ?? 'Sin SKU'} {product.brand ? `- ${product.brand}` : ''}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge variant={product.kind === 'PERSONALIZED' ? 'warning' : 'outline'}>
                            {product.kind === 'PERSONALIZED' ? 'Personalizado' : 'Normal'}
                          </Badge>
                          {product.material ? (
                            <Badge variant="outline">{product.material}</Badge>
                          ) : null}
                          {product.measurement ? (
                            <Badge variant="outline">{product.measurement}</Badge>
                          ) : null}
                          {product.shopifySyncedAt ? (
                            <Badge variant="success">Shopify</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>{product.brand?.trim() || 'Sin marca'}</TableCell>
                      <TableCell>{formatCurrency(Number(product.price))}</TableCell>
                      <TableCell>
                        <div className="text-sm">{product.barcode ?? 'Sin codigo'}</div>
                        <div className="text-xs text-muted-foreground">
                          {translateBarcodeType(product.barcodeType)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {product.trackInventory ? (
                          <div>
                            <Badge
                              variant={outOfStock ? 'danger' : lowStock ? 'warning' : 'success'}
                            >
                              {outOfStock
                                ? 'Agotado'
                                : lowStock
                                  ? 'Stock bajo'
                                  : `${formatQuantity(availableStock)} disp.`}
                              {' · '}
                              {formatQuantity(product.reservedStock)} res.
                            </Badge>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Total {formatQuantity(product.stock)} / min{' '}
                              {formatQuantity(product.minStock)}
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
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              disabled={shopifyMutation.isPending}
                              onClick={() => shopifyMutation.mutate(product.id)}
                              aria-label={`Sincronizar ${product.name} con Shopify`}
                              title={
                                product.shopifySyncedAt
                                  ? 'Actualizar en Shopify'
                                  : 'Crear en Shopify'
                              }
                            >
                              <RefreshCw
                                className={`h-4 w-4 ${shopifyMutation.isPending ? 'animate-spin' : ''}`}
                              />
                            </Button>
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
            total={products.length}
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

type ProductsTab = 'inventory' | 'web';

export function ProductsView() {
  const session = useCurrentSession();
  const [tab, setTab] = useState<ProductsTab>('inventory');
  const canManageWeb = isAdminSession(session);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'web') {
      setTab('web');
    }
  }, []);

  const activeTab: ProductsTab = tab === 'web' && canManageWeb ? 'web' : 'inventory';
  const tabs: Array<{ id: ProductsTab; label: string }> = [
    { id: 'inventory', label: 'Productos' },
    ...(canManageWeb ? [{ id: 'web' as const, label: 'Catálogo web' }] : []),
  ];

  function selectTab(next: ProductsTab) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === 'web') url.searchParams.set('tab', 'web');
    else url.searchParams.delete('tab');
    window.history.replaceState(null, '', url);
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Productos"
        description={`Catálogo de productos y servicios de ${brand.name}, precios e inventario desde PostgreSQL.`}
      />
      {tabs.length > 1 ? (
        <div role="tablist" aria-label="Secciones de productos" className="flex gap-1 border-b border-border">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`products-tab-${entry.id}`}
              aria-selected={activeTab === entry.id}
              aria-controls={`products-panel-${entry.id}`}
              tabIndex={activeTab === entry.id ? 0 : -1}
              onClick={() => selectTab(entry.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  const index = tabs.findIndex((candidate) => candidate.id === entry.id);
                  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                  selectTab(next.id);
                  document.getElementById(`products-tab-${next.id}`)?.focus();
                }
              }}
              className={`-mb-px h-11 border-b-2 px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                activeTab === entry.id
                  ? 'border-gold-dark text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        id={`products-panel-${activeTab}`}
        aria-labelledby={tabs.length > 1 ? `products-tab-${activeTab}` : undefined}
      >
        {activeTab === 'web' && session ? (
          <WebCatalogPanel session={session} />
        ) : (
          <ProductsInventoryPanel />
        )}
      </div>
    </div>
  );
}

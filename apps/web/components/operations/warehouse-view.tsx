'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownToLine,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  History,
  PackageCheck,
  PackageMinus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Warehouse,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
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
  activateWarehouseProduct,
  deleteWarehouseProduct,
  getWarehouseMovements,
  getWarehousePendingDispatches,
  getWarehouseProducts,
  type Product,
  type WarehouseMovement,
  type WarehousePendingDispatch,
} from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { formatQuantity } from './pos/pos-utils';
import { SessionRequired, useCurrentSession } from './session-required';
import { WarehouseDispatchDialog } from './warehouse-dispatch-dialog';
import { WarehouseOrderDispatchDialog } from './warehouse-order-dispatch-dialog';
import { WarehouseProductFormDialog } from './warehouse-product-form-dialog';
import { WarehouseReceivingPanel } from './warehouse-receiving-panel';
import { WarehouseStockDialog } from './warehouse-stock-dialog';

type WarehouseCatalogProduct = Product & {
  warehouseStocks: Array<{
    id: string;
    quantity: number;
    unitCost: string | null;
    updatedAt: string;
  }>;
};

type ProductAction = {
  product: WarehouseCatalogProduct;
  mode: 'receive' | 'count';
} | null;

type WarehouseTab = 'inventory' | 'receiving' | 'dispatches' | 'movements';

export function WarehouseView() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<WarehouseTab>(() =>
    session?.role === 'WAREHOUSE_KEEPER' ? 'dispatches' : 'inventory',
  );
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ACTIVE');
  const [movementType, setMovementType] = useState('ALL');
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [stockAction, setStockAction] = useState<ProductAction>(null);
  const [manualDispatch, setManualDispatch] = useState<WarehouseCatalogProduct | null>(null);
  const [orderDispatch, setOrderDispatch] = useState<WarehousePendingDispatch | null>(null);

  const productsQuery = useQuery({
    queryKey: ['warehouse-products', session?.tenantId],
    queryFn: () => getWarehouseProducts(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });
  const movementsQuery = useQuery({
    queryKey: ['warehouse-movements', session?.tenantId],
    queryFn: () => getWarehouseMovements(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });
  const pendingDispatchesQuery = useQuery({
    queryKey: ['warehouse-pending-dispatches', session?.tenantId],
    queryFn: () =>
      getWarehousePendingDispatches(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchInterval: 10_000,
  });

  const productStatusMutation = useMutation({
    mutationFn: ({
      product,
      activate,
    }: {
      product: WarehouseCatalogProduct;
      activate: boolean;
    }) => {
      if (!session) throw new Error('Sesión requerida.');
      return activate
        ? activateWarehouseProduct(session.tenantId, session.accessToken, product.id)
        : deleteWarehouseProduct(session.tenantId, session.accessToken, product.id);
    },
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['warehouse-products'] });
      toast.success(variables.activate ? 'Producto reactivado.' : 'Producto desactivado.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'No se pudo actualizar el producto.');
    },
  });

  const products = (productsQuery.data ?? []) as WarehouseCatalogProduct[];
  const activeProducts = products.filter((product) => product.status === 'ACTIVE');
  const totalUnits = activeProducts.reduce((sum, product) => sum + stockOf(product), 0);
  const lowStockCount = activeProducts.filter(
    (product) => stockOf(product) <= Number(product.minStock ?? 0),
  ).length;
  const pendingDispatches = pendingDispatchesQuery.data ?? [];
  const isWarehouseKeeper = session?.role === 'WAREHOUSE_KEEPER';
  const canOperateStock = session?.role !== 'ACCOUNTANT';

  const filteredProducts = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return products.filter((product) => {
      const matchesStatus = statusFilter === 'ALL' || product.status === statusFilter;
      const matchesSearch =
        !normalized ||
        [product.name, product.sku, product.barcode, product.brand]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalized));
      return matchesStatus && matchesSearch;
    });
  }, [products, search, statusFilter]);

  const filteredMovements = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (movementsQuery.data ?? []).filter((movement) => {
      const matchesType = movementType === 'ALL' || movement.type === movementType;
      const matchesSearch =
        !normalized ||
        [movement.product.name, movement.product.sku, movement.reference, movement.reason]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalized));
      return matchesType && matchesSearch;
    });
  }, [movementType, movementsQuery.data, search]);

  if (!session) return <SessionRequired session={session} />;

  function toggleProduct(product: WarehouseCatalogProduct, activate: boolean) {
    if (!activate) {
      const confirmed = window.confirm(
        `¿Desactivar “${product.name}”? Dejará de estar disponible para nuevas órdenes.`,
      );
      if (!confirmed) return;
    }
    productStatusMutation.mutate({ product, activate });
  }

  return (
    <div className="space-y-5">
      <ModuleHeader
        title="Almacén"
        description="Controla existencias, entradas y entregas B2B sin mezclar el inventario del POS."
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Warehouse} label="Productos activos" value={activeProducts.length} />
        <StatCard icon={Boxes} label="Unidades disponibles" value={formatQuantity(totalUnits)} />
        <StatCard
          icon={AlertTriangle}
          label="Sin stock o bajo mínimo"
          value={lowStockCount}
          tone={lowStockCount ? 'warning' : 'default'}
        />
        <StatCard
          icon={PackageCheck}
          label="Pendientes de entrega"
          value={pendingDispatches.length}
          tone={pendingDispatches.length ? 'primary' : 'default'}
        />
      </section>

      {tab === 'inventory' || tab === 'movements' ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1 lg:max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={
                    tab === 'movements'
                      ? 'Buscar producto, referencia o motivo'
                      : 'Buscar nombre, SKU, código o marca'
                  }
                  className="pl-9"
                  aria-label="Buscar en almacén"
                />
              </div>
              {tab === 'inventory' ? (
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="h-10 rounded-md border border-input bg-card px-3 text-sm"
                  aria-label="Filtrar productos por estado"
                >
                  <option value="ACTIVE">Productos activos</option>
                  <option value="INACTIVE">Productos inactivos</option>
                  <option value="ALL">Todos los estados</option>
                </select>
              ) : null}
              {tab === 'movements' ? (
                <select
                  value={movementType}
                  onChange={(event) => setMovementType(event.target.value)}
                  className="h-10 rounded-md border border-input bg-card px-3 text-sm"
                  aria-label="Filtrar movimientos por tipo"
                >
                  <option value="ALL">Todos los movimientos</option>
                  <option value="PURCHASE">Compra</option>
                  <option value="MANUAL_RECEIPT">Entrada manual</option>
                  <option value="SALE">Venta B2B</option>
                  <option value="DISPATCH">Entrega confirmada</option>
                  <option value="MANUAL_DISPATCH">Salida manual</option>
                  <option value="STOCK_COUNT">Conteo físico</option>
                </select>
              ) : null}
            </div>
            {tab === 'inventory' ? (
              <Button
                type="button"
                onClick={() => setNewProductOpen(true)}
                className="min-h-10 shrink-0"
              >
                <Plus className="h-4 w-4" />
                Nuevo producto
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div
        className="flex gap-1 overflow-x-auto rounded-lg border bg-white p-1"
        role="tablist"
        aria-label="Secciones de almacén"
      >
        <TabButton
          active={tab === 'inventory'}
          onClick={() => setTab('inventory')}
          icon={Warehouse}
        >
          Inventario
        </TabButton>
        {canOperateStock ? (
          <TabButton
            active={tab === 'receiving'}
            onClick={() => setTab('receiving')}
            icon={ArrowDownToLine}
          >
            Recepción
          </TabButton>
        ) : null}
        <TabButton
          active={tab === 'dispatches'}
          onClick={() => setTab('dispatches')}
          icon={PackageCheck}
          count={pendingDispatches.length}
        >
          Órdenes por despachar
        </TabButton>
        <TabButton active={tab === 'movements'} onClick={() => setTab('movements')} icon={History}>
          Movimientos
        </TabButton>
      </div>

      {tab === 'inventory' ? (
        <InventoryPanel
          products={filteredProducts}
          loading={productsQuery.isLoading}
          error={productsQuery.isError}
          canOperateStock={canOperateStock}
          isWarehouseKeeper={isWarehouseKeeper}
          mutationPending={productStatusMutation.isPending}
          onReceive={(product) => setStockAction({ product, mode: 'receive' })}
          onCount={(product) => setStockAction({ product, mode: 'count' })}
          onDispatch={setManualDispatch}
          onToggle={toggleProduct}
        />
      ) : null}

      {tab === 'receiving' && canOperateStock ? (
        <WarehouseReceivingPanel products={products} loading={productsQuery.isLoading} />
      ) : null}

      {tab === 'dispatches' ? (
        <DispatchesPanel
          orders={pendingDispatches}
          loading={pendingDispatchesQuery.isLoading}
          error={pendingDispatchesQuery.isError}
          onDispatch={setOrderDispatch}
        />
      ) : null}

      {tab === 'movements' ? (
        <MovementsPanel
          movements={filteredMovements}
          loading={movementsQuery.isLoading}
          error={movementsQuery.isError}
        />
      ) : null}

      <WarehouseProductFormDialog
        open={newProductOpen}
        onClose={() => setNewProductOpen(false)}
        onSaved={() => setNewProductOpen(false)}
      />
      <WarehouseStockDialog
        product={stockAction ? toDialogProduct(stockAction.product) : null}
        mode={stockAction?.mode ?? 'receive'}
        onClose={() => setStockAction(null)}
      />
      <WarehouseDispatchDialog
        product={manualDispatch ? toDialogProduct(manualDispatch) : null}
        onClose={() => setManualDispatch(null)}
      />
      <WarehouseOrderDispatchDialog order={orderDispatch} onClose={() => setOrderDispatch(null)} />
    </div>
  );
}

function InventoryPanel({
  products,
  loading,
  error,
  canOperateStock,
  isWarehouseKeeper,
  mutationPending,
  onReceive,
  onCount,
  onDispatch,
  onToggle,
}: {
  products: WarehouseCatalogProduct[];
  loading: boolean;
  error: boolean;
  canOperateStock: boolean;
  isWarehouseKeeper: boolean;
  mutationPending: boolean;
  onReceive: (product: WarehouseCatalogProduct) => void;
  onCount: (product: WarehouseCatalogProduct) => void;
  onDispatch: (product: WarehouseCatalogProduct) => void;
  onToggle: (product: WarehouseCatalogProduct, activate: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inventario de almacén</CardTitle>
        <CardDescription>
          Consulta existencias y registra entradas, conteos o salidas no relacionadas con ventas.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState />
        ) : (
          <>
            <div className="grid gap-3 lg:hidden">
              {products.map((product) => {
                const quantity = stockOf(product);
                const active = product.status === 'ACTIVE';
                return (
                  <article
                    key={product.id}
                    className={`rounded-xl border p-4 ${active ? 'bg-card' : 'bg-muted/35 opacity-70'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{product.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {product.sku ?? 'Sin SKU'} · {unitLabel(product.unit)}
                        </p>
                      </div>
                      <StockBadge product={product} />
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Existencia</p>
                        <p className="font-bold">
                          {formatQuantity(quantity)} {unitShortLabel(product.unit)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Precio B2B</p>
                        <p className="font-bold">
                          {formatCurrency(Number(product.salePrice ?? product.price))}
                        </p>
                      </div>
                    </div>
                    {active && canOperateStock ? (
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 px-2"
                          onClick={() => onReceive(product)}
                        >
                          <ArrowDownToLine className="h-4 w-4" /> Entrada
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 px-2"
                          onClick={() => onCount(product)}
                        >
                          <ClipboardCheck className="h-4 w-4" /> Conteo
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 px-2"
                          disabled={quantity <= 0}
                          onClick={() => onDispatch(product)}
                        >
                          <PackageMinus className="h-4 w-4" /> Salida
                        </Button>
                      </div>
                    ) : null}
                    {!isWarehouseKeeper ? (
                      <div className="mt-2 flex justify-end gap-2">
                        <Button asChild type="button" variant="ghost" size="sm">
                          <Link href={`/warehouse/${product.id}/edit`}>
                            <Pencil className="h-4 w-4" /> Editar
                          </Link>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={mutationPending}
                          onClick={() => onToggle(product, !active)}
                        >
                          {active ? (
                            <Trash2 className="h-4 w-4" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                          {active ? 'Desactivar' : 'Reactivar'}
                        </Button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
              {!products.length ? (
                <EmptyState
                  icon={Search}
                  title="Sin resultados"
                  description="No hay productos que coincidan con la búsqueda."
                />
              ) : null}
            </div>
            <div className="surface-scrollbar hidden overflow-x-auto lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Producto</TableHead>
                    <TableHead>SKU / código</TableHead>
                    <TableHead>Existencia</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead className="text-right">Costo</TableHead>
                    <TableHead className="text-right">Precio B2B</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((product) => {
                    const quantity = stockOf(product);
                    const active = product.status === 'ACTIVE';
                    return (
                      <TableRow key={product.id} className={!active ? 'opacity-65' : undefined}>
                        <TableCell>
                          <p className="font-medium">{product.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {product.brand ?? unitLabel(product.unit)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <p>{product.sku ?? '—'}</p>
                          <p className="text-xs text-muted-foreground">
                            {product.barcode ?? 'Sin código de barras'}
                          </p>
                        </TableCell>
                        <TableCell className="font-semibold">
                          {formatQuantity(quantity)} {unitShortLabel(product.unit)}
                        </TableCell>
                        <TableCell>
                          <StockBadge product={product} />
                        </TableCell>
                        <TableCell className="text-right">
                          {product.warehouseStocks[0]?.unitCost
                            ? formatCurrency(Number(product.warehouseStocks[0].unitCost))
                            : '—'}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(Number(product.salePrice ?? product.price))}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex min-w-max justify-end gap-1">
                            {active && canOperateStock ? (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onReceive(product)}
                                  title="Registrar entrada"
                                >
                                  <ArrowDownToLine className="h-4 w-4" /> Entrada
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  onClick={() => onCount(product)}
                                  aria-label={`Aplicar conteo a ${product.name}`}
                                  title="Conteo físico"
                                >
                                  <ClipboardCheck className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  disabled={quantity <= 0}
                                  onClick={() => onDispatch(product)}
                                  aria-label={`Registrar salida manual de ${product.name}`}
                                  title={
                                    quantity <= 0 ? 'Sin existencia disponible' : 'Salida manual'
                                  }
                                >
                                  <PackageMinus className="h-4 w-4" />
                                </Button>
                              </>
                            ) : null}
                            {!isWarehouseKeeper ? (
                              <>
                                <Button asChild type="button" variant="ghost" size="icon">
                                  <Link
                                    href={`/warehouse/${product.id}/edit`}
                                    aria-label={`Editar ${product.name}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Link>
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  disabled={mutationPending}
                                  onClick={() => onToggle(product, !active)}
                                  aria-label={
                                    active
                                      ? `Desactivar ${product.name}`
                                      : `Reactivar ${product.name}`
                                  }
                                  title={active ? 'Desactivar producto' : 'Reactivar producto'}
                                >
                                  {active ? (
                                    <Trash2 className="h-4 w-4" />
                                  ) : (
                                    <RotateCcw className="h-4 w-4" />
                                  )}
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!products.length ? (
                    <EmptyRow
                      colSpan={7}
                      message="No hay productos que coincidan con la búsqueda."
                    />
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DispatchesPanel({
  orders,
  loading,
  error,
  onDispatch,
}: {
  orders: WarehousePendingDispatch[];
  loading: boolean;
  error: boolean;
  onDispatch: (order: WarehousePendingDispatch) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Órdenes cobradas pendientes de entrega</CardTitle>
        <CardDescription>
          El stock ya fue descontado en caja. Confirma aquí únicamente la entrega física.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState />
        ) : orders.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {orders.map((order) => (
              <article key={order.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{order.orderNumber}</p>
                    <p className="text-sm text-muted-foreground">
                      {order.customer?.name ?? order.clientName ?? 'Consumidor final'}
                    </p>
                  </div>
                  <Badge variant="success">Pagada</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>{order.items.length} línea(s)</span>
                  <span>{formatCurrency(Number(order.invoice?.total ?? 0))}</span>
                  <span>
                    {order.completedAt ? formatDate(order.completedAt) : 'Fecha no disponible'}
                  </span>
                </div>
                <Button
                  type="button"
                  className="mt-4 min-h-10 w-full"
                  onClick={() => onDispatch(order)}
                >
                  <PackageCheck className="h-4 w-4" /> Revisar y confirmar entrega
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={CheckCircle2}
            title="Todo entregado"
            description="No hay órdenes B2B cobradas pendientes de entrega."
          />
        )}
      </CardContent>
    </Card>
  );
}

function MovementsPanel({
  movements,
  loading,
  error,
}: {
  movements: WarehouseMovement[];
  loading: boolean;
  error: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Historial de movimientos</CardTitle>
        <CardDescription>
          Entradas, ventas, entregas, salidas manuales y conteos con su responsable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <ErrorState />
        ) : (
          <div className="surface-scrollbar max-h-[36rem] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Producto</TableHead>
                  <TableHead>Movimiento</TableHead>
                  <TableHead className="text-right">Cantidad</TableHead>
                  <TableHead className="text-right">Antes → después</TableHead>
                  <TableHead>Referencia</TableHead>
                  <TableHead>Responsable</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell>{formatDate(movement.createdAt)}</TableCell>
                    <TableCell>
                      <p className="font-medium">{movement.product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {movement.product.sku ?? 'Sin SKU'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={movementVariant(movement.type)}>
                        {warehouseMovementLabel(movement.type)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatQuantity(movement.quantity)}
                    </TableCell>
                    <TableCell className="text-right">
                      {movement.previousQuantity === null || movement.newQuantity === null
                        ? '—'
                        : `${formatQuantity(movement.previousQuantity)} → ${formatQuantity(movement.newQuantity)}`}
                    </TableCell>
                    <TableCell>
                      <p>{movement.reference ?? '—'}</p>
                      <p
                        className="max-w-56 truncate text-xs text-muted-foreground"
                        title={movement.reason ?? undefined}
                      >
                        {movement.reason ?? 'Sin nota'}
                      </p>
                    </TableCell>
                    <TableCell>{movement.createdBy?.name ?? 'Sistema'}</TableCell>
                  </TableRow>
                ))}
                {!movements.length ? (
                  <EmptyRow
                    colSpan={7}
                    message="No hay movimientos que coincidan con los filtros."
                  />
                ) : null}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof Warehouse;
  label: string;
  value: string | number;
  tone?: 'default' | 'warning' | 'primary';
}) {
  return (
    <Card
      className={
        tone === 'warning'
          ? 'border-amber-200 bg-amber-50/60'
          : tone === 'primary'
            ? 'border-primary/25 bg-primary/5'
            : undefined
      }
    >
      <CardContent className="flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border bg-white">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-xl font-bold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Warehouse;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex min-h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
      {children}
      {count ? (
        <span className={`rounded-full px-1.5 text-xs ${active ? 'bg-white/20' : 'bg-muted'}`}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

function StockBadge({ product }: { product: WarehouseCatalogProduct }) {
  if (product.status !== 'ACTIVE') return <Badge variant="outline">Inactivo</Badge>;
  const quantity = stockOf(product);
  if (quantity <= 0) return <Badge variant="danger">Sin stock</Badge>;
  if (quantity <= Number(product.minStock ?? 0)) return <Badge variant="warning">Stock bajo</Badge>;
  return <Badge variant="success">Disponible</Badge>;
}

function LoadingRows() {
  return (
    <div className="space-y-3 py-4" aria-label="Cargando datos">
      <div className="h-12 animate-pulse rounded-lg bg-muted" />
      <div className="h-12 animate-pulse rounded-lg bg-muted" />
      <div className="h-12 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

function ErrorState() {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="No se pudieron cargar los datos"
      description="Verifica la conexión e intenta actualizar la página."
    />
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Warehouse;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-12 text-center text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  );
}

function stockOf(product: WarehouseCatalogProduct) {
  return product.warehouseStocks[0]?.quantity ?? 0;
}

function toDialogProduct(product: WarehouseCatalogProduct) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    unit: product.unit,
    cost: product.cost,
    available: stockOf(product),
  };
}

function unitShortLabel(unit: string) {
  return (
    (
      {
        UNIT: 'ud.',
        BOX: 'caja',
        PACK: 'paq.',
        BAG: 'bolsa',
        ROLL: 'rollo',
        METER: 'm',
        FOOT: 'pie',
        YARD: 'yd',
        POUND: 'lb',
        GALLON: 'gal',
        LITER: 'L',
        KILOGRAM: 'kg',
      } as Record<string, string>
    )[unit] ?? unit.toLowerCase()
  );
}

function unitLabel(unit: string) {
  return (
    (
      {
        UNIT: 'Unidad',
        BOX: 'Caja',
        PACK: 'Paquete',
        BAG: 'Bolsa',
        ROLL: 'Rollo',
        METER: 'Metro',
        FOOT: 'Pie',
        YARD: 'Yarda',
        POUND: 'Libra',
        GALLON: 'Galón',
        LITER: 'Litro',
        KILOGRAM: 'Kilogramo',
      } as Record<string, string>
    )[unit] ?? unit
  );
}

function warehouseMovementLabel(type: string) {
  const labels: Record<string, string> = {
    PURCHASE: 'Entrada por compra',
    SALE: 'Venta B2B',
    MANUAL_RECEIPT: 'Entrada manual',
    MANUAL_DISPATCH: 'Salida manual',
    STOCK_COUNT: 'Conteo físico',
    DISPATCH: 'Entrega confirmada',
    ADJUSTMENT_IN: 'Existencia inicial',
    ADJUSTMENT_OUT: 'Reversión',
  };
  return labels[type] ?? type;
}

function movementVariant(type: string): 'success' | 'danger' | 'warning' | 'outline' {
  if (['PURCHASE', 'MANUAL_RECEIPT', 'ADJUSTMENT_IN'].includes(type)) return 'success';
  if (['SALE', 'MANUAL_DISPATCH', 'ADJUSTMENT_OUT'].includes(type)) return 'danger';
  if (type === 'STOCK_COUNT') return 'warning';
  return 'outline';
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  Factory,
  Gift,
  Home,
  Globe2,
  Package,
  Search,
  ShoppingCart,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  approveOrderDesign,
  approveOrderQuality,
  addCorporateOrderUnits,
  getProductionKanban,
  importCorporateOrderUnits,
  updateCorporateOrderUnit,
  removeCorporateOrderUnit,
  updateOrderWorkflow,
  type OrderExceptionStatus,
  type ProductionStage,
  type ProductionBoardOrder,
} from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { trapModalFocus } from './modal-focus';
import { SessionRequired, useCurrentSession } from './session-required';

const columns: Array<{
  stage: ProductionStage;
  label: string;
  summary: string;
  icon: typeof Clock3;
  tone: string;
  iconTone: string;
  badge: 'warning' | 'info' | 'ready' | 'success';
}> = [
  {
    stage: 'WAITING',
    label: 'En espera',
    summary: 'En espera',
    icon: Clock3,
    tone: 'bg-amber-50/80 text-amber-900',
    iconTone: 'bg-amber-100 text-amber-700',
    badge: 'warning',
  },
  {
    stage: 'FACTORY',
    label: 'En fábrica',
    summary: 'En fábrica',
    icon: Factory,
    tone: 'bg-blue-50/80 text-blue-900',
    iconTone: 'bg-blue-100 text-blue-700',
    badge: 'info',
  },
  {
    stage: 'READY',
    label: 'Lista para entregar',
    summary: 'Listas para entregar',
    icon: Package,
    tone: 'bg-violet-50/80 text-violet-900',
    iconTone: 'bg-violet-100 text-violet-700',
    badge: 'ready',
  },
  {
    stage: 'DELIVERED',
    label: 'Entregada',
    summary: 'Entregadas',
    icon: CheckCircle2,
    tone: 'bg-emerald-50/80 text-emerald-900',
    iconTone: 'bg-emerald-100 text-emerald-700',
    badge: 'success',
  },
];

type DeliveryPeriod = 'ALL' | 'MONTH' | 'WEEK_1' | 'WEEK_2' | 'WEEK_3' | 'WEEK_4';
type DetailTab = 'summary' | 'products' | 'history' | 'notes';
type UnitStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
type WorkflowPayload = Parameters<typeof updateOrderWorkflow>[3];

const deliveryDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santo_Domingo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function deliveryDateKey(value: string | Date) {
  const parts = deliveryDateFormatter.formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function stageLabel(stage: ProductionStage) {
  return columns.find((column) => column.stage === stage)?.label ?? stage;
}

function exceptionLabel(status: OrderExceptionStatus) {
  return { NONE: 'Sin novedad', PAUSED: 'Pausada', PROBLEM: 'Problema', CANCELLED: 'Cancelada' }[
    status
  ];
}

function nextStageFor(order: ProductionBoardOrder): ProductionStage | undefined {
  if (order.productionStage === 'WAITING') return order.requiresProduction ? 'FACTORY' : 'READY';
  if (order.productionStage === 'FACTORY') return 'READY';
  if (order.productionStage === 'READY') return 'DELIVERED';
  return undefined;
}

function previousStageFor(order: ProductionBoardOrder): ProductionStage | undefined {
  if (order.productionStage === 'FACTORY') return 'WAITING';
  if (order.productionStage === 'READY') return order.requiresProduction ? 'FACTORY' : 'WAITING';
  return undefined;
}

function advanceBlockers(order: ProductionBoardOrder) {
  const next = nextStageFor(order);
  if (!next) return [];
  const reasons: string[] = [];
  if (order.status !== 'COMPLETED') reasons.push('La orden debe estar facturada y cobrada.');
  if (next === 'DELIVERED' && !order.invoiceId)
    reasons.push('La orden necesita una factura vigente para entregarse.');
  return reasons;
}

export function ProductionKanban() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'ALL' | 'STORE' | 'SHOPIFY'>('ALL');
  const [exception, setException] = useState<'ALL' | OrderExceptionStatus>('ALL');
  const [deliveryPeriod, setDeliveryPeriod] = useState<DeliveryPeriod>('ALL');
  const [deliveryMonth, setDeliveryMonth] = useState(() => deliveryDateKey(new Date()).slice(0, 7));
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [mobileStage, setMobileStage] = useState<ProductionStage>('WAITING');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [draggedOrderId, setDraggedOrderId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<ProductionStage | null>(null);
  const [recentlyMovedOrderId, setRecentlyMovedOrderId] = useState<string | null>(null);
  const [movingOrderIds, setMovingOrderIds] = useState<Set<string>>(() => new Set());
  const moveAnimationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmation, setConfirmation] = useState<{
    order: ProductionBoardOrder;
    payload: WorkflowPayload;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const boardKey = ['production-kanban', session?.tenantId] as const;
  const boardQuery = useQuery({
    queryKey: boardKey,
    queryFn: () => getProductionKanban(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
    refetchInterval: movingOrderIds.size ? false : 15_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['production-kanban'] });
  useEffect(
    () => () => {
      if (moveAnimationTimer.current) clearTimeout(moveAnimationTimer.current);
    },
    [],
  );
  function showMoveAnimation(orderId: string) {
    setRecentlyMovedOrderId(orderId);
    if (moveAnimationTimer.current) clearTimeout(moveAnimationTimer.current);
    moveAnimationTimer.current = setTimeout(() => setRecentlyMovedOrderId(null), 650);
  }
  const workflowMutation = useMutation({
    mutationFn: ({ order, payload }: { order: ProductionBoardOrder; payload: WorkflowPayload }) =>
      updateOrderWorkflow(session!.tenantId, session!.accessToken, order.id, payload),
    onMutate: ({ order, payload }) => {
      const previous = queryClient
        .getQueryData<ProductionBoardOrder[]>(boardKey)
        ?.find((item) => item.id === order.id);
      if (payload.stage) {
        void queryClient.cancelQueries({ queryKey: boardKey, exact: true });
        setMovingOrderIds((current) => new Set(current).add(order.id));
        queryClient.setQueryData<ProductionBoardOrder[]>(boardKey, (current) =>
          current?.map((item) =>
            item.id === order.id
              ? {
                  ...item,
                  productionStage: payload.stage!,
                  deliveredAt: payload.stage === 'DELIVERED' ? new Date().toISOString() : null,
                }
              : item,
          ),
        );
        showMoveAnimation(order.id);
      } else if (payload.requiresProduction !== undefined) {
        queryClient.setQueryData<ProductionBoardOrder[]>(boardKey, (current) =>
          current?.map((item) =>
            item.id === order.id
              ? { ...item, requiresProduction: payload.requiresProduction! }
              : item,
          ),
        );
      }
      return { previous };
    },
    onSuccess: () => {
      toast.success('Orden actualizada.');
      void refresh();
    },
    onError: (error, { order, payload }, context) => {
      if ((payload.stage || payload.requiresProduction !== undefined) && context?.previous) {
        queryClient.setQueryData<ProductionBoardOrder[]>(boardKey, (current) =>
          current?.map((item) =>
            item.id === order.id
              ? {
                  ...item,
                  productionStage: context.previous!.productionStage,
                  deliveredAt: context.previous!.deliveredAt,
                  requiresProduction: context.previous!.requiresProduction,
                }
              : item,
          ),
        );
        showMoveAnimation(order.id);
      }
      showError(error);
      void refresh();
    },
    onSettled: (_result, _error, { order, payload }) => {
      if (payload.stage)
        setMovingOrderIds((current) => {
          const next = new Set(current);
          next.delete(order.id);
          return next;
        });
    },
  });
  const approvalMutation = useMutation({
    mutationFn: ({ order, type }: { order: ProductionBoardOrder; type: 'design' | 'quality' }) =>
      type === 'design'
        ? approveOrderDesign(session!.tenantId, session!.accessToken, order.id)
        : approveOrderQuality(session!.tenantId, session!.accessToken, order.id),
    onSuccess: async () => {
      await refresh();
      toast.success('Aprobación registrada.');
    },
    onError: showError,
  });
  const addUnitsMutation = useMutation({
    mutationFn: ({
      orderId,
      lines,
      itemId,
    }: {
      orderId: string;
      lines: string;
      itemId?: string;
    }) => {
      const units = lines
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [recipientName, ...messageParts] = line.split('|');
          return {
            recipientName: recipientName.trim(),
            salesOrderItemId: itemId,
            message: messageParts.join('|').trim() || undefined,
          };
        })
        .filter((unit) => unit.recipientName);
      if (!units.length) throw new Error('Escribe al menos un destinatario.');
      return addCorporateOrderUnits(session!.tenantId, session!.accessToken, orderId, units);
    },
    onSuccess: async () => {
      await refresh();
      toast.success('Unidades empresariales agregadas.');
    },
    onError: showError,
  });
  const updateUnitMutation = useMutation({
    mutationFn: ({
      orderId,
      unitId,
      status,
      delivered,
      recipientName,
      message,
    }: {
      orderId: string;
      unitId: string;
      status: UnitStatus;
      delivered?: boolean;
      recipientName?: string;
      message?: string;
    }) =>
      updateCorporateOrderUnit(session!.tenantId, session!.accessToken, orderId, unitId, {
        status,
        delivered,
        recipientName,
        message,
      }),
    onSuccess: refresh,
    onError: showError,
  });
  const removeUnitMutation = useMutation({
    mutationFn: ({ orderId, unitId }: { orderId: string; unitId: string }) =>
      removeCorporateOrderUnit(session!.tenantId, session!.accessToken, orderId, unitId),
    onSuccess: refresh,
    onError: showError,
  });
  const importUnitsMutation = useMutation({
    mutationFn: ({ orderId, file }: { orderId: string; file: File }) =>
      importCorporateOrderUnits(session!.tenantId, session!.accessToken, orderId, file),
    onSuccess: async () => {
      await refresh();
      toast.success('Destinatarios importados desde Excel.');
    },
    onError: showError,
  });

  const orders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (boardQuery.data ?? []).filter((order) => {
      if (source !== 'ALL' && order.source !== source) return false;
      if (exception !== 'ALL' && order.exceptionStatus !== exception) return false;
      if (deliveryPeriod !== 'ALL') {
        if (!deliveryMonth || !order.promisedAt) return false;
        const promisedDate = deliveryDateKey(order.promisedAt);
        if (!promisedDate.startsWith(`${deliveryMonth}-`)) return false;
        if (deliveryPeriod !== 'MONTH') {
          const day = Number(promisedDate.slice(-2));
          if (deliveryPeriod !== `WEEK_${Math.min(Math.ceil(day / 7), 4)}`) return false;
        }
      }
      if (!normalized) return true;
      return [order.orderNumber, order.clientName, order.invoice?.invoiceNumber]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalized));
    });
  }, [boardQuery.data, deliveryMonth, deliveryPeriod, exception, query, source]);

  const selectedOrder = boardQuery.data?.find((order) => order.id === selectedOrderId) ?? null;
  const factoryView = session?.role === 'WAREHOUSE_KEEPER';
  const pending =
    workflowMutation.isPending ||
    approvalMutation.isPending ||
    addUnitsMutation.isPending ||
    updateUnitMutation.isPending ||
    removeUnitMutation.isPending ||
    importUnitsMutation.isPending;

  function requestWorkflow(order: ProductionBoardOrder, payload: WorkflowPayload) {
    if (movingOrderIds.has(order.id)) return;
    if (payload.stage === 'DELIVERED' || payload.exceptionStatus === 'CANCELLED') {
      setConfirmation({ order, payload });
      setCancelReason('');
      return;
    }
    workflowMutation.mutate({ order, payload });
  }

  if (!session) return <SessionRequired session={session} />;

  return (
    <div
      className={`min-w-0 space-y-5 pb-4 transition-[margin] duration-200 ${selectedOrder ? 'xl:mr-[25rem]' : ''}`}
    >
      <nav
        aria-label="Ruta de navegación"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Link href="/dashboard" className="inline-flex items-center gap-1 hover:text-gold-deep">
          <Home className="h-3.5 w-3.5" /> Panel
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="font-semibold text-foreground">Producción y despacho</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[34px] font-semibold leading-none text-foreground sm:text-4xl">
            Producción y despacho
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Una tarjeta por orden, desde la espera hasta la entrega.
          </p>
        </div>
        {!factoryView ? (
          <Button asChild size="sm">
            <Link href="/orders">
              Nueva orden <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}
      </div>

      <section
        aria-label="Resumen de las órdenes cargadas"
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))' }}
      >
        {columns.map((column) => {
          const count = orders.filter((order) => order.productionStage === column.stage).length;
          const Icon = column.icon;
          return (
            <button
              key={column.stage}
              type="button"
              onClick={() => {
                setMobileStage(column.stage);
                document
                  .getElementById(`production-${column.stage}`)
                  ?.scrollIntoView({ block: 'nearest' });
              }}
              className={`flex min-w-0 items-center gap-3 rounded-xl border border-border/70 p-3 text-left transition hover:border-gold/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4 ${column.tone}`}
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${column.iconTone}`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-xl font-bold leading-tight sm:text-2xl">{count}</span>
                <span className="block text-xs font-medium sm:text-sm">{column.summary}</span>
              </span>
              <ChevronRight className="ml-auto hidden h-4 w-4 shrink-0 sm:block" />
            </button>
          );
        })}
      </section>
      <p className="-mt-2 text-xs text-muted-foreground">
        Conteos de las órdenes cargadas con los filtros actuales; no representan un histórico
        completo.
      </p>

      <section
        aria-label="Filtros de producción"
        className="rounded-xl border border-border bg-card p-3 shadow-sm"
      >
        <div
          className={`grid gap-2 sm:grid-cols-2 ${selectedOrder ? '' : 'xl:grid-cols-[minmax(13rem,1fr)_11rem_11rem_auto]'}`}
        >
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold-deep" />
            <Input
              aria-label="Buscar orden, cliente o factura"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar orden, cliente o factura"
              className="h-10 pl-9"
            />
          </div>
          <select
            aria-label="Canal"
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
            className="h-10 min-w-0 rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ALL">Todos los canales</option>
            <option value="STORE">Tienda</option>
            <option value="SHOPIFY">Shopify</option>
          </select>
          <select
            aria-label="Incidencia"
            value={exception}
            onChange={(event) => setException(event.target.value as typeof exception)}
            className="h-10 min-w-0 rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ALL">Todos los estados</option>
            <option value="NONE">Sin novedad</option>
            <option value="PAUSED">Pausadas</option>
            <option value="PROBLEM">Con problema</option>
            <option value="CANCELLED">Canceladas</option>
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={moreFiltersOpen}
            onClick={() => setMoreFiltersOpen((open) => !open)}
          >
            <CalendarDays className="h-4 w-4" /> Fecha de entrega
            {deliveryPeriod !== 'ALL' ? ' · activo' : ''}
          </Button>
        </div>
        {moreFiltersOpen ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-sm font-semibold">Fecha prometida</span>
            <select
              aria-label="Período de entrega"
              value={deliveryPeriod}
              onChange={(event) => setDeliveryPeriod(event.target.value as DeliveryPeriod)}
              className="h-10 min-w-[11rem] flex-1 rounded-md border border-input bg-card px-3 text-sm sm:max-w-56"
            >
              <option value="ALL">Todas las fechas</option>
              <option value="MONTH">Mes completo</option>
              <option value="WEEK_1">Semana 1 (1–7)</option>
              <option value="WEEK_2">Semana 2 (8–14)</option>
              <option value="WEEK_3">Semana 3 (15–21)</option>
              <option value="WEEK_4">Semana 4 (22–fin)</option>
            </select>
            <Input
              aria-label="Mes de entrega"
              type="month"
              value={deliveryMonth}
              onChange={(event) => {
                setDeliveryMonth(event.target.value);
                if (!event.target.value) setDeliveryPeriod('ALL');
                else if (deliveryPeriod === 'ALL') setDeliveryPeriod('MONTH');
              }}
              className="h-10 w-40"
            />
          </div>
        ) : null}
      </section>

      {boardQuery.isLoading ? (
        <div
          role="status"
          className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground"
        >
          Cargando órdenes...
        </div>
      ) : null}
      {boardQuery.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/25 bg-danger/5 p-4 text-sm text-danger"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> No se pudo cargar la cola de órdenes.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void boardQuery.refetch()}
          >
            Reintentar
          </Button>
        </div>
      ) : null}

      {!boardQuery.isError ? (
        <>
          <div
            className="flex gap-2 overflow-x-auto pb-1 md:hidden"
            aria-label="Estado de producción"
          >
            {columns.map((column) => (
              <button
                key={column.stage}
                type="button"
                onClick={() => setMobileStage(column.stage)}
                aria-pressed={mobileStage === column.stage}
                className={`min-h-10 shrink-0 rounded-md border px-3 text-sm font-semibold ${mobileStage === column.stage ? 'border-gold-dark bg-gold-light/25 text-gold-deep' : 'border-border bg-card text-muted-foreground'}`}
              >
                {column.label} ·{' '}
                {orders.filter((order) => order.productionStage === column.stage).length}
              </button>
            ))}
          </div>
          <div
            className="grid min-w-0 items-start gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))' }}
          >
            {columns.map((column) => {
              const columnOrders = orders.filter((order) => order.productionStage === column.stage);
              return (
                <section
                  id={`production-${column.stage}`}
                  key={column.stage}
                  onDragOver={(event) => {
                    if (draggedOrderId) {
                      event.preventDefault();
                      setDropStage(column.stage);
                    }
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node))
                      setDropStage((current) => (current === column.stage ? null : current));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const id = event.dataTransfer.getData('text/plain') || draggedOrderId;
                    const order = boardQuery.data?.find((item) => item.id === id);
                    setDraggedOrderId(null);
                    setDropStage(null);
                    if (
                      order &&
                      order.productionStage !== column.stage &&
                      order.status === 'COMPLETED'
                    )
                      requestWorkflow(order, { stage: column.stage });
                  }}
                  className={`${mobileStage === column.stage ? '' : 'hidden'} min-w-0 rounded-xl border bg-card/55 p-2 md:block ${dropStage === column.stage ? 'kanban-drop-target border-gold-dark bg-gold-light/15' : 'border-border/80'}`}
                >
                  <div
                    className={`flex items-center justify-between rounded-lg px-3 py-3 ${column.tone}`}
                  >
                    <h2 className="text-sm font-bold">{column.label}</h2>
                    <span className="rounded-md bg-white/80 px-2 py-0.5 text-xs font-bold">
                      {columnOrders.length}
                    </span>
                  </div>
                  <div className="mt-2 space-y-2">
                    {columnOrders.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        factoryView={factoryView}
                        selected={selectedOrderId === order.id}
                        dragging={draggedOrderId === order.id}
                        justMoved={recentlyMovedOrderId === order.id}
                        saving={movingOrderIds.has(order.id)}
                        onOpen={() => setSelectedOrderId(order.id)}
                        onDragStart={(event) => {
                          event.dataTransfer.setData('text/plain', order.id);
                          event.dataTransfer.effectAllowed = 'move';
                          setDraggedOrderId(order.id);
                        }}
                        onDragEnd={() => {
                          setDraggedOrderId(null);
                          setDropStage(null);
                        }}
                      />
                    ))}
                    {!columnOrders.length ? (
                      <p className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
                        Sin órdenes en esta etapa
                        {query ||
                        source !== 'ALL' ||
                        exception !== 'ALL' ||
                        deliveryPeriod !== 'ALL'
                          ? ' para estos filtros'
                          : ''}
                        .
                      </p>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      ) : null}

      {selectedOrder ? (
        <OrderDrawer
          key={selectedOrder.id}
          order={selectedOrder}
          factoryView={factoryView}
          pending={pending}
          onClose={() => setSelectedOrderId(null)}
          onWorkflow={(payload) => requestWorkflow(selectedOrder, payload)}
          onAssignment={(assigned) =>
            requestWorkflow(selectedOrder, { requiresProduction: assigned })
          }
          onApprove={(type) => approvalMutation.mutate({ order: selectedOrder, type })}
          onAddUnits={(lines, itemId) =>
            addUnitsMutation.mutate({ orderId: selectedOrder.id, lines, itemId })
          }
          onRemoveUnit={(unitId) =>
            removeUnitMutation.mutate({ orderId: selectedOrder.id, unitId })
          }
          onImportUnits={(file) => importUnitsMutation.mutate({ orderId: selectedOrder.id, file })}
          onUpdateUnit={(unitId, status, delivered, recipientName, message) =>
            updateUnitMutation.mutate({
              orderId: selectedOrder.id,
              unitId,
              status,
              delivered,
              recipientName,
              message,
            })
          }
        />
      ) : null}
      <ActionDialog
        open={Boolean(confirmation)}
        title={
          confirmation?.payload.stage === 'DELIVERED'
            ? 'Confirmar entrega de la orden'
            : 'Cancelar la orden'
        }
        description={
          confirmation?.payload.stage === 'DELIVERED'
            ? 'Esto confirma que la orden fue entregada al cliente y actualiza su etapa en Producción.'
            : 'La cancelación es una acción sensible. Confirma que deseas continuar.'
        }
        tone={confirmation?.payload.stage === 'DELIVERED' ? 'success' : 'danger'}
        confirmLabel={
          confirmation?.payload.stage === 'DELIVERED' ? 'Marcar entregada' : 'Cancelar orden'
        }
        isPending={workflowMutation.isPending}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation) return;
          const payload =
            confirmation.payload.exceptionStatus === 'CANCELLED'
              ? { ...confirmation.payload, note: cancelReason.trim() || undefined }
              : confirmation.payload;
          workflowMutation.mutate(
            { order: confirmation.order, payload },
            { onSuccess: () => setConfirmation(null) },
          );
        }}
      >
        {confirmation?.payload.exceptionStatus === 'CANCELLED' ? (
          <textarea
            aria-label="Motivo de cancelación"
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Motivo de cancelación (opcional)"
            className="w-full rounded-md border border-input bg-card p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : null}
      </ActionDialog>
    </div>
  );
}

function OrderCard({
  order,
  factoryView,
  selected,
  dragging,
  justMoved,
  saving,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  order: ProductionBoardOrder;
  factoryView: boolean;
  selected: boolean;
  dragging: boolean;
  justMoved: boolean;
  saving: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const late = Boolean(
    order.promisedAt &&
    deliveryDateKey(order.promisedAt) < deliveryDateKey(new Date()) &&
    order.productionStage !== 'DELIVERED',
  );
  const completed = order.corporateUnits.filter((unit) => unit.status === 'COMPLETED').length;
  const inProgress = order.corporateUnits.filter((unit) => unit.status === 'IN_PROGRESS').length;
  return (
    <article
      draggable={order.status === 'COMPLETED' && !saving}
      aria-busy={saving}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`w-full min-w-0 rounded-lg border bg-card p-3 text-left shadow-[0_2px_8px_rgb(16_22_35/0.04)] transition-[transform,opacity,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-gold/80 hover:shadow-md ${saving ? 'cursor-progress' : order.status === 'COMPLETED' ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging ? 'kanban-card-dragging' : ''} ${justMoved ? 'kanban-card-arrived' : ''} ${selected ? 'border-gold-dark' : 'border-border'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href="/warehouse"
          title="Ir a Fábrica"
          className="min-w-0 break-all text-xs font-bold text-foreground underline-offset-2 hover:text-gold-deep hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {order.orderNumber}
        </Link>
        {order.priority === 'URGENT' ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-label="Urgente" />
        ) : null}
      </div>
      {saving ? <p className="mt-1 text-xs font-semibold text-gold-deep">Sincronizando…</p> : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Ver detalles de ${order.orderNumber}`}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {order.productionStage === 'WAITING' && order.status !== 'COMPLETED' ? (
          <p className="mt-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-center text-xs font-extrabold tracking-wide text-red-700">
            PENDIENTE DE COBRO
          </p>
        ) : null}
        <p className="mt-1 truncate text-sm font-semibold">
          {order.clientName || order.customer?.name || 'Cliente general'}
        </p>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {order.items[0]?.description ?? 'Sin productos'}
          {order.items.length > 1 ? ` y ${order.items.length - 1} más` : ''}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{order.items.length} producto(s)</span>
          {!factoryView && order.total != null ? (
            <span className="font-semibold text-foreground">
              {formatCurrency(Number(order.total))}
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {order.isCorporate ? <Badge variant="outline">Empresarial</Badge> : null}
          {late ? <Badge variant="danger">Atrasada</Badge> : null}
          {order.exceptionStatus !== 'NONE' ? (
            <Badge
              variant={
                order.exceptionStatus === 'PROBLEM' || order.exceptionStatus === 'CANCELLED'
                  ? 'danger'
                  : 'warning'
              }
            >
              {exceptionLabel(order.exceptionStatus)}
            </Badge>
          ) : null}
        </div>
        <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" /> Prometida: {formatDate(order.promisedAt)}
        </p>
        <p className="mt-2">
          <span
            title={order.source === 'SHOPIFY' ? 'Pedido de Ecommerce' : 'Venta de Tienda'}
            className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-bold ${order.source === 'SHOPIFY' ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-900'}`}
          >
            {order.source === 'SHOPIFY' ? (
              <Globe2 className="h-5 w-5 text-sky-700" aria-hidden="true" />
            ) : (
              <ShoppingCart className="h-5 w-5 text-amber-700" aria-hidden="true" />
            )}
            {order.source === 'SHOPIFY' ? 'Ecommerce' : 'Tienda'}
          </span>
        </p>
        {order.requiresProduction ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {order.designApprovedAt ? 'Diseño aprobado' : 'Diseño pendiente'} ·{' '}
            {order.qualityApprovedAt ? 'Calidad aprobada' : 'Calidad pendiente'}
          </p>
        ) : null}
        {order.isCorporate ? (
          <div className="mt-3 rounded-md bg-muted/70 p-2 text-xs">
            <p className="font-semibold">
              {completed} terminadas · {inProgress} en progreso ·{' '}
              {order.corporateUnits.filter((unit) => unit.status === 'PENDING').length} pendientes
            </p>
            {order.corporateUnits.length ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-gold-dark"
                  style={{
                    width: `${Math.round((completed / order.corporateUnits.length) * 100)}%`,
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </button>
    </article>
  );
}

function OrderDrawer({
  order,
  factoryView,
  pending,
  onClose,
  onWorkflow,
  onAssignment,
  onApprove,
  onAddUnits,
  onRemoveUnit,
  onImportUnits,
  onUpdateUnit,
}: {
  order: ProductionBoardOrder;
  factoryView: boolean;
  pending: boolean;
  onClose: () => void;
  onWorkflow: (payload: WorkflowPayload) => void;
  onAssignment: (assigned: boolean) => void;
  onApprove: (type: 'design' | 'quality') => void;
  onAddUnits: (lines: string, itemId?: string) => void;
  onRemoveUnit: (unitId: string) => void;
  onImportUnits: (file: File) => void;
  onUpdateUnit: (
    unitId: string,
    status: UnitStatus,
    delivered?: boolean,
    recipientName?: string,
    message?: string,
  ) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [docked, setDocked] = useState(false);
  const [tab, setTab] = useState<DetailTab>('summary');
  const [productionNote, setProductionNote] = useState(order.productionNotes ?? '');
  const [unitLines, setUnitLines] = useState('');
  const [unitItemId, setUnitItemId] = useState(order.items[0]?.id ?? '');
  const [corporateOpen, setCorporateOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const updateDocked = () => setDocked(media.matches);
    updateDocked();
    setMounted(true);
    media.addEventListener('change', updateDocked);
    return () => media.removeEventListener('change', updateDocked);
  }, []);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    setProductionNote(order.productionNotes ?? '');
  }, [order.productionNotes]);
  useEffect(() => {
    setUnitLines('');
  }, [order.corporateUnits.length]);
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (!docked) document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (docked && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1) return;
      if (event.key === 'Escape') onCloseRef.current();
      if (!docked) trapModalFocus(event, drawerRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = oldOverflow;
      previousFocus?.focus?.();
    };
  }, [docked]);

  if (!mounted) return null;
  const next = nextStageFor(order);
  const previous = previousStageFor(order);
  const blockers = advanceBlockers(order);
  const designPending =
    !order.designApprovedAt && order.items.some((item) => item.product?.kind === 'PERSONALIZED');
  const stage = columns.find((column) => column.stage === order.productionStage)!;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex justify-end xl:pointer-events-none"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Cerrar detalle de la orden"
        onClick={onClose}
        className="absolute inset-0 bg-navy/25 backdrop-blur-[1px] xl:hidden"
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal={!docked}
        aria-label={`Detalle de ${order.orderNumber}`}
        className="relative flex h-dvh w-full min-w-0 flex-col border-l border-border bg-card shadow-[-12px_0_35px_rgb(16_26_48/0.12)] sm:w-[min(31rem,88vw)] xl:pointer-events-auto xl:mt-16 xl:h-[calc(100dvh-4rem)] xl:w-[25rem]"
      >
        <header className="shrink-0 border-b border-border bg-card px-4 pb-0 pt-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Badge variant={stage.badge}>{stage.label}</Badge>
              <h2 className="mt-2 break-all text-base font-bold leading-tight text-foreground">
                {order.orderNumber}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDate(order.createdAt)} · Canal:{' '}
                {order.source === 'SHOPIFY' ? 'Shopify' : 'Tienda'}
              </p>
            </div>
            <Button
              ref={closeRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Cerrar detalle"
              onClick={onClose}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div
            role="tablist"
            aria-label="Secciones de la orden"
            className="-mb-px mt-4 flex overflow-x-auto"
          >
            {(
              [
                ['summary', 'Resumen'],
                ['products', `Productos (${order.items.length})`],
                ['history', 'Historial'],
                ['notes', 'Notas'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`min-h-11 shrink-0 border-b-2 px-3 text-xs font-semibold transition-colors sm:text-sm ${tab === id ? 'border-gold-dark text-gold-deep' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {tab === 'summary' ? (
            <>
              <DetailSection title="Cliente">
                <p className="text-sm font-semibold">
                  {order.clientName || order.customer?.name || 'Cliente general'}
                </p>
                {order.deliveryPhone ? (
                  <p className="mt-1 text-sm text-muted-foreground">{order.deliveryPhone}</p>
                ) : null}
              </DetailSection>
              <DetailSection title="Información de la orden">
                <DetailRow
                  label="Canal"
                  value={order.source === 'SHOPIFY' ? 'Shopify' : 'Tienda'}
                />
                <DetailRow label="Estado" value={stageLabel(order.productionStage)} />
                <DetailRow label="Fecha de creación" value={formatDate(order.createdAt)} />
                <DetailRow label="Fecha prometida" value={formatDate(order.promisedAt)} />
                {order.deliveredAt ? (
                  <DetailRow label="Fecha de entrega" value={formatDate(order.deliveredAt)} />
                ) : null}
                <DetailRow
                  label="Prioridad"
                  value={order.priority === 'URGENT' ? 'Urgente' : 'Normal'}
                />
                <DetailRow label="Incidencia" value={exceptionLabel(order.exceptionStatus)} />
                <DetailRow
                  label="Tipo"
                  value={
                    order.items.some((item) => item.product?.kind === 'PERSONALIZED')
                      ? 'Personalizada'
                      : 'Normal'
                  }
                />
                <DetailRow
                  label="Trabajo de Fábrica"
                  value={order.requiresProduction ? 'Sí' : 'No'}
                />
                {!factoryView &&
                order.productionStage === 'WAITING' &&
                !order.items.some((item) => item.product?.kind === 'PERSONALIZED') ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full"
                    disabled={pending || order.status === 'CANCELLED'}
                    onClick={() => onAssignment(!order.requiresProduction)}
                  >
                    {order.requiresProduction ? 'Quitar de Fábrica' : 'Enviar a Fábrica'}
                  </Button>
                ) : null}
                {order.requiresProduction ? (
                  <>
                    <DetailRow
                      label="Diseño"
                      value={order.designApprovedAt ? 'Aprobado' : 'Pendiente'}
                    />
                    <DetailRow
                      label="Calidad"
                      value={order.qualityApprovedAt ? 'Aprobada' : 'Pendiente'}
                    />
                  </>
                ) : null}
              </DetailSection>
              <DetailSection title="Entrega y despacho">
                <DetailRow
                  label="Método"
                  value={
                    order.deliveryMethod === 'PICKUP'
                      ? 'Recogida'
                      : order.deliveryMethod === 'DELIVERY'
                        ? 'Delivery'
                        : 'Envío a provincia'
                  }
                />
                <DetailRow
                  label="Ubicación"
                  value={order.dispatchLocation === 'FACTORY' ? 'Fábrica' : 'Tienda'}
                />
                {order.deliveryAddress ? (
                  <p className="text-sm text-muted-foreground">
                    Dirección: {order.deliveryAddress}
                  </p>
                ) : null}
                {order.dispatchLocation === 'FACTORY' ? (
                  <p className="mt-2 rounded-md bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                    Fábrica gestiona los trabajos de personalización. Confirma la entrega al
                    cliente desde Producción y despacho.
                  </p>
                ) : null}
              </DetailSection>
              <DetailSection title="Productos">
                {order.items.map((item) => (
                  <p key={item.id} className="text-sm">
                    {Number(item.quantity)} × {item.description}
                  </p>
                ))}
              </DetailSection>
              {!factoryView && order.total != null ? (
                <DetailSection title="Total de la orden">
                  <p className="text-lg font-bold text-gold-deep">
                    {formatCurrency(Number(order.total))}
                  </p>
                </DetailSection>
              ) : null}
              {!factoryView && order.invoiceId ? (
                <Button asChild variant="outline" className="w-full">
                  <Link href={`/invoices/${order.invoiceId}`}>
                    <ExternalLink className="h-4 w-4" /> Ver factura
                  </Link>
                </Button>
              ) : null}
            </>
          ) : null}

          {tab === 'products' ? (
            <>
              <DetailSection title="Productos y personalización">
                <div className="space-y-2">
                  {order.items.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-md border border-border bg-background p-3"
                    >
                      <p className="text-sm font-semibold">
                        {Number(item.quantity)} × {item.description}
                      </p>
                      {item.personalization ? (
                        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {item.personalization.charms !== undefined ? (
                            <p>Dijes: {item.personalization.charms}</p>
                          ) : null}
                          {item.personalization.children !== undefined ? (
                            <p>Niños: {item.personalization.children}</p>
                          ) : null}
                          {item.personalization.material ? (
                            <p>Material: {item.personalization.material}</p>
                          ) : null}
                          {item.personalization.instructions ? (
                            <p>Instrucciones: {item.personalization.instructions}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </DetailSection>
              {order.isCorporate ? (
                <DetailSection title="Regalos empresariales">
                  <p className="text-sm text-muted-foreground">
                    {order.corporateUnits.filter((unit) => unit.status === 'COMPLETED').length}{' '}
                    terminadas ·{' '}
                    {order.corporateUnits.filter((unit) => unit.status === 'IN_PROGRESS').length} en
                    progreso ·{' '}
                    {order.corporateUnits.filter((unit) => unit.status === 'PENDING').length}{' '}
                    pendientes
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3 w-full"
                    onClick={() => setCorporateOpen((open) => !open)}
                  >
                    <Gift className="h-4 w-4" />{' '}
                    {corporateOpen
                      ? 'Ocultar unidades'
                      : `Gestionar unidades (${order.corporateUnits.length})`}
                  </Button>
                  {corporateOpen ? (
                    <div className="mt-3 space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Una unidad por línea: Nombre | Mensaje opcional
                      </p>
                      <select
                        aria-label="Producto de los destinatarios"
                        value={unitItemId}
                        onChange={(event) => setUnitItemId(event.target.value)}
                        className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
                      >
                        {order.items.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.description} ({Number(item.quantity)} unidades)
                          </option>
                        ))}
                      </select>
                      <textarea
                        aria-label="Nuevos destinatarios"
                        value={unitLines}
                        onChange={(event) => setUnitLines(event.target.value)}
                        rows={3}
                        placeholder="Nombre | Mensaje opcional"
                        className="w-full rounded-md border border-input bg-card p-3 text-sm"
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="w-full"
                        disabled={pending || !unitLines.trim()}
                        onClick={() => onAddUnits(unitLines, unitItemId)}
                      >
                        Agregar destinatarios
                      </Button>
                      <label className="flex min-h-10 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-3 text-sm font-semibold hover:bg-muted">
                        Importar Excel .xlsx
                        <input
                          type="file"
                          accept=".xlsx"
                          className="sr-only"
                          disabled={pending}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) onImportUnits(file);
                            event.target.value = '';
                          }}
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Columnas: Nombre (obligatoria) y Mensaje (opcional).
                      </p>
                      <div className="space-y-2">
                        {order.corporateUnits.map((unit) => (
                          <div
                            key={unit.id}
                            className="space-y-2 rounded-md border border-border bg-background p-3"
                          >
                            <Input
                              aria-label="Destinatario"
                              defaultValue={unit.recipientName}
                              key={unit.id + unit.recipientName}
                              onBlur={(event) => {
                                if (event.target.value.trim() !== unit.recipientName)
                                  onUpdateUnit(
                                    unit.id,
                                    unit.status,
                                    undefined,
                                    event.target.value.trim(),
                                  );
                              }}
                            />
                            <Input
                              aria-label="Mensaje"
                              defaultValue={unit.message ?? ''}
                              onBlur={(event) => {
                                if (event.target.value !== (unit.message ?? ''))
                                  onUpdateUnit(
                                    unit.id,
                                    unit.status,
                                    undefined,
                                    undefined,
                                    event.target.value,
                                  );
                              }}
                            />
                            {unit.status === 'PENDING' && order.productionStage === 'WAITING' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => onRemoveUnit(unit.id)}
                              >
                                Retirar destinatario
                              </Button>
                            ) : null}
                            {unit.message ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {unit.message}
                              </p>
                            ) : null}
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                              <select
                                aria-label={`Estado de ${unit.recipientName}`}
                                value={unit.status}
                                disabled={pending}
                                onChange={(event) =>
                                  onUpdateUnit(unit.id, event.target.value as UnitStatus)
                                }
                                className="h-10 min-w-0 rounded-md border border-input bg-card px-2 text-sm"
                              >
                                <option value="PENDING">Pendiente</option>
                                <option value="IN_PROGRESS">En progreso</option>
                                <option value="COMPLETED">Terminada</option>
                              </select>
                              <Button
                                type="button"
                                size="sm"
                                variant={unit.deliveredAt ? 'default' : 'outline'}
                                disabled={pending}
                                onClick={() =>
                                  onUpdateUnit(unit.id, unit.status, !unit.deliveredAt)
                                }
                              >
                                {unit.deliveredAt ? 'Entregada' : 'Entregar'}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </DetailSection>
              ) : null}
            </>
          ) : null}

          {tab === 'history' ? (
            <DetailSection title="Historial de cambios">
              {order.workflowEvents?.length ? (
                <div className="space-y-3">
                  {order.workflowEvents.map((event) => (
                    <div key={event.id} className="border-l-2 border-gold-light pl-3 text-sm">
                      <p className="font-semibold">
                        {event.note || `${event.fromStage} → ${event.toStage}`}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDate(event.createdAt)} · {event.changedBy?.name}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Aún no hay cambios registrados para esta orden.
                </p>
              )}
            </DetailSection>
          ) : null}

          {tab === 'notes' ? (
            <DetailSection title="Nota interna de producción">
              <label
                htmlFor={`production-note-${order.id}`}
                className="mb-2 block text-sm text-muted-foreground"
              >
                Detalle opcional para fábrica
              </label>
              <textarea
                id={`production-note-${order.id}`}
                value={productionNote}
                onChange={(event) => setProductionNote(event.target.value)}
                maxLength={500}
                rows={5}
                placeholder="Escribe una nota interna"
                className="w-full resize-y rounded-md border border-input bg-card p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3 w-full"
                disabled={pending || productionNote === (order.productionNotes ?? '')}
                onClick={() => onWorkflow({ note: productionNote })}
              >
                Guardar nota
              </Button>
            </DetailSection>
          ) : null}
        </div>

        <footer className="shrink-0 space-y-3 border-t border-border bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">
          {order.status !== 'COMPLETED' ? (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs font-bold text-red-700">
              PENDIENTE DE COBRO: cobra y factura la orden en Caja antes de moverla.
            </div>
          ) : null}
          {order.status === 'COMPLETED' && blockers.length && next ? (
            <div className="rounded-md border border-warning/25 bg-amber-50 p-2.5 text-xs text-amber-900">
              <p className="font-semibold">Antes de entregar:</p>
              {blockers.map((reason) => (
                <p key={reason}>· {reason}</p>
              ))}
            </div>
          ) : null}
          {next === 'DELIVERED' ? (
            <p className="text-xs text-muted-foreground">
              El servidor verifica la factura y el balance al confirmar la entrega.
            </p>
          ) : null}
          {designPending && order.productionStage === 'FACTORY' ? (
            <p className="text-xs text-amber-800">
              Administración debe aprobar el diseño antes de aprobar la calidad.
            </p>
          ) : null}
          {!factoryView && order.requiresProduction &&
          !order.designApprovedAt &&
          (order.productionStage === 'WAITING' || order.productionStage === 'FACTORY') ? (
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              disabled={pending || order.exceptionStatus !== 'NONE'}
              onClick={() => onApprove('design')}
            >
              <Check className="h-4 w-4" /> Aprobar diseño
            </Button>
          ) : null}
          {order.requiresProduction &&
          order.productionStage === 'FACTORY' &&
          !order.qualityApprovedAt ? (
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              disabled={pending || designPending || order.exceptionStatus !== 'NONE'}
              onClick={() => onApprove('quality')}
            >
              <Check className="h-4 w-4" /> Aprobar calidad
            </Button>
          ) : null}
          <label className="block text-xs font-semibold text-muted-foreground">
            Mover a cualquier etapa
            <select
              aria-label="Mover orden a etapa"
              value={order.productionStage}
              disabled={pending || order.status !== 'COMPLETED'}
              onChange={(event) => onWorkflow({ stage: event.target.value as ProductionStage })}
              className="mt-1 h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
            >
              {columns.map((column) => (
                <option key={column.stage} value={column.stage}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!previous || pending || order.status !== 'COMPLETED'}
              onClick={() => previous && onWorkflow({ stage: previous })}
            >
              <ArrowLeft className="h-4 w-4" /> Atrás
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!next || pending || blockers.length > 0}
              onClick={() => next && onWorkflow({ stage: next })}
            >
              {next === 'DELIVERED' ? 'Marcar entregada' : 'Siguiente'}{' '}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                onWorkflow({ priority: order.priority === 'URGENT' ? 'NORMAL' : 'URGENT' })
              }
            >
              {order.priority === 'URGENT' ? 'Quitar urgencia' : 'Marcar urgente'}
            </Button>
            <select
              aria-label="Incidencia de la orden"
              value={order.exceptionStatus}
              disabled={pending}
              onChange={(event) =>
                onWorkflow({ exceptionStatus: event.target.value as OrderExceptionStatus })
              }
              className="h-10 min-w-0 rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="NONE">Sin novedad</option>
              <option value="PAUSED">Pausada</option>
              <option value="PROBLEM">Problema</option>
              {!factoryView ? <option value="CANCELLED">Cancelada</option> : null}
            </select>
          </div>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-bold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold">{value}</span>
    </div>
  );
}

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : 'No se pudo actualizar la orden.');
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Factory,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  approveOrderDesign,
  approveOrderQuality,
  getProductionKanban,
  updateCorporateOrderUnit,
  updateOrderWorkflow,
  type ProductionBoardOrder,
  type ProductionStage,
} from '@/lib/api';
import { isAdminSession } from '@/lib/authorization';
import { formatDate } from '@/lib/utils';
import { SessionRequired, useCurrentSession } from './session-required';

type QueueTab = 'WAITING' | 'FACTORY' | 'READY';
type SortMode = 'PROMISED' | 'ARRIVAL';

const tabs: Array<{ id: QueueTab; label: string }> = [
  { id: 'WAITING', label: 'Por hacer' },
  { id: 'FACTORY', label: 'En proceso' },
  { id: 'READY', label: 'Terminados' },
];

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santo_Domingo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function businessDateKey(value: string | Date) {
  const parts = businessDateFormatter.formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function compareOrders(a: ProductionBoardOrder, b: ProductionBoardOrder, sort: SortMode) {
  if (sort === 'PROMISED') {
    const dueA = a.promisedAt ? new Date(a.promisedAt).getTime() : Number.POSITIVE_INFINITY;
    const dueB = b.promisedAt ? new Date(b.promisedAt).getTime() : Number.POSITIVE_INFINITY;
    if (dueA !== dueB) return dueA - dueB;
  }
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function isLate(order: ProductionBoardOrder) {
  if (!order.promisedAt || order.productionStage === 'READY') return false;
  return businessDateKey(order.promisedAt) < businessDateKey(new Date());
}

export function FactoryWorkQueue() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const admin = isAdminSession(session);
  const [tab, setTab] = useState<QueueTab>('WAITING');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('PROMISED');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const boardKey = ['production-kanban', session?.tenantId] as const;
  const boardQuery = useQuery({
    queryKey: boardKey,
    queryFn: () => getProductionKanban(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    refetchInterval: 15_000,
  });

  const workflow = useMutation({
    mutationFn: ({
      orderId,
      stage,
      productionNote,
    }: {
      orderId: string;
      stage?: ProductionStage;
      productionNote?: string;
    }) =>
      updateOrderWorkflow(session!.tenantId, session!.accessToken, orderId, {
        stage,
        note: productionNote,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success('Trabajo actualizado.');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const design = useMutation({
    mutationFn: (orderId: string) =>
      approveOrderDesign(session!.tenantId, session!.accessToken, orderId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success('Diseño aprobado.');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const quality = useMutation({
    mutationFn: (orderId: string) =>
      approveOrderQuality(session!.tenantId, session!.accessToken, orderId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success('Calidad aprobada. Ya puedes marcar el trabajo como terminado.');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const corporateUnit = useMutation({
    mutationFn: ({
      orderId,
      unitId,
      status,
    }: {
      orderId: string;
      unitId: string;
      status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
    }) =>
      updateCorporateOrderUnit(session!.tenantId, session!.accessToken, orderId, unitId, {
        status,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: boardKey }),
    onError: (error: Error) => toast.error(error.message),
  });

  const relevantOrders = useMemo(
    () =>
      (boardQuery.data ?? []).filter(
        (order) =>
          order.requiresProduction &&
          order.exceptionStatus !== 'CANCELLED' &&
          order.productionStage !== 'DELIVERED',
      ),
    [boardQuery.data],
  );
  const visibleOrders = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return relevantOrders
      .filter((order) => order.productionStage === tab)
      .filter(
        (order) =>
          !term ||
          [
            order.orderNumber,
            order.clientName,
            order.customer?.name,
            ...order.items.map((item) => item.description),
          ]
            .filter(Boolean)
            .some((value) => value!.toLocaleLowerCase().includes(term)),
      )
      .sort((a, b) => compareOrders(a, b, sort));
  }, [relevantOrders, search, sort, tab]);

  if (!session) return <SessionRequired session={session} />;

  return (
    <div className="min-w-0 space-y-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-gold-deep">
            Hotel Ancla
          </p>
          <h1 className="text-3xl font-semibold text-foreground">Fábrica</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Trabajos asignados, ordenados por fecha prometida y llegada. Una ficha por orden.
          </p>
        </div>
        {admin ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/production">Ver Producción y despacho</Link>
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tabs
          .filter((item) => admin || item.id !== 'READY')
          .map((item) => {
            const count = relevantOrders.filter(
              (order) => order.productionStage === item.id,
            ).length;
            const Icon =
              item.id === 'WAITING' ? Clock3 : item.id === 'FACTORY' ? Factory : CheckCircle2;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-pressed={tab === item.id}
                className={`flex min-h-20 items-center gap-3 rounded-xl border bg-card p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item.id ? 'border-gold-dark bg-gold-light/15' : 'border-border hover:border-gold/60'}`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gold-light/25 text-gold-deep">
                  <Icon className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-xl font-bold">{count}</span>
                  <span className="text-sm text-muted-foreground">{item.label}</span>
                </span>
              </button>
            );
          })}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar orden, cliente o producto"
            aria-label="Buscar trabajos"
            className="pl-9"
          />
        </div>
        <select
          aria-label="Ordenar trabajos"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortMode)}
          className="h-10 rounded-md border border-input bg-card px-3 text-sm"
        >
          <option value="PROMISED">Fecha prometida primero</option>
          <option value="ARRIVAL">Orden de llegada</option>
        </select>
      </div>

      {boardQuery.isLoading ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground"
        >
          Cargando trabajos...
        </p>
      ) : null}
      {boardQuery.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
        >
          <span className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> No se pudo cargar la cola.
          </span>
          <Button variant="outline" size="sm" onClick={() => void boardQuery.refetch()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      {boardQuery.isSuccess && !visibleOrders.length ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {search ? 'No hay trabajos para esta búsqueda.' : 'No hay trabajos en esta etapa.'}
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {visibleOrders.map((order) => {
          const open = expandedId === order.id;
          const paid = order.status === 'COMPLETED';
          const personalized = order.items.some((item) => item.product?.kind === 'PERSONALIZED');
          const designPending = personalized && !order.designApprovedAt;
          const issue = order.exceptionStatus !== 'NONE';
          const unitsIncomplete =
            order.isCorporate &&
            (!order.corporateUnits.length ||
              order.corporateUnits.some((unit) => unit.status !== 'COMPLETED'));
          const busy = workflow.isPending || design.isPending || quality.isPending || corporateUnit.isPending;
          return (
            <article
              key={order.id}
              className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  setExpandedId(open ? null : order.id);
                  setNote(order.productionNotes ?? '');
                }}
                className="flex w-full min-w-0 items-start justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block break-all text-sm font-bold text-foreground">
                    {order.orderNumber}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {order.clientName || order.customer?.name || 'Cliente general'}
                  </span>
                </span>
                {open ? (
                  <ChevronUp className="h-5 w-5 shrink-0" />
                ) : (
                  <ChevronDown className="h-5 w-5 shrink-0" />
                )}
              </button>
              <div className="mt-3 flex flex-wrap gap-2">
                {!paid ? <Badge variant="danger">PENDIENTE DE COBRO</Badge> : null}
                {isLate(order) ? <Badge variant="danger">Atrasada</Badge> : null}
                {order.priority === 'URGENT' ? <Badge variant="danger">Urgente</Badge> : null}
                {issue ? (
                  <Badge variant="warning">
                    Incidencia: {order.exceptionStatus === 'PAUSED' ? 'pausada' : 'problema'}
                  </Badge>
                ) : null}
                {designPending ? <Badge variant="warning">Diseño por aprobar</Badge> : null}
                {order.productionStage === 'READY' ? (
                  <Badge variant="success">Trabajo terminado</Badge>
                ) : null}
              </div>
              <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="h-4 w-4" /> Prometida:{' '}
                  {order.promisedAt ? formatDate(order.promisedAt) : 'Sin fecha'}
                </span>
                <span>Llegó: {formatDate(order.createdAt)}</span>
              </div>
              <p className="mt-3 text-sm text-foreground">
                {order.items
                  .map((item) => `${Number(item.quantity)} × ${item.description}`)
                  .join(' · ')}
              </p>

              {open ? (
                <div className="mt-4 space-y-4 border-t border-border pt-4">
                  <div className="space-y-2">
                    <h2 className="text-sm font-semibold">Detalles del trabajo</h2>
                    {order.items.map((item) => (
                      <div key={item.id} className="rounded-lg bg-muted/50 p-3 text-sm">
                        <p className="font-semibold">
                          {Number(item.quantity)} × {item.description}
                        </p>
                        {item.personalization ? (
                          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {item.personalization.charms != null ? (
                              <p>Dijes: {item.personalization.charms}</p>
                            ) : null}
                            {item.personalization.children != null ? (
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
                  {order.isCorporate ? (
                    <div className="space-y-2">
                      <h2 className="text-sm font-semibold">
                        Unidades empresariales (
                        {order.corporateUnits.filter((unit) => unit.status === 'COMPLETED').length}/
                        {order.corporateUnits.length} terminadas)
                      </h2>
                      {order.corporateUnits.map((unit) => (
                        <div
                          key={unit.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm"
                        >
                          <span>
                            {unit.recipientName}
                            {unit.message ? ` · ${unit.message}` : ''}
                          </span>
                          <select
                            aria-label={`Estado de ${unit.recipientName}`}
                            value={unit.status}
                            disabled={!paid || issue || busy || order.productionStage === 'READY'}
                            onChange={(event) =>
                              corporateUnit.mutate({
                                orderId: order.id,
                                unitId: unit.id,
                                status: event.target.value as typeof unit.status,
                              })
                            }
                            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                          >
                            <option value="PENDING">Pendiente</option>
                            <option value="IN_PROGRESS">En proceso</option>
                            <option value="COMPLETED">Terminada</option>
                          </select>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div>
                    <label htmlFor={`factory-note-${order.id}`} className="text-sm font-semibold">
                      Nota interna
                    </label>
                    <textarea
                      id={`factory-note-${order.id}`}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      rows={3}
                      maxLength={1000}
                      className="mt-1 w-full rounded-md border border-input bg-card p-2 text-sm"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      disabled={busy || note === (order.productionNotes ?? '')}
                      onClick={() => workflow.mutate({ orderId: order.id, productionNote: note })}
                    >
                      Guardar nota
                    </Button>
                  </div>
                  {admin && order.productionStage === 'READY' ? (
                    <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                      Pendiente de entrega{' '}
                      {order.dispatchLocation === 'FACTORY' ? 'desde Fábrica' : 'desde Tienda'}.
                      Terminar el trabajo no equivale a entregarlo al cliente.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {designPending && order.productionStage !== 'READY' ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-amber-800">
                    Administración debe aprobar el diseño antes de aprobar la calidad.
                  </p>
                  {admin ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={issue || busy}
                      onClick={() => design.mutate(order.id)}
                    >
                      Aprobar diseño
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {order.productionStage === 'WAITING' ? (
                <Button
                  className="mt-4 w-full"
                  disabled={!paid || issue || designPending || busy}
                  onClick={() => workflow.mutate({ orderId: order.id, stage: 'FACTORY' })}
                >
                  Iniciar trabajo
                </Button>
              ) : null}
              {order.productionStage === 'FACTORY' ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {!order.qualityApprovedAt ? (
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={!paid || issue || designPending || busy || unitsIncomplete}
                      onClick={() => quality.mutate(order.id)}
                    >
                      Aprobar calidad
                    </Button>
                  ) : null}
                  <Button
                    className="flex-1"
                    disabled={!paid || issue || busy || !order.qualityApprovedAt || unitsIncomplete}
                    onClick={() => workflow.mutate({ orderId: order.id, stage: 'READY' })}
                  >
                    Marcar terminado
                  </Button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Se muestran las órdenes cargadas por el tablero; no es un histórico completo. El inventario
        y la entrega al cliente se gestionan por separado.
      </p>
    </div>
  );
}

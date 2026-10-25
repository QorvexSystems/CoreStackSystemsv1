'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Building2, CheckCircle2, LogOut, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { clearSession, getSession, type AuthSession } from '@/lib/auth-session';
import { canAccessPath, getDefaultPathForSession } from '@/lib/authorization';
import {
  getCurrentCashSession,
  getDashboardSummary,
  getDiscountApprovalNotifications,
  getFiscalSequenceAlerts,
  getFiscalSequences,
  approveDiscountRequest,
  dismissDiscountNotification,
  rejectDiscountRequest,
  type DiscountApproval,
  type FiscalSequenceAlert,
  type FiscalSequence,
} from '@/lib/api';
import { isAdminSession } from '@/lib/authorization';
import { brand } from '@/lib/brand';
import { translateRole } from '@/lib/display-labels';
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { formatQuantity } from '@/components/operations/pos/pos-utils';
import { GlobalSearch } from './global-search';
import { MobileNavigation, Sidebar } from './sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [selectedDiscountApproval, setSelectedDiscountApproval] = useState<DiscountApproval | null>(
    null,
  );
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const pathname = usePathname();
  const router = useRouter();

  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary', session?.tenantId],
    queryFn: () => getDashboardSummary(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session && canAccessPath(session, '/dashboard')),
    refetchInterval: 60_000,
  });
  const fiscalSequenceAlertsQuery = useQuery({
    queryKey: ['fiscal-sequence-alerts', session?.tenantId],
    queryFn: () => getFiscalSequenceAlerts(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session && isAdminSession(session)),
    refetchInterval: 60_000,
  });
  const fiscalSequencesQuery = useQuery({
    queryKey: ['fiscal-sequences', session?.tenantId],
    queryFn: () => getFiscalSequences(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session && isAdminSession(session)),
    refetchInterval: 60_000,
  });
  const discountApprovalsQuery = useQuery({
    queryKey: ['discount-approval-notifications', session?.tenantId],
    queryFn: () =>
      getDiscountApprovalNotifications(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session && isAdminSession(session)),
    refetchInterval: 30_000,
  });
  const currentCashSessionQuery = useQuery({
    queryKey: ['cash-session-current', session?.tenantId, 'logout-guard'],
    queryFn: () => getCurrentCashSession(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });

  useEffect(() => {
    const currentSession = getSession();
    setSession(currentSession);

    if (!currentSession) {
      const nextPath = `${pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(nextPath)}`);
      return;
    }

    if (!canAccessPath(currentSession, pathname)) {
      router.replace(getDefaultPathForSession(currentSession));
    }
  }, [pathname, router]);

  useEffect(() => {
    const cashSessionOpen = currentCashSessionQuery.data?.status === 'OPEN';

    if (!session || !cashSessionOpen) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentCashSessionQuery.data?.status, session]);

  async function handleLogout() {
    if (!session) {
      clearSession();
      router.replace('/login');
      return;
    }

    try {
      const currentCashSession = await getCurrentCashSession(session.tenantId, session.accessToken);

      if (currentCashSession?.status === 'OPEN') {
        toast.warning('Debes cerrar la caja antes de salir.', {
          description: `${currentCashSession.cashRegister.name} sigue abierta con fondo inicial ${formatCurrency(Number(currentCashSession.openingAmount))}.`,
        });
        router.push(
          canAccessPath(session, '/cash/sessions')
            ? '/cash/sessions'
            : getDefaultPathForSession(session),
        );
        return;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No pude validar el estado de la caja.');
      return;
    }

    clearSession();
    toast.success('Sesion cerrada correctamente.');
    router.replace('/login');
  }

  if (session === undefined) {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-100 px-4">
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm text-muted-foreground shadow-sm">
          Validando sesion...
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-100 px-4">
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm text-muted-foreground shadow-sm">
          Redirigiendo al login...
        </div>
      </div>
    );
  }

  const notificationCount =
    (summaryQuery.data?.pendingInvoices ? 1 : 0) +
    (summaryQuery.data?.lowStockProducts ? 1 : 0) +
    (fiscalSequenceAlertsQuery.data?.length ?? 0) +
    (discountApprovalsQuery.data?.length ?? 0);

  return (
    <div className="min-h-screen bg-zinc-100">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((current) => !current)}
      />

      <div
        className={cn(
          'min-h-screen pb-24 transition-[padding] duration-200 lg:pb-0',
          sidebarCollapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-72',
          'print:pb-0 print:pl-0',
        )}
      >
        <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur print:hidden">
          <div className="flex h-16 items-center justify-between gap-3 px-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary sm:flex">
                  <Building2 className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{brand.name}</p>
                  <p className="truncate text-xs text-muted-foreground">Operacion del cliente</p>
                </div>
              </div>
            </div>

            <GlobalSearch session={session} />

            <div className="relative flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Notificaciones"
                className="relative inline-flex"
                onClick={() => setNotificationsOpen((current) => !current)}
              >
                <Bell className="h-5 w-5" />
                {notificationCount > 0 ? (
                  <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
                    {notificationCount > 9 ? '9+' : notificationCount}
                  </span>
                ) : null}
              </Button>
              {notificationsOpen ? (
                <NotificationsPanel
                  pendingInvoices={summaryQuery.data?.pendingInvoices ?? 0}
                  lowStockProducts={summaryQuery.data?.lowStockProducts ?? 0}
                  inventoryAlerts={summaryQuery.data?.recentInventoryAlerts ?? []}
                  openCashSessions={summaryQuery.data?.openCashSessions ?? 0}
                  fiscalSequenceAlerts={fiscalSequenceAlertsQuery.data ?? []}
                  fiscalSequences={fiscalSequencesQuery.data ?? []}
                  fiscalSequencesError={fiscalSequencesQuery.isError}
                  discountApprovals={discountApprovalsQuery.data ?? []}
                  loading={
                    summaryQuery.isLoading ||
                    fiscalSequenceAlertsQuery.isLoading ||
                    fiscalSequencesQuery.isLoading ||
                    discountApprovalsQuery.isLoading
                  }
                  onClose={() => setNotificationsOpen(false)}
                  onSelectDiscount={(approval) => {
                    setNotificationsOpen(false);
                    setSelectedDiscountApproval(approval);
                  }}
                />
              ) : null}
              <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 sm:px-3">
                <div className="h-8 w-8 rounded-md bg-primary text-center text-sm font-semibold leading-8 text-primary-foreground">
                  {session?.user.name.slice(0, 2).toUpperCase() ?? 'RV'}
                </div>
                <div className="hidden sm:block">
                  <p className="text-sm font-medium">{session?.user.name ?? brand.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {translateRole(session?.role) ?? 'Operacion'}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="icon"
                aria-label="Cerrar sesion"
                onClick={handleLogout}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>
        <main className="animate-page-enter mx-auto w-full max-w-[92rem] px-3 py-4 print:max-w-none print:p-0 sm:px-6 sm:py-6">
          {children}
        </main>
      </div>

      <MobileNavigation />
      <DiscountApprovalDialog
        session={session}
        approval={selectedDiscountApproval}
        onClose={() => setSelectedDiscountApproval(null)}
      />
    </div>
  );
}

function NotificationsPanel({
  pendingInvoices,
  lowStockProducts,
  inventoryAlerts,
  openCashSessions,
  fiscalSequenceAlerts,
  fiscalSequences,
  fiscalSequencesError,
  discountApprovals,
  loading,
  onClose,
  onSelectDiscount,
}: {
  pendingInvoices: number;
  lowStockProducts: number;
  inventoryAlerts: Array<{
    id: string;
    name: string;
    sku: string | null;
    stock: number;
    reservedStock: number;
    minStock: number;
  }>;
  openCashSessions: number;
  fiscalSequenceAlerts: FiscalSequenceAlert[];
  fiscalSequences: FiscalSequence[];
  fiscalSequencesError: boolean;
  discountApprovals: DiscountApproval[];
  loading: boolean;
  onClose: () => void;
  onSelectDiscount: (approval: DiscountApproval) => void;
}) {
  const sequencesById = new Map(fiscalSequences.map((sequence) => [sequence.id, sequence]));
  const alertedSequenceIds = new Set(fiscalSequenceAlerts.map((alert) => alert.id));
  const healthyActiveSequences = fiscalSequences
    .filter((sequence) => sequence.status === 'ACTIVE' && !alertedSequenceIds.has(sequence.id))
    .sort((left, right) => left.prefix.localeCompare(right.prefix));
  const notifications = [
    {
      id: 'pending-invoices',
      label: 'Facturas pendientes',
      value: pendingInvoices,
      href: '/invoices',
      detail: 'Revisar comprobantes pendientes.',
      critical: false,
    },
    {
      id: 'low-stock-products',
      label: 'Productos con stock bajo o agotado',
      value: lowStockProducts,
      href: '/products',
      detail: 'Consulta abajo las existencias y el mínimo.',
      critical: true,
    },
    ...fiscalSequenceAlerts.map((alert) => ({
      id: alert.id,
      label: getFiscalSequenceAlertLabel(alert),
      value: alert.missing ? 'Sin bloque' : `${alert.remaining} restantes`,
      href: '/settings/fiscal-sequences',
      detail: getFiscalSequenceAlertDetail(alert, sequencesById.get(alert.id)),
      critical: alert.severity === 'critical',
    })),
  ].filter((item) => item.value !== 0);

  return (
    <div className="absolute right-2 top-12 z-50 max-h-[min(75vh,38rem)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-zinc-200 bg-white p-3 shadow-xl sm:right-12">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">Notificaciones</p>
        <button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
          Cerrar
        </button>
      </div>
      {loading ? (
        <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-muted-foreground">
          Cargando alertas...
        </p>
      ) : (
        <div className="space-y-2">
          {discountApprovals.map((approval) => (
            <button
              key={approval.id}
              type="button"
              onClick={() => onSelectDiscount(approval)}
              className="flex w-full items-center justify-between rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-left text-sm transition hover:border-sky-300"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  Descuento personalizado · {approval.salesOrder.orderNumber}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {approval.requestedBy.name} solicita {Number(approval.requestedRate) * 100}%
                </span>
              </span>
              <span
                className={cn(
                  'ml-3 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold',
                  approval.status === 'PENDING'
                    ? 'bg-amber-100 text-amber-800'
                    : approval.status === 'APPROVED'
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-red-100 text-red-800',
                )}
              >
                {approval.status === 'PENDING'
                  ? 'Pendiente'
                  : approval.status === 'APPROVED'
                    ? 'Aprobado'
                    : approval.status === 'REJECTED'
                      ? 'Rechazado'
                      : 'Cancelado'}
              </span>
            </button>
          ))}
          {notifications.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              onClick={onClose}
              className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm transition hover:border-zinc-300 hover:bg-zinc-50"
            >
              <span className="min-w-0">
                <span className="block truncate">{item.label}</span>
                {item.detail ? (
                  <span className="block text-xs text-muted-foreground">{item.detail}</span>
                ) : null}
              </span>
              <span
                className={cn(
                  'ml-3 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold',
                  item.critical
                    ? 'bg-danger/10 text-danger'
                    : item.value
                      ? 'bg-primary/10 text-primary'
                      : 'bg-zinc-100 text-zinc-500',
                )}
              >
                {item.value}
              </span>
            </Link>
          ))}
          {fiscalSequencesError ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              No se pudo cargar el consumo de las secuencias fiscales.
            </p>
          ) : null}
          {healthyActiveSequences.length > 0 ? (
            <div className="space-y-2 border-t border-zinc-200 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Consumo de secuencias fiscales
              </p>
              {healthyActiveSequences.map((sequence) => {
                const usage = getFiscalSequenceUsage(sequence);
                return (
                  <Link
                    key={sequence.id}
                    href="/settings/fiscal-sequences"
                    onClick={onClose}
                    className="block rounded-md border border-zinc-200 px-3 py-2 text-sm transition hover:bg-zinc-50"
                  >
                    <span className="flex items-center justify-between gap-2 font-medium">
                      <span>{sequence.prefix} · bloque activo</span>
                      <span>{usage.percent}% usado</span>
                    </span>
                    <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-zinc-100">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${usage.percent}%` }}
                      />
                    </span>
                    <span className="mt-1.5 block text-xs text-muted-foreground">
                      {usage.consumed} de {usage.total} consumidos · {usage.remaining} disponibles
                      {sequence.validUntil ? ` · vence ${formatDate(sequence.validUntil)}` : ''}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : null}
          {lowStockProducts > 0 ? inventoryAlerts.map((product) => {
            const available = Math.max(Number(product.stock) - Number(product.reservedStock), 0);
            const gap = Math.max(Number(product.minStock) - available, 0);
            const level = available <= 0 ? 'out' : 'low';
            const query = product.sku || product.name;
            return (
              <Link
                key={product.id}
                href={`/products?stock=${level}&q=${encodeURIComponent(query)}`}
                onClick={onClose}
                className="block rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm hover:bg-amber-50"
              >
                <span className="block truncate font-medium">{product.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatQuantity(available)} disponibles · mínimo {formatQuantity(product.minStock)}
                  {gap > 0
                    ? ` · faltan ${formatQuantity(gap)}`
                    : available <= 0 ? ' · agotado' : ' · en el mínimo'}
                </span>
              </Link>
            );
          }) : null}
          {openCashSessions > 0 ? (
            <Link href="/cash/sessions" onClick={onClose} className="block rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50">
              {openCashSessions} caja(s) abierta(s)
            </Link>
          ) : null}
          {notifications.length === 0 && discountApprovals.length === 0 && openCashSessions === 0 && healthyActiveSequences.length === 0 && !fiscalSequencesError ? (
            <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-muted-foreground">No hay alertas pendientes.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function getFiscalSequenceAlertLabel(alert: FiscalSequenceAlert) {
  if (alert.missing) return `${alert.prefix}: falta bloque autorizado`;
  if (alert.expired) return `${alert.prefix}: vigencia fiscal vencida`;
  if (alert.exhausted) return `${alert.prefix}: bloque agotado`;
  if (alert.expiringSoon && alert.remaining > alert.threshold) return `${alert.prefix}: próximo a vencer`;
  return `${alert.prefix}: próximo a agotarse`;
}

function getFiscalSequenceAlertDetail(alert: FiscalSequenceAlert, sequence?: FiscalSequence) {
  if (alert.missing) return 'No hay un bloque configurado para este comprobante.';
  const usage = sequence ? getFiscalSequenceUsage(sequence) : null;
  const consumed = usage
    ? `${usage.consumed} de ${usage.total} consumidos (${usage.percent}%). `
    : '';
  const validity = alert.validUntil ? ` · vence ${formatDate(alert.validUntil)}` : '';
  if (alert.expired) return alert.validUntil
    ? `${consumed}Venció ${formatDate(alert.validUntil)} · quedan ${alert.remaining} sin usar.`
    : `${consumed}${alert.remaining} números sin usar en un bloque vencido.`;
  if (alert.exhausted) return `${consumed}No quedan números disponibles${validity}.`;
  if (alert.remaining <= alert.threshold) {
    return `${consumed}Aviso al llegar a ${alert.threshold} restantes${validity}.`;
  }
  return `${consumed}Vence en ${alert.daysUntilExpiry} día(s)${validity}.`;
}

function getFiscalSequenceUsage(sequence: FiscalSequence) {
  const total = Math.max(sequence.endNumber - sequence.startNumber + 1, 0);
  const consumed = Math.min(Math.max(sequence.nextNumber - sequence.startNumber, 0), total);
  const remaining = total - consumed;
  const percent = total > 0 ? Math.round((consumed / total) * 100) : 0;
  return { total, consumed, remaining, percent };
}

function DiscountApprovalDialog({
  session,
  approval,
  onClose,
}: {
  session: AuthSession;
  approval: DiscountApproval | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  useEffect(() => setNote(approval?.decisionNote ?? ''), [approval]);

  const decisionMutation = useMutation({
    mutationFn: async (action: 'APPROVE' | 'REJECT') => {
      if (!approval) throw new Error('Solicitud no disponible.');
      return action === 'APPROVE'
        ? approveDiscountRequest(
            session.tenantId,
            session.accessToken,
            approval.id,
            note.trim() || undefined,
          )
        : rejectDiscountRequest(
            session.tenantId,
            session.accessToken,
            approval.id,
            note.trim() || undefined,
          );
    },
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['discount-approval-notifications'] });
      await queryClient.invalidateQueries({ queryKey: ['sales-orders'] });
      setNote(updated.decisionNote ?? '');
      toast.success(updated.status === 'APPROVED' ? 'Descuento aprobado' : 'Descuento rechazado', {
        description: updated.salesOrder.orderNumber,
      });
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'No se pudo resolver la solicitud.'),
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      if (!approval) throw new Error('Solicitud no disponible.');
      return dismissDiscountNotification(session.tenantId, session.accessToken, approval.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['discount-approval-notifications'] });
      toast.success('Notificación eliminada');
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'No se pudo eliminar la notificación.'),
  });

  if (!approval) return null;

  const grossSubtotal =
    Number(approval.salesOrder.subtotal) + Number(approval.salesOrder.discountTotal);

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/45 p-4 print:hidden">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-200 p-5">
          <div>
            <h2 className="text-lg font-bold">Solicitud de descuento personalizado</h2>
            <p className="text-sm text-muted-foreground">
              {approval.salesOrder.orderNumber} · solicitado por {approval.requestedBy.name}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <XCircle className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md bg-sky-50 p-3">
              <p className="text-xs text-muted-foreground">Descuento solicitado</p>
              <p className="text-2xl font-bold text-primary">
                {Number(approval.requestedRate) * 100}%
              </p>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="text-xs text-muted-foreground">Subtotal bruto</p>
              <p className="font-bold">{formatCurrency(grossSubtotal)}</p>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <p className="text-xs text-muted-foreground">Total con impuestos</p>
              <p className="font-bold">{formatCurrency(Number(approval.salesOrder.total))}</p>
            </div>
          </div>
          <div className="text-sm">
            <p>
              Cliente:{' '}
              <strong>
                {approval.salesOrder.customer?.name ??
                  approval.salesOrder.clientName ??
                  'Consumidor final'}
              </strong>
            </p>
            <p>
              Tipo:{' '}
              <strong>
                {approval.salesOrder.destination === 'QUOTATION' ? 'Cotización' : 'Venta de caja'}
              </strong>
            </p>
            <p>
              Solicitado: <strong>{formatDateTime(approval.requestedAt)}</strong>
            </p>
          </div>
          <div className="rounded-md border border-zinc-200">
            {approval.salesOrder.items.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 border-b border-zinc-100 px-3 py-2 text-sm last:border-0"
              >
                <span>
                  {item.description} · {Number(item.quantity)}
                </span>
                <strong>{formatCurrency(Number(item.total))}</strong>
              </div>
            ))}
          </div>
          {approval.status === 'PENDING' ? (
            <div className="space-y-2">
              <label htmlFor="discountDecisionNote" className="text-sm font-medium">
                Nota de decisión (opcional)
              </label>
              <textarea
                id="discountDecisionNote"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                className="min-h-20 w-full rounded-md border border-input px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={decisionMutation.isPending}
                  onClick={() => decisionMutation.mutate('APPROVE')}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Aprobar
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="border-danger/30 text-danger hover:bg-danger/5 hover:text-danger"
                  disabled={decisionMutation.isPending}
                  onClick={() => decisionMutation.mutate('REJECT')}
                >
                  <XCircle className="h-4 w-4" />
                  Rechazar
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md bg-zinc-50 p-3">
              <p className="text-sm">
                <strong>{approval.status === 'APPROVED' ? 'Aprobado' : 'No aprobado'}</strong>
                {approval.decisionNote ? ` · ${approval.decisionNote}` : ''}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={dismissMutation.isPending}
                onClick={() => dismissMutation.mutate()}
              >
                <Trash2 className="h-4 w-4" />
                Eliminar
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

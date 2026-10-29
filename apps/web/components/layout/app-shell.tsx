'use client';

import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronDown, LogOut, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { clearSession, getSession, type AuthSession } from '@/lib/auth-session';
import { canAccessPath, getDefaultPathForSession, isAccountantSession, isAdminSession } from '@/lib/authorization';
import {
  getCurrentCashSession,
  getDashboardSummary,
  getFiscalSequenceAlerts,
  type FiscalSequenceAlert,
} from '@/lib/api';
import { brand } from '@/lib/brand';
import { translateRole } from '@/lib/display-labels';
import { cn, formatCurrency } from '@/lib/utils';
import { GlobalSearch } from './global-search';
import { MobileNavigation, Sidebar } from './sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
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
    enabled: Boolean(session),
    refetchInterval: 60_000,
  });
  const currentCashSessionQuery = useQuery({
    queryKey: ['cash-session-current', session?.tenantId, 'logout-guard'],
    queryFn: () => getCurrentCashSession(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });

  useEffect(() => {
    const currentSession = getSession();
    setSession(currentSession);
    setNotificationsOpen(false);
    setUserMenuOpen(false);
    setMobileSearchOpen(false);

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
        router.push(canAccessPath(session, '/cash/sessions') ? '/cash/sessions' : getDefaultPathForSession(session));
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
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
          Validando sesion...
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
          Redirigiendo al login...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((current) => !current)} />

      <div
        className={cn(
          'min-h-screen min-w-0 pb-24 transition-[padding] duration-200 lg:pb-0',
          sidebarCollapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-72',
          'print:pb-0 print:pl-0',
        )}
      >
        <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur print:hidden">
          <div className="flex h-16 min-w-0 items-center justify-between gap-3 px-3 sm:px-6">
            <div className="flex shrink-0 items-center gap-2 lg:hidden">
              <img src={brand.logoPath} alt={brand.name} className="h-9 w-9 rounded-md object-contain" />
              <span className="hidden text-sm font-semibold text-foreground sm:inline">{brand.name}</span>
            </div>

            <GlobalSearch session={session} />

            <div className="relative flex shrink-0 items-center gap-2 sm:gap-3">
              {isAdminSession(session) || isAccountantSession(session) ? (
                <Button type="button" variant="ghost" size="icon" aria-label="Buscar" aria-expanded={mobileSearchOpen} className="md:hidden" onClick={() => { setMobileSearchOpen((open) => !open); setNotificationsOpen(false); setUserMenuOpen(false); }}><Search className="h-5 w-5" /></Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Notificaciones"
                className="relative inline-flex text-muted-foreground hover:text-foreground"
                onClick={() => { setNotificationsOpen((current) => !current); setUserMenuOpen(false); setMobileSearchOpen(false); }}
              >
                <Bell className="h-5 w-5" />
                {fiscalSequenceAlertsQuery.data?.length ? (
                  <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white">
                    {fiscalSequenceAlertsQuery.data.length > 9
                      ? '9+'
                      : fiscalSequenceAlertsQuery.data.length}
                  </span>
                ) : null}
              </Button>
              {notificationsOpen ? (
                <NotificationsPanel
                  pendingInvoices={summaryQuery.data?.pendingInvoices ?? 0}
                  lowStockProducts={summaryQuery.data?.lowStockProducts ?? 0}
                  openCashSessions={summaryQuery.data?.openCashSessions ?? 0}
                  fiscalSequenceAlerts={fiscalSequenceAlertsQuery.data ?? []}
                  loading={summaryQuery.isLoading || fiscalSequenceAlertsQuery.isLoading}
                  onClose={() => setNotificationsOpen(false)}
                />
              ) : null}
              <button
                type="button"
                aria-expanded={userMenuOpen}
                aria-label="Menú de usuario"
                onClick={() => { setUserMenuOpen((current) => !current); setNotificationsOpen(false); setMobileSearchOpen(false); }}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border bg-white px-2 py-1.5 text-left shadow-sm transition-colors hover:bg-[#FAF8F5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3',
                  userMenuOpen ? 'border-gold-dark' : 'border-border',
                )}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ backgroundColor: '#8A651E' }}>
                  {session?.user.name.slice(0, 2).toUpperCase() ?? 'UP'}
                </div>
                <div className="hidden min-w-0 sm:block">
                  <p className="truncate text-sm font-semibold text-[#101623]">{session?.user.name ?? brand.name}</p>
                  <p className="text-xs font-medium text-[#526075]">{translateRole(session?.role) ?? 'Operacion'}</p>
                </div>
                <ChevronDown className="hidden h-4 w-4 shrink-0 text-[#526075] sm:block" />
              </button>
              {userMenuOpen ? (
                <div className="absolute right-0 top-12 z-50 min-w-52 rounded-lg border border-border bg-card p-2 shadow-lg">
                  <p className="truncate px-3 py-2 text-xs text-muted-foreground">{session.user.name}</p>
                  <button type="button" onClick={handleLogout} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <LogOut className="h-4 w-4" /> Cerrar sesión
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {mobileSearchOpen ? <div className="absolute inset-x-3 top-16 z-30 rounded-lg border border-border bg-card p-3 shadow-lg md:hidden"><GlobalSearch session={session} mobile /></div> : null}
        </header>
        <main className="animate-page-enter mx-auto w-full min-w-0 max-w-[110rem] px-3 py-5 print:max-w-none print:p-0 sm:px-6 sm:py-7">
          {children}
        </main>
      </div>

      <MobileNavigation />
    </div>
  );
}

function NotificationsPanel({
  pendingInvoices,
  lowStockProducts,
  openCashSessions,
  fiscalSequenceAlerts,
  loading,
  onClose,
}: {
  pendingInvoices: number;
  lowStockProducts: number;
  openCashSessions: number;
  fiscalSequenceAlerts: FiscalSequenceAlert[];
  loading: boolean;
  onClose: () => void;
}) {
  const notifications = [
    {
      id: 'pending-invoices',
      label: 'Facturas pendientes',
      value: pendingInvoices,
      href: '/invoices',
      detail: undefined,
      critical: false,
    },
    {
      id: 'low-stock-products',
      label: 'Productos bajo stock',
      value: lowStockProducts,
      href: '/products',
      detail: undefined,
      critical: false,
    },
    {
      id: 'open-cash-sessions',
      label: 'Cajas abiertas',
      value: openCashSessions,
      href: '/cash/sessions',
      detail: undefined,
      critical: false,
    },
    ...fiscalSequenceAlerts.map((alert) => ({
      id: alert.id,
      label: getFiscalSequenceAlertLabel(alert),
      value: alert.missing || alert.exhausted || alert.expired ? 'Revisar' : `${alert.remaining} restantes`,
      href: '/settings/fiscal-sequences',
      detail:
        alert.missing || alert.exhausted || alert.expired
          ? 'Requiere un bloque autorizado por DGII.'
          : undefined,
      critical: alert.severity === 'critical',
    })),
  ];

  return (
    <div className="absolute right-0 top-12 z-50 w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">Notificaciones</p>
        <button type="button" className="text-xs text-muted-foreground" onClick={onClose}>
          Cerrar
        </button>
      </div>
      {loading ? (
        <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-muted-foreground">Cargando alertas...</p>
      ) : (
        <div className="space-y-2">
          {notifications.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              onClick={onClose}
              className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm transition hover:border-zinc-300 hover:bg-zinc-50"
            >
              <span className="min-w-0">
                <span className="block truncate">{item.label}</span>
                {item.detail ? <span className="block text-xs text-muted-foreground">{item.detail}</span> : null}
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
        </div>
      )}
    </div>
  );
}

function getFiscalSequenceAlertLabel(alert: FiscalSequenceAlert) {
  if (alert.missing) return `${alert.prefix}: falta bloque autorizado`;
  if (alert.expired) return `${alert.prefix}: vigencia fiscal vencida`;
  if (alert.exhausted) return `${alert.prefix}: bloque agotado`;
  return `${alert.prefix}: próximo a agotarse`;
}

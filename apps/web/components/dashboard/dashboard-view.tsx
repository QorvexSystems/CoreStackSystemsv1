'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertsPanel,
  AttentionOrdersPanel,
  CashMovementCard,
  CorporateSummaryCard,
  DeliverySummaryCard,
  InventoryAlertsCard,
  KpiCard,
  MonthComparison,
  MonthlySalesChart,
  ProductionOverview,
  ProductSalesChart,
  QuickActions,
  SalesChannelCard,
  SalesBehaviorChart,
  dashboardIcons,
} from '@/components/dashboard/dashboard-widgets';
import { getDashboardSummary, getProductSalesRanking } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { formatCurrency } from '@/lib/utils';

export function DashboardView() {
  const session = useMemo(() => getSession(), []);
  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary', session?.tenantId],
    queryFn: () => getDashboardSummary(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const productRankingQuery = useQuery({
    queryKey: ['product-sales-ranking', session?.tenantId],
    queryFn: () => getProductSalesRanking(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (!session) {
    return (
      <DashboardMessage
        title="Sesión no disponible"
        detail="Inicia sesión nuevamente para consultar el panel."
      />
    );
  }

  if (summaryQuery.isLoading) {
    return <DashboardLoading />;
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <DashboardMessage
        title="No pudimos cargar el resumen"
        detail="Comprueba la conexión e inténtalo nuevamente."
        action={
          <Button variant="outline" onClick={() => void summaryQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reintentar
          </Button>
        }
      />
    );
  }

  const summary = summaryQuery.data;
  const employeeName = session.user.name?.split(' ')[0] || session.tenantName;

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 pb-5">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div>
          <h1 className="text-[28px] font-bold tracking-[-0.035em] text-slate-950 sm:text-[30px]">
            {getGreeting()}, {employeeName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Aquí tienes un resumen de la operación de {session.tenantName} para hoy.
          </p>
        </div>

        <div className="flex flex-wrap items-stretch gap-2">
          <div className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 shadow-[0_1px_2px_rgb(15_23_42_/_0.03)]">
            <CalendarDays className="h-4 w-4 text-slate-700" aria-hidden="true" />
            <div>
              <p className="text-xs font-medium capitalize text-slate-800">
                {formatLongDate(new Date())}
              </p>
              <p className="mt-0.5 text-[10px] text-slate-400">
                Actualizado {formatUpdatedAt(new Date())}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            className="h-auto min-h-12 rounded-xl bg-white px-5"
            disabled={summaryQuery.isFetching || productRankingQuery.isFetching}
            onClick={() => {
              void summaryQuery.refetch();
              void productRankingQuery.refetch();
            }}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${summaryQuery.isFetching || productRankingQuery.isFetching ? 'animate-spin' : ''}`}
            />
            Actualizar
          </Button>
        </div>
      </header>

      {session.role === 'ACCOUNTANT' ? (
        <>
          <section
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6"
            aria-label="Indicadores contables"
          >
            <KpiCard
              title="Ventas de hoy"
              value={formatCurrency(summary.netSalesToday)}
              detail={`${summary.invoicesToday} facturas`}
              icon={dashboardIcons.sales}
              tone="green"
              session={session}
            />
            <KpiCard
              title="Cobrado en el mes"
              value={formatCurrency(summary.netSalesMonth)}
              detail={`Cobrado: ${formatCurrency(summary.collectionsMonth)}`}
              icon={dashboardIcons.collected}
              tone="blue"
              session={session}
              footer={
                <MonthComparison
                  current={summary.netSalesMonth}
                  previous={summary.previousMonthNetSales}
                />
              }
            />
            <KpiCard
              title="Por cobrar"
              value={formatCurrency(summary.accounting.receivables.outstandingBalance)}
              detail={`${summary.accounting.receivables.openInvoiceCount} facturas abiertas`}
              icon={dashboardIcons.collected}
              tone="orange"
              href="/receivables"
              session={session}
            />
            <KpiCard
              title="Cartera vencida"
              value={formatCurrency(summary.accounting.receivables.overdueBalance)}
              detail={`${summary.accounting.receivables.overdueCount} facturas vencidas`}
              icon={dashboardIcons.fiscal}
              tone="red"
              href="/receivables"
              session={session}
            />
            <KpiCard
              title="Por pagar"
              value={formatCurrency(summary.accounting.payables.outstandingBalance)}
              detail={`${summary.accounting.payables.openInvoiceCount} compromisos`}
              icon={dashboardIcons.orders}
              tone="violet"
              href="/payables"
              session={session}
            />
            <KpiCard
              title="Alertas fiscales"
              value={String(summary.fiscalSequenceAlerts.length)}
              detail={
                summary.fiscalSequenceAlerts.length ? 'Requieren atención' : 'Sin alertas activas'
              }
              icon={dashboardIcons.fiscal}
              tone="red"
              href="/settings/fiscal-sequences"
              session={session}
            />
          </section>
          <section className="grid gap-3 xl:grid-cols-12">
            <div className="xl:col-span-7">
              <MonthlySalesChart summary={summary} />
            </div>
            <div className="xl:col-span-5">
              <SalesBehaviorChart summary={summary} />
            </div>
          </section>
          <section className="grid gap-3 lg:grid-cols-2 xl:grid-cols-12">
            <div className="xl:col-span-4">
              <CashMovementCard summary={summary} />
            </div>
            <div className="xl:col-span-4">
              <ProductSalesChart
                ranking={productRankingQuery.data}
                isLoading={productRankingQuery.isLoading}
              />
            </div>
            <div className="xl:col-span-4">
              <AlertsPanel summary={summary} session={session} />
            </div>
          </section>
        </>
      ) : (
        <>
          <section
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3"
            aria-label="Indicadores principales"
          >
            <KpiCard
              title="Ventas de hoy"
              value={formatCurrency(summary.netSalesToday)}
              detail={`${summary.completedOrdersToday} órdenes · ${summary.invoicesToday} facturas`}
              icon={dashboardIcons.sales}
              tone="green"
              session={session}
            />
            <KpiCard
              title="Ventas del mes"
              value={formatCurrency(summary.netSalesMonth)}
              detail="Comparación mensual"
              icon={dashboardIcons.collected}
              tone="blue"
              session={session}
              footer={
                <MonthComparison
                  current={summary.netSalesMonth}
                  previous={summary.previousMonthNetSales}
                />
              }
            />
            <KpiCard
              title="Órdenes activas"
              value={String(
                summary.production.waiting + summary.production.factory + summary.production.ready,
              )}
              detail={`${summary.production.urgent} urgentes`}
              icon={dashboardIcons.orders}
              tone="orange"
              href="/production"
              session={session}
            />
            <KpiCard
              title="En fábrica"
              value={String(summary.production.factory)}
              detail="En proceso de personalización"
              icon={dashboardIcons.warehouse}
              tone="violet"
              href="/production"
              session={session}
            />
            <KpiCard
              title="Listas para entregar"
              value={String(summary.production.ready)}
              detail={`${summary.delivery.promisedToday} prometidas para hoy`}
              icon={dashboardIcons.products}
              tone="green"
              href="/production"
              session={session}
            />
            <KpiCard
              title="Órdenes atrasadas"
              value={String(summary.production.late)}
              detail={
                summary.production.late ? 'Requieren atención inmediata' : 'Sin atrasos activos'
              }
              icon={dashboardIcons.fiscal}
              tone="red"
              href="/production"
              session={session}
            />
          </section>

          <section className="grid gap-3 xl:grid-cols-12" aria-label="Producción y seguimiento">
            <div className="xl:col-span-5">
              <ProductionOverview summary={summary} />
            </div>
            <div className="xl:col-span-7">
              <AttentionOrdersPanel summary={summary} />
            </div>
          </section>

          <section className="grid gap-3 xl:grid-cols-12" aria-label="Ventas">
            <div className="xl:col-span-6">
              <MonthlySalesChart summary={summary} />
            </div>
            <div className="xl:col-span-3">
              <SalesChannelCard summary={summary} />
            </div>
            <div className="xl:col-span-3">
              <ProductSalesChart
                ranking={productRankingQuery.data}
                isLoading={productRankingQuery.isLoading}
              />
            </div>
          </section>

          <section
            className="grid gap-3 lg:grid-cols-2 xl:grid-cols-12"
            aria-label="Entregas e inventario"
          >
            <div className="xl:col-span-4">
              <DeliverySummaryCard summary={summary} />
            </div>
            <div className="xl:col-span-4">
              <InventoryAlertsCard summary={summary} />
            </div>
            <div className="lg:col-span-2 xl:col-span-4">
              <CorporateSummaryCard summary={summary} />
            </div>
          </section>

          <section
            className="grid gap-3 lg:grid-cols-2 xl:grid-cols-12"
            aria-label="Acciones y alertas"
          >
            <div className="xl:col-span-4">
              <QuickActions session={session} />
            </div>
            <div className="xl:col-span-8">
              <AlertsPanel summary={summary} session={session} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DashboardLoading() {
  return (
    <div
      className="mx-auto w-full max-w-[1600px] animate-pulse space-y-4"
      aria-label="Cargando panel"
    >
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-8 w-72 rounded bg-slate-200" />
          <div className="h-4 w-96 max-w-full rounded bg-slate-200" />
        </div>
        <div className="h-12 w-80 rounded-xl bg-slate-200" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-[110px] rounded-2xl bg-white" />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-12">
        <div className="h-[260px] rounded-2xl bg-white xl:col-span-6" />
        <div className="h-[260px] rounded-2xl bg-white xl:col-span-3" />
        <div className="h-[260px] rounded-2xl bg-white xl:col-span-3" />
      </div>
    </div>
  );
}

function DashboardMessage({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-[55vh] place-items-center">
      <div className="rounded-2xl border border-slate-200 bg-white px-8 py-10 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-950">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">{detail}</p>
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function formatLongDate(value: Date) {
  return new Intl.DateTimeFormat('es-DO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(value);
}

function formatUpdatedAt(value: string | Date) {
  return new Intl.DateTimeFormat('es-DO', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

'use client';

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Landmark,
  Package,
  PackageCheck,
  ReceiptText,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardSummary, ProductSalesRanking } from '@/lib/api';
import type { AuthSession } from '@/lib/auth-session';
import { canAccessPath } from '@/lib/authorization';
import { translateEmployeeAction, translateEntity } from '@/lib/display-labels';
import { cn, formatCurrency, formatDateTime } from '@/lib/utils';

export type DashboardTone = 'blue' | 'green' | 'orange' | 'violet' | 'red';

const toneClasses: Record<DashboardTone, string> = {
  blue: 'bg-blue-50 text-blue-600',
  green: 'bg-emerald-50 text-emerald-600',
  orange: 'bg-orange-50 text-orange-600',
  violet: 'bg-violet-50 text-violet-600',
  red: 'bg-rose-50 text-rose-600',
};

const chartColors = {
  blue: '#3b82f6',
  green: '#34c38f',
  orange: '#fb923c',
  violet: '#8b5cf6',
  muted: '#cbd5e1',
};

export function DashboardCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgb(15_23_42_/_0.03)]',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function KpiCard({
  title,
  value,
  detail,
  icon: Icon,
  tone,
  href,
  session,
  footer,
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: DashboardTone;
  href?: string;
  session: AuthSession;
  footer?: React.ReactNode;
}) {
  const content = (
    <div className="flex h-full min-h-[108px] flex-col justify-between p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', toneClasses[tone])}>
          <Icon className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate text-xs font-medium text-slate-600">{title}</p>
          <p className="mt-1 truncate text-xl font-bold tracking-tight text-slate-950">{value}</p>
          <p className={cn('mt-1 truncate text-[11px] text-slate-500', tone === 'red' && 'text-rose-500')}>
            {detail}
          </p>
        </div>
        {href && canAccessPath(session, href) ? (
          <ArrowRight className="mt-8 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        ) : null}
      </div>
      {footer ? <div className="mt-2 text-[11px]">{footer}</div> : null}
    </div>
  );

  return href && canAccessPath(session, href) ? (
    <Link
      href={href}
      className="block rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgb(15_23_42_/_0.03)] transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      {content}
    </Link>
  ) : (
    <DashboardCard>{content}</DashboardCard>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  subtitle,
  tone = 'blue',
  action,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  tone?: DashboardTone;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-4 sm:px-5">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', toneClasses[tone])}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-950">{title}</h2>
          {subtitle ? <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

function ChartSelect({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-8 shrink-0 items-center rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-600">
      {children}
    </span>
  );
}

function CurrencyTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-slate-950">{formatCurrency(Number(payload[0]?.value ?? 0))}</p>
    </div>
  );
}

type TooltipProps = {
  active?: boolean;
  payload?: Array<{ value?: number | string }>;
  label?: string | number;
};

export function MonthlySalesChart({ summary }: { summary: DashboardSummary }) {
  const hasData = summary.dailySalesSeries.some((item) => item.total !== 0);
  const monthLabel = new Intl.DateTimeFormat('es-DO', { month: 'short' })
    .format(new Date())
    .replace('.', '');
  return (
    <DashboardCard className="min-h-[260px]">
      <PanelHeader
        icon={Activity}
        title="Ventas del mes"
        subtitle="Total cobrado por día"
        action={<ChartSelect>Este mes</ChartSelect>}
      />
      <div className="h-[200px] px-2 pb-3 sm:px-3">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={summary.dailySalesSeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="allpa-daily-sales" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.blue} stopOpacity={0.24} />
                  <stop offset="95%" stopColor={chartColors.blue} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical stroke="#e8edf4" strokeDasharray="3 3" />
              <XAxis
                dataKey="day"
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickFormatter={(day) => `${day} ${monthLabel}`}
              />
              <YAxis
                width={48}
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickFormatter={(value) => compactCurrency(Number(value))}
              />
              <Tooltip content={<CurrencyTooltip />} />
              <Area
                type="monotone"
                dataKey="total"
                stroke={chartColors.blue}
                strokeWidth={2.25}
                fill="url(#allpa-daily-sales)"
                activeDot={{ r: 4, fill: chartColors.blue, stroke: '#fff', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ChartEmptyState message="Aún no hay cobros registrados durante este mes." />
        )}
      </div>
    </DashboardCard>
  );
}

export function OrdersStatusChart({ summary }: { summary: DashboardSummary }) {
  const data = [
    { name: 'Completadas', value: summary.orderStatusSummary.completed, color: chartColors.green },
    { name: 'Pendiente de cobro', value: summary.orderStatusSummary.pendingCashier, color: chartColors.blue },
    { name: 'Cotizaciones', value: summary.orderStatusSummary.quotations, color: chartColors.orange },
    { name: 'Otras', value: summary.orderStatusSummary.other, color: chartColors.muted },
  ];
  const chartData = data.filter((item) => item.value > 0);

  return (
    <DashboardCard className="min-h-[260px]">
      <PanelHeader icon={ClipboardList} title="Órdenes por estado" tone="green" />
      <div className="grid h-[205px] grid-cols-[minmax(118px,0.9fr)_minmax(125px,1fr)] items-center gap-1 px-3 pb-4">
        <div className="relative h-40 min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData.length ? chartData : [{ name: 'Sin datos', value: 1, color: '#e2e8f0' }]}
                dataKey="value"
                nameKey="name"
                innerRadius="62%"
                outerRadius="84%"
                paddingAngle={2}
                stroke="#fff"
                strokeWidth={2}
              >
                {(chartData.length ? chartData : [{ color: '#e2e8f0' }]).map((item, index) => (
                  <Cell key={`${item.color}-${index}`} fill={item.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => [Number(value), 'Órdenes']} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
            <span className="text-2xl font-bold text-slate-950">{summary.orderStatusSummary.total}</span>
            <span className="text-[11px] text-slate-500">órdenes</span>
          </div>
        </div>
        <div className="space-y-3">
          {data.map((item) => (
            <div key={item.name} className="flex min-w-0 items-center gap-2 text-[11px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="min-w-0 flex-1 truncate text-slate-600">{item.name}</span>
              <span className="font-semibold text-slate-950">{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}

export function ProductSalesChart({
  ranking,
  isLoading = false,
}: {
  ranking?: ProductSalesRanking;
  isLoading?: boolean;
}) {
  const [mode, setMode] = useState<'most' | 'least'>('most');
  const products = mode === 'most'
    ? (ranking?.mostSold.filter((product) => product.quantitySold > 0).slice(0, 5) ?? [])
    : (ranking?.leastSold.slice(0, 5) ?? []);
  const maximum = Math.max(...products.map((product) => product.quantitySold), 1);

  return (
    <DashboardCard className="min-h-[260px]">
      <PanelHeader
        icon={mode === 'most' ? ArrowUpRight : ArrowDownRight}
        title="Productos vendidos"
        action={
          <Link
            href="/dashboard/productos-vendidos"
            className="flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
          >
            Ver detalle <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        }
      />
      <div className="px-4 pb-4 sm:px-5">
        <div className="mb-3 grid grid-cols-2 rounded-lg bg-slate-100 p-1" role="group" aria-label="Tipo de ranking">
          <button
            type="button"
            onClick={() => setMode('most')}
            className={cn(
              'h-7 rounded-md text-[11px] font-medium transition',
              mode === 'most' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800',
            )}
          >
            Más vendidos
          </button>
          <button
            type="button"
            onClick={() => setMode('least')}
            className={cn(
              'h-7 rounded-md text-[11px] font-medium transition',
              mode === 'least' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800',
            )}
          >
            Menos vendidos
          </button>
        </div>

        {isLoading ? (
          <div className="space-y-3 pt-1" aria-label="Cargando productos vendidos">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-6 animate-pulse rounded-md bg-slate-100" />
            ))}
          </div>
        ) : products.length ? (
          <div className="space-y-2.5">
            {products.map((product) => (
              <div key={product.productId} className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="truncate text-[10px] font-medium text-slate-700" title={product.name}>{product.name}</p>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={cn('h-full rounded-full', mode === 'most' ? 'bg-blue-500' : 'bg-violet-400')}
                      style={{ width: `${product.quantitySold > 0 ? Math.max((product.quantitySold / maximum) * 100, 4) : 0}%` }}
                    />
                  </div>
                </div>
                <span className="text-right text-[10px] font-semibold text-slate-800">
                  {formatQuantitySold(product.quantitySold)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="h-[145px]">
            <ChartEmptyState message="Aún no hay ventas vinculadas a productos para mostrar." />
          </div>
        )}
      </div>
    </DashboardCard>
  );
}

export function CashMovementCard({ summary }: { summary: DashboardSummary }) {
  return (
    <DashboardCard className="min-h-[178px]">
      <PanelHeader icon={ReceiptText} title="Movimiento de caja" subtitle="Entradas y salidas de hoy" tone="violet" />
      <div className="grid grid-cols-2 gap-5 px-5 pb-5 pt-3">
        <CashMetric
          label="Entradas"
          value={summary.cashToday.entriesAmount}
          count={summary.cashToday.entriesCount}
          positive
        />
        <CashMetric label="Salidas" value={summary.cashToday.exitsAmount} count={summary.cashToday.exitsCount} />
      </div>
    </DashboardCard>
  );
}

function CashMetric({ label, value, count, positive = false }: { label: string; value: number; count: number; positive?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
        <span className={cn('h-2.5 w-2.5 rounded-full', positive ? 'bg-emerald-400' : 'bg-rose-400')} />
        {label}
      </div>
      <p className="mt-2 truncate text-lg font-bold text-slate-950">{formatCurrency(value)}</p>
      <p className="mt-1 text-xs text-slate-500">{count} movimiento{count === 1 ? '' : 's'}</p>
    </div>
  );
}

export function SalesBehaviorChart({ summary }: { summary: DashboardSummary }) {
  const hasData = summary.salesSeries.some((item) => item.total !== 0);
  return (
    <DashboardCard className="min-h-[178px]">
      <PanelHeader
        icon={ArrowUpRight}
        title="Comportamiento de ventas"
        subtitle="Comparación con el mes anterior"
        tone="blue"
        action={<ChartSelect>Últimos 6 meses</ChartSelect>}
      />
      <div className="h-[115px] px-3 pb-3">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={summary.salesSeries} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#edf1f6" strokeDasharray="3 3" />
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
              <YAxis width={42} axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 9 }} tickFormatter={(value) => compactCurrency(Number(value))} />
              <Tooltip content={<CurrencyTooltip />} />
              <Bar dataKey="total" fill="#9dcdf9" radius={[4, 4, 0, 0]} maxBarSize={44} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ChartEmptyState message="Aún no hay suficiente actividad para mostrar esta tendencia." compact />
        )}
      </div>
    </DashboardCard>
  );
}

export function InventorySummaryCard({ summary, session }: { summary: DashboardSummary; session: AuthSession }) {
  const content = (
    <>
      <PanelHeader
        icon={Package}
        title="Inventario general"
        tone="violet"
        action={
          canAccessPath(session, '/inventory') ? (
            <span className="flex items-center gap-1 text-[11px] font-medium text-blue-600">
              Ver inventario <ArrowRight className="h-3.5 w-3.5" />
            </span>
          ) : null
        }
      />
      <div className="px-5 pb-5 pt-1">
        <div className="grid grid-cols-3 divide-x divide-slate-200">
          <InventoryMetric value={summary.activeProducts} label="Productos activos" />
          <InventoryMetric value={summary.lowStockProducts} label="Bajo mínimo" danger />
          <InventoryMetric value={summary.activeProducts + summary.warehouse.productCount} label="Total productos" />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-400 transition-[width]"
              style={{ width: `${Math.min(summary.inventorySummary.inStockPercentage, 100)}%` }}
            />
          </div>
          <div className="w-14 text-right">
            <p className="text-sm font-bold text-slate-950">{summary.inventorySummary.inStockPercentage.toFixed(1)}%</p>
            <p className="text-[10px] text-slate-500">en stock</p>
          </div>
        </div>
      </div>
    </>
  );

  return canAccessPath(session, '/inventory') ? (
    <Link href="/inventory" className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
      <DashboardCard className="min-h-[178px] transition hover:border-blue-200 hover:shadow-md">{content}</DashboardCard>
    </Link>
  ) : (
    <DashboardCard className="min-h-[178px]">{content}</DashboardCard>
  );
}

function InventoryMetric({ value, label, danger = false }: { value: number; label: string; danger?: boolean }) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <p className={cn('text-xl font-bold text-slate-950', danger && 'text-rose-500')}>{value}</p>
      <p className={cn('mt-1 truncate text-[11px] text-slate-500', danger && 'text-rose-500')}>{label}</p>
    </div>
  );
}

const quickActions: Array<{ label: string; href: string; icon: LucideIcon; tone: DashboardTone }> = [
  { label: 'Toma de órdenes', href: '/orders', icon: ShoppingCart, tone: 'blue' },
  { label: 'Caja POS', href: '/pos', icon: Landmark, tone: 'green' },
  { label: 'Productos', href: '/products', icon: Package, tone: 'orange' },
  { label: 'Cotizaciones', href: '/quotations', icon: FileText, tone: 'blue' },
  { label: 'Clientes', href: '/customers', icon: Users, tone: 'violet' },
  { label: 'Almacén', href: '/warehouse', icon: Boxes, tone: 'green' },
];

export function QuickActions({ session }: { session: AuthSession }) {
  const actions = quickActions.filter((action) => canAccessPath(session, action.href));
  return (
    <DashboardCard className="min-h-[242px]">
      <PanelHeader icon={Activity} title="Accesos rápidos" tone="orange" />
      <div className="grid grid-cols-2 gap-2 px-4 pb-4 pt-2 sm:grid-cols-3">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.href}
              href={action.href}
              className={cn(
                'flex min-h-[72px] flex-col items-center justify-center gap-2 rounded-xl border border-transparent px-2 py-3 text-center text-[11px] font-medium text-slate-800 transition hover:-translate-y-0.5 hover:border-blue-100 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                toneClasses[action.tone].split(' ')[0],
              )}
            >
              <Icon className={cn('h-5 w-5', toneClasses[action.tone].split(' ')[1])} aria-hidden="true" />
              <span>{action.label}</span>
            </Link>
          );
        })}
      </div>
    </DashboardCard>
  );
}

export function RecentActivity({ summary, session }: { summary: DashboardSummary; session: AuthSession }) {
  const activity = summary.recentEmployeeLogs
    .map((log) => ({
      id: log.id,
      title: `${log.employeeName ?? 'Usuario'} ${translateEmployeeAction(log.action)}`,
      detail: `${translateEntity(log.entity)}${log.invoiceNumber ? ` · ${log.invoiceNumber}` : ''}`,
      createdAt: log.createdAt,
      icon: activityIcon(log.entity),
    }))
    .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime())
    .slice(0, 5);

  return (
    <DashboardCard className="min-h-[242px]">
      <PanelHeader
        icon={Activity}
        title="Actividad reciente"
        action={
          canAccessPath(session, '/operations/logs') ? (
            <Link href="/operations/logs" className="flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700">
              Ver todas <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : null
        }
      />
      <div className="divide-y divide-slate-100 px-4 pb-3">
        {activity.length ? (
          activity.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.id} className="flex min-w-0 items-center gap-3 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-600">
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-slate-900">{item.title}</p>
                  <p className="truncate text-[10px] text-slate-500">{item.detail}</p>
                </div>
                <time className="shrink-0 text-[10px] text-slate-400">{formatActivityTime(item.createdAt)}</time>
              </div>
            );
          })
        ) : (
          <p className="py-12 text-center text-xs text-slate-500">Aún no hay actividad registrada.</p>
        )}
      </div>
    </DashboardCard>
  );
}

function activityIcon(entity: string): LucideIcon {
  if (entity === 'CashSession' || entity === 'CashMovement') return Landmark;
  if (entity === 'Product' || entity === 'InventoryMovement') return Package;
  if (entity === 'Invoice') return ReceiptText;
  if (entity === 'SalesOrder') return ShoppingCart;
  return Activity;
}

export function AlertsPanel({ summary, session }: { summary: DashboardSummary; session: AuthSession }) {
  const alerts = [
    {
      label: 'Productos bajo mínimo',
      detail: summary.lowStockProducts ? `${summary.lowStockProducts} producto requiere reposición` : 'Inventario dentro del mínimo',
      value: summary.lowStockProducts,
      href: '/products',
      icon: Package,
      danger: summary.lowStockProducts > 0,
    },
    {
      label: 'Secuencias fiscales',
      detail: summary.fiscalSequenceAlerts.length ? 'Próximas a agotarse' : 'Sin alertas activas',
      value: summary.fiscalSequenceAlerts.length,
      href: '/settings/fiscal-sequences',
      icon: FileText,
      danger: false,
    },
    {
      label: 'Cartera vencida',
      detail: summary.accounting.receivables.overdueCount ? `${formatCurrency(summary.accounting.receivables.overdueBalance)} vencido` : 'No hay facturas vencidas',
      value: summary.accounting.receivables.overdueCount,
      href: '/receivables',
      icon: Users,
      danger: false,
    },
    {
      label: 'Órdenes pendientes de despacho',
      detail: summary.warehouse.pendingDispatches ? `${summary.warehouse.pendingDispatches} orden pendiente` : 'No hay órdenes pendientes',
      value: summary.warehouse.pendingDispatches,
      href: '/warehouse',
      icon: PackageCheck,
      danger: false,
    },
  ];

  return (
    <DashboardCard className="min-h-[242px]">
      <PanelHeader icon={AlertTriangle} title="Alertas y seguimiento" tone="red" />
      <div className="space-y-1.5 px-4 pb-4 pt-1">
        {alerts.map((alert) => {
          const Icon = alert.icon;
          const row = (
            <div className={cn('flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 transition', alert.danger && 'border-rose-200 bg-rose-50/70')}>
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-600', alert.danger && 'bg-white text-rose-500')}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-semibold text-slate-900">{alert.label}</p>
                <p className={cn('truncate text-[10px] text-slate-500', alert.danger && 'text-rose-500')}>{alert.detail}</p>
              </div>
              <span className="text-xs font-semibold text-slate-950">{alert.value}</span>
              {canAccessPath(session, alert.href) ? <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : null}
            </div>
          );
          return canAccessPath(session, alert.href) ? (
            <Link key={alert.label} href={alert.href} className="block hover:opacity-90">{row}</Link>
          ) : (
            <div key={alert.label}>{row}</div>
          );
        })}
      </div>
    </DashboardCard>
  );
}

export const dashboardIcons = {
  sales: ShoppingCart,
  collected: CircleDollarSign,
  orders: ClipboardList,
  products: Package,
  warehouse: Boxes,
  fiscal: AlertTriangle,
};

function ChartEmptyState({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div className={cn('grid h-full place-items-center px-5 text-center text-xs text-slate-500', compact && 'text-[11px]')}>
      <div>
        <Activity className="mx-auto mb-2 h-5 w-5 text-slate-300" aria-hidden="true" />
        {message}
      </div>
    </div>
  );
}

function compactCurrency(value: number) {
  if (Math.abs(value) >= 1_000_000) return `RD$${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `RD$${Math.round(value / 1_000)}k`;
  return `RD$${Math.round(value)}`;
}

function formatQuantitySold(value: number) {
  return new Intl.NumberFormat('es-DO', { maximumFractionDigits: 2 }).format(value);
}

function formatActivityTime(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function MonthComparison({ current, previous }: { current: number; previous: number }) {
  if (previous <= 0) {
    return (
      <span className="flex items-center gap-1 text-emerald-600">
        <ArrowUpRight className="h-3 w-3" />
        {current > 0 ? 'Sin cobros el mes anterior' : 'Sin variación'}
      </span>
    );
  }

  const change = ((current - previous) / previous) * 100;
  const positive = change >= 0;
  return (
    <span className={cn('flex items-center gap-1', positive ? 'text-emerald-600' : 'text-rose-500')}>
      {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {positive ? '+' : ''}{change.toFixed(1)}% <span className="text-slate-400">vs. mes anterior</span>
    </span>
  );
}

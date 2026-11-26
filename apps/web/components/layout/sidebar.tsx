'use client';

import {
  MoreHorizontal,
  BarChart3,
  BedDouble,
  BriefcaseBusiness,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  DoorOpen,
  LayoutDashboard,
  RadioTower,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
  Zap,
  FileDigit,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { brand, platform } from '@/lib/brand';
import { getSession } from '@/lib/auth-session';
import { canAccessPath } from '@/lib/authorization';
import { cn } from '@/lib/utils';

export type NavigationItem = {
  name: string;
  href: string;
  icon: LucideIcon;
};

export const navigation: NavigationItem[] = [
  { name: 'Panel', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Reservaciones', href: '/reservations', icon: CalendarDays },
  { name: 'Check-in / Check-out', href: '/check-in-out', icon: DoorOpen },
  { name: 'Habitaciones', href: '/rooms', icon: BedDouble },
  { name: 'Limpieza', href: '/housekeeping', icon: Sparkles },
  { name: 'Huéspedes', href: '/guests', icon: Users },
  { name: 'Facturación', href: '/invoices', icon: CreditCard },
  { name: 'Factura Express', href: '/express-invoices', icon: Zap },
  { name: 'Secuencias fiscales', href: '/fiscal-sequences', icon: FileDigit },
  { name: 'Canales', href: '/channels', icon: RadioTower },
  { name: 'Reportes', href: '/reports', icon: BarChart3 },
  { name: 'Empleados', href: '/employees', icon: BriefcaseBusiness },
  { name: 'Configuración', href: '/settings', icon: Settings },
];

export function Sidebar({
  collapsed = false,
  onToggle,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const pathname = usePathname();
  const session = getSession();
  const visibleNavigation = navigation.filter((item) => canAccessPath(session, item.href));

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden border-r border-white/5 bg-[#111b20] text-white transition-[width] duration-200 print:hidden lg:flex lg:flex-col',
        collapsed ? 'w-[4.75rem]' : 'w-[15rem]',
      )}
    >
      <div
        className={cn(
          'flex h-[8.1rem] items-center justify-center border-b border-white/10 px-5',
          collapsed && 'h-20 px-2',
        )}
      >
        <img
          src={brand.logoPath}
          alt={brand.name}
          className={cn(
            'max-h-[6.5rem] w-full object-contain brightness-0 invert',
            collapsed && 'h-12 w-12',
          )}
        />
      </div>

      <nav
        className="sidebar-scrollbar flex-1 space-y-1 overflow-y-auto px-3 py-4"
        aria-label="Navegación principal"
      >
        {visibleNavigation.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.name : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
                collapsed && 'justify-center px-2',
                active && 'bg-[#173f3f] text-[#65d3c9] shadow-[inset_3px_0_0_#22b8ab]',
              )}
            >
              <Icon className="h-[1.15rem] w-[1.15rem] shrink-0" />
              <span className={cn('truncate', collapsed && 'hidden')}>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-3">
        {!collapsed ? (
          <div className="rounded-lg border border-white/10 bg-white/[0.025] p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <img src={platform.logoPath} alt="" className="h-5 w-5 rounded object-cover" />
              <span>{platform.name} Core</span>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-slate-500">
              Plataforma provista por CoreStack.
              <br />
              Datos aislados por tenant.
            </p>
          </div>
        ) : null}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            className="mt-2 flex w-full items-center justify-center rounded-lg py-2 text-slate-500 transition hover:bg-white/5 hover:text-white"
            aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

export function MobileNavigation() {
  const pathname = usePathname();
  const session = getSession();
  const [moreOpen, setMoreOpen] = useState(false);
  const visible = navigation.filter((item) => canAccessPath(session, item.href));
  // Si no caben todos, se muestran 4 y el botón "Más" despliega el resto.
  const quickItems = visible.length > 5 ? visible.slice(0, 4) : visible;
  const moreItems = visible.length > 5 ? visible.slice(4) : [];
  const moreActive = moreItems.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  useEffect(() => setMoreOpen(false), [pathname]);
  return (
    <>
    {moreOpen ? (
      <div className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden" onClick={() => setMoreOpen(false)}>
        <div
          className="absolute inset-x-2 bottom-20 rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="px-1 pb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Más módulos</p>
          <div className="grid grid-cols-3 gap-2">
            {moreItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-semibold',
                    active ? 'border-teal bg-teal-light text-teal-deep' : 'border-slate-200 text-slate-600',
                  )}
                >
                  <Icon className="h-6 w-6" />
                  <span className="w-full truncate text-center">{item.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    ) : null}
    <nav
      className="fixed inset-x-0 bottom-0 z-50 grid border-t border-slate-200 bg-white px-1 pb-2 pt-1 shadow-xl lg:hidden"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, quickItems.length + (moreItems.length ? 1 : 0))}, minmax(0, 1fr))` }}
      aria-label="Accesos rápidos"
    >
      {quickItems.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium text-slate-500',
              active && 'bg-teal-light text-teal-deep',
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="w-full truncate text-center">{item.name}</span>
          </Link>
        );
      })}
      {moreItems.length ? (
        <button
          type="button"
          onClick={() => setMoreOpen((value) => !value)}
          aria-expanded={moreOpen}
          className={cn(
            'flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium text-slate-500',
            (moreOpen || moreActive) && 'bg-teal-light text-teal-deep',
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>Más</span>
        </button>
      ) : null}
    </nav>
    </>
  );
}

export function getVisibleNavigation() {
  const session = getSession();
  return navigation.filter((item) => canAccessPath(session, item.href));
}

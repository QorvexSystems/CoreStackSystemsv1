'use client';

import {
  Activity,
  BadgeDollarSign,
  Boxes,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ClipboardPlus,
  FileText,
  FileUp,
  Landmark,
  LayoutDashboard,
  MoreHorizontal,
  Package,
  PanelsTopLeft,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  ScrollText,
  Settings,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getSession, type AuthSession } from '@/lib/auth-session';
import {
  canTakeOrders,
  canUsePosSession,
  isAccountantSession,
  isAdminSession,
} from '@/lib/authorization';
import { brand, platform } from '@/lib/brand';
import { cn } from '@/lib/utils';

type NavigationSectionId = 'main' | 'finance' | 'purchases' | 'administration';
type NavigationGroupId = Exclude<NavigationSectionId, 'main'>;

export type NavigationItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  primary?: boolean;
  section: NavigationSectionId;
};

type NavigationSection = {
  id: NavigationSectionId;
  label?: string;
  icon?: LucideIcon;
  items: NavigationItem[];
};

const sectionDefinitions: Array<Pick<NavigationSection, 'id' | 'label' | 'icon'>> = [
  { id: 'main' },
  { id: 'finance', label: 'Finanzas', icon: Landmark },
  { id: 'purchases', label: 'Compras y suplidores', icon: ClipboardList },
  { id: 'administration', label: 'Administración', icon: Settings },
];

export const navigation: NavigationItem[] = [
  { name: 'Panel', href: '/dashboard', icon: LayoutDashboard, section: 'main' },
  { name: 'Caja POS', href: '/pos', icon: ShoppingCart, primary: true, section: 'main' },
  {
    name: 'Toma de órdenes',
    href: '/orders',
    icon: ClipboardPlus,
    primary: true,
    section: 'main',
  },
  {
    name: 'Producción y despacho',
    href: '/production',
    icon: PanelsTopLeft,
    primary: true,
    section: 'main',
  },
  { name: 'Productos', href: '/products', icon: Package, section: 'main' },
  { name: 'Fábrica', href: '/warehouse', icon: Boxes, section: 'main' },
  { name: 'Cotizaciones', href: '/quotations', icon: FileText, section: 'main' },
  { name: 'Clientes', href: '/customers', icon: Users, section: 'main' },
  { name: 'Facturas', href: '/invoices', icon: FileText, primary: true, section: 'main' },
  { name: 'Devoluciones', href: '/returns', icon: RotateCcw, primary: true, section: 'main' },
  { name: 'Cuentas por cobrar', href: '/receivables', icon: FileText, section: 'finance' },
  {
    name: 'Aprobaciones de crédito',
    href: '/credit-approvals',
    icon: BadgeDollarSign,
    section: 'finance',
  },
  {
    name: 'Secuencias fiscales',
    href: '/settings/fiscal-sequences',
    icon: ScrollText,
    section: 'finance',
  },
  { name: 'Movimientos de caja', href: '/cash/logs', icon: ClipboardList, section: 'finance' },
  { name: 'Sesiones de caja', href: '/cash/sessions', icon: ScrollText, section: 'finance' },
  { name: 'Cajas', href: '/cash/registers', icon: Landmark, section: 'finance' },
  { name: 'Suplidores', href: '/suppliers', icon: Users, section: 'purchases' },
  {
    name: 'Órdenes de compra',
    href: '/purchase-orders',
    icon: ClipboardList,
    section: 'purchases',
  },
  {
    name: 'Facturas de suplidores',
    href: '/supplier-invoices',
    icon: FileText,
    section: 'purchases',
  },
  { name: 'Cuentas por pagar', href: '/payables', icon: ScrollText, section: 'purchases' },
  { name: 'Empleados', href: '/employees', icon: Users, section: 'administration' },
  { name: 'Importaciones', href: '/settings/imports', icon: FileUp, section: 'administration' },
  {
    name: 'Historial operativo',
    href: '/operations/logs',
    icon: Activity,
    section: 'administration',
  },
];

const warehouseNavigationItem: NavigationItem = {
  name: 'Fábrica',
  href: '/warehouse',
  icon: Boxes,
  section: 'main',
};

export function Sidebar({
  collapsed = false,
  onToggle,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden border-r border-border bg-card font-sans text-foreground transition-[width] duration-200 print:hidden lg:block',
        collapsed ? 'w-[4.5rem]' : 'w-72',
      )}
    >
      <SidebarContent collapsed={collapsed} onToggle={onToggle} onNavigate={onNavigate} />
    </aside>
  );
}

export function SidebarContent({
  collapsed = false,
  onToggle,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const session = getSession();
  const sections = getNavigationSections(session);
  const [activeGroup, setActiveGroup] = useState<NavigationGroupId | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<NavigationGroupId, boolean>>({
    finance: false,
    purchases: false,
    administration: false,
  });

  useEffect(() => {
    setActiveGroup(null);
  }, [collapsed, pathname]);

  useEffect(() => {
    const activeSection = sections.find(
      (section) =>
        section.id !== 'main' &&
        section.items.some((item) => isNavigationItemActive(pathname, item)),
    );

    if (!activeSection) return;

    const groupId = activeSection.id as NavigationGroupId;
    setExpandedGroups((current) => (current[groupId] ? current : { ...current, [groupId]: true }));
  }, [pathname]);

  return (
    <div className="flex h-full flex-col font-sans">
      <div
        className={cn(
          'flex h-16 items-center gap-3 border-b border-border px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        {collapsed ? (
          <img
            src={brand.logoPath}
            alt={brand.name}
            className="h-10 w-10 shrink-0 rounded-md object-contain"
          />
        ) : (
          <img
            src={brand.horizontalLogoPath}
            alt={brand.name}
            className="h-11 w-full object-contain object-left"
          />
        )}
      </div>

      {onToggle ? (
        <div className={cn('px-3 pt-3', collapsed && 'px-2')}>
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              collapsed && 'justify-center px-2',
            )}
            aria-label={collapsed ? 'Desplegar menú' : 'Contraer menú'}
            title={collapsed ? 'Desplegar menú' : undefined}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-5 w-5" />
            ) : (
              <PanelLeftClose className="h-5 w-5" />
            )}
            <span className={cn(collapsed && 'hidden')}>Contraer menú</span>
          </button>
        </div>
      ) : null}

      <nav
        className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 pr-2"
        aria-label="Navegación principal"
      >
        {sections.map((section, index) => {
          const isGroup = Boolean(section.label && section.icon);

          return (
            <div key={section.id} className={cn(index > 0 && 'mt-1')}>
              {isGroup ? (
                <SidebarNavigationGroup
                  section={section}
                  collapsed={collapsed}
                  pathname={pathname}
                  isOpen={activeGroup === section.id}
                  isExpanded={expandedGroups[section.id as NavigationGroupId]}
                  onOpenChange={(open) =>
                    setActiveGroup(open ? (section.id as NavigationGroupId) : null)
                  }
                  onExpandedChange={(expanded) =>
                    setExpandedGroups((current) => ({
                      ...current,
                      [section.id as NavigationGroupId]: expanded,
                    }))
                  }
                  onNavigate={onNavigate}
                />
              ) : (
                <div className="space-y-1">
                  {section.items.map((item) => (
                    <SidebarNavigationLink
                      key={item.href}
                      item={item}
                      collapsed={collapsed}
                      isActive={isNavigationItemActive(pathname, item)}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className={cn('shrink-0 border-t border-border p-4', collapsed && 'px-3')}>
        <div
          className={cn(
            'rounded-lg border border-border bg-surface-muted/60 p-3',
            collapsed && 'px-2.5',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-2 text-sm font-medium',
              collapsed && 'justify-center',
            )}
          >
            <img src={platform.logoPath} alt="" className="h-5 w-5 rounded object-cover" />
            <span className={cn(collapsed && 'hidden')}>{platform.name}</span>
          </div>
          <p className={cn('mt-2 text-xs leading-5 text-muted-foreground', collapsed && 'hidden')}>
            {platform.description} para {brand.name}.
          </p>
        </div>
      </div>
    </div>
  );
}

function SidebarNavigationGroup({
  section,
  collapsed,
  pathname,
  isOpen,
  isExpanded,
  onOpenChange,
  onExpandedChange,
  onNavigate,
}: {
  section: NavigationSection;
  collapsed: boolean;
  pathname: string;
  isOpen: boolean;
  isExpanded: boolean;
  onOpenChange: (open: boolean) => void;
  onExpandedChange: (expanded: boolean) => void;
  onNavigate?: () => void;
}) {
  const isActive = section.items.some((item) => isNavigationItemActive(pathname, item));
  const Icon = section.icon ?? ScrollText;

  if (!collapsed) {
    return (
      <div>
        <button
          type="button"
          onClick={() => onExpandedChange(!isExpanded)}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            (isActive || isExpanded) && 'text-gold-deep',
          )}
          aria-expanded={isExpanded}
          aria-controls={`sidebar-section-${section.id}`}
        >
          <Icon className={cn('h-5 w-5', isActive && 'text-gold-deep')} />
          <span className="flex-1 text-left">{section.label}</span>
          <ChevronDown
            className={cn('h-4 w-4 transition-transform duration-200', !isExpanded && '-rotate-90')}
          />
        </button>
        <div
          id={`sidebar-section-${section.id}`}
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out',
            isExpanded ? 'mt-1 grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div className="ml-5 space-y-1">
              {section.items.map((item) => (
                <SidebarNavigationLink
                  key={item.href}
                  item={item}
                  isActive={isNavigationItemActive(pathname, item)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => onOpenChange(true)}
      onMouseLeave={() => onOpenChange(false)}
      onFocus={() => onOpenChange(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onOpenChange(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onOpenChange(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => onOpenChange(!isOpen)}
        className={cn(
          'flex w-full items-center justify-center rounded-lg p-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isActive && 'bg-gold-light/25 text-gold-deep shadow-sm',
        )}
        aria-expanded={isOpen}
        aria-label={`${section.label}: mostrar opciones`}
        title={section.label}
      >
        <Icon className={cn('h-5 w-5', isActive && 'text-gold-deep')} />
      </button>

      {isOpen ? (
        <div className="absolute left-[calc(100%+0.75rem)] top-0 z-50 w-60 overflow-hidden rounded-xl border border-border bg-background p-2 shadow-xl">
          <div className="mb-1 flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <span>{section.label}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            {section.items.map((item) => (
              <SidebarNavigationLink
                key={item.href}
                item={item}
                isActive={isNavigationItemActive(pathname, item)}
                onNavigate={() => {
                  onOpenChange(false);
                  onNavigate?.();
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SidebarNavigationLink({
  item,
  collapsed = false,
  isActive,
  onNavigate,
}: {
  item: NavigationItem;
  collapsed?: boolean;
  isActive: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed && 'justify-center px-2.5',
        isActive
          ? 'bg-[#F6E6BE] text-[#704800] shadow-[inset_3px_0_0_#996B00]'
          : 'text-foreground hover:bg-surface-muted',
      )}
      title={collapsed ? item.name : undefined}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon className={cn('h-5 w-5 shrink-0', isActive && 'text-gold-deep')} />
      <span className={cn('min-w-0 truncate', collapsed && 'hidden')}>{item.name}</span>
    </Link>
  );
}

export function MobileNavigation() {
  const pathname = usePathname();
  const session = getSession();
  const sections = getNavigationSections(session);
  const visibleNavigation = sections.flatMap((section) => section.items);
  const quickNavigation = getMobileQuickNavigation(visibleNavigation);
  const groupedSections = sections.filter((section) => section.id !== 'main');
  const [activePopover, setActivePopover] = useState<NavigationGroupId | 'more' | null>(null);
  const quickNavigationIds = new Set(quickNavigation.map((item) => item.href));
  const moreNavigation = visibleNavigation.filter(
    (item) => !quickNavigationIds.has(item.href) && item.section === 'main',
  );
  const popoverItems =
    activePopover === 'more'
      ? moreNavigation
      : (sections.find((section) => section.id === activePopover)?.items ?? []);
  const popoverTitle =
    activePopover === 'more'
      ? 'Más opciones'
      : (sections.find((section) => section.id === activePopover)?.label ?? '');

  useEffect(() => {
    setActivePopover(null);
  }, [pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActivePopover(null);
    };

    if (!activePopover) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activePopover]);

  return (
    <>
      {activePopover ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default lg:hidden"
          aria-label="Cerrar opciones"
          onClick={() => setActivePopover(null)}
        />
      ) : null}

      <nav
        className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-white/95 px-2 pb-2 pt-1 shadow-2xl shadow-slate-950/10 backdrop-blur print:hidden lg:hidden"
        aria-label="Accesos rápidos"
      >
        {activePopover && popoverItems.length ? (
          <div className="absolute inset-x-2 bottom-[calc(100%+0.75rem)] overflow-hidden rounded-2xl border border-border bg-background p-2 text-foreground shadow-xl">
            <div className="sidebar-scrollbar max-h-[min(42vh,19rem)] overflow-y-auto">
              <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {popoverTitle}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {popoverItems.map((item) => {
                  const isActive = isNavigationItemActive(pathname, item);
                  const Icon = item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setActivePopover(null)}
                      className={cn(
                        'flex min-h-12 items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-gold-light/30 text-gold-deep'
                          : 'text-foreground hover:bg-muted',
                      )}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', isActive && 'text-gold-deep')} />
                      <span className="min-w-0 truncate">{item.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 gap-1">
          {quickNavigation.map((item) => {
            const isActive = isNavigationItemActive(pathname, item);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setActivePopover(null)}
                className={cn(
                  'flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-center text-[11px] font-medium text-muted-foreground transition-colors',
                  isActive ? 'bg-gold-light/30 text-gold-deep shadow-sm' : '',
                )}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="w-full truncate">{item.name}</span>
              </Link>
            );
          })}
          {groupedSections.map((section) => (
            <MobilePopoverTrigger
              key={section.id}
              label={section.label ?? section.id}
              icon={section.icon ?? ScrollText}
              active={section.items.some((item) => isNavigationItemActive(pathname, item))}
              open={activePopover === section.id}
              onClick={() =>
                setActivePopover((current) =>
                  current === section.id ? null : (section.id as NavigationGroupId),
                )
              }
            />
          ))}
          {moreNavigation.length ? (
            <MobilePopoverTrigger
              label="Más"
              icon={MoreHorizontal}
              active={moreNavigation.some((item) => isNavigationItemActive(pathname, item))}
              open={activePopover === 'more'}
              onClick={() => setActivePopover((current) => (current === 'more' ? null : 'more'))}
            />
          ) : null}
        </div>
      </nav>
    </>
  );
}

function MobilePopoverTrigger({
  label,
  icon: Icon,
  active,
  open,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-center text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        (active || open) && 'bg-gold-light/30 text-gold-deep shadow-sm',
      )}
      aria-expanded={open}
      aria-label={`${label}: mostrar opciones`}
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span className="w-full truncate">{label}</span>
    </button>
  );
}

export function getNavigationSections(session: AuthSession | null): NavigationSection[] {
  const visibleNavigation = getVisibleNavigation(session);

  return sectionDefinitions.flatMap((section) => {
    const items = visibleNavigation.filter((item) => item.section === section.id);
    return items.length ? [{ ...section, items }] : [];
  });
}

export function getVisibleNavigation(session: AuthSession | null) {
  if (session?.role === 'WAREHOUSE_KEEPER') {
    return [warehouseNavigationItem];
  }

  if (isAccountantSession(session)) {
    const accountantPaths = new Set([
      '/dashboard',
      '/products',
      '/customers',
      '/invoices',
      '/suppliers',
      '/purchase-orders',
      '/supplier-invoices',
      '/payables',
      '/receivables',
      '/credit-approvals',
      '/cash/logs',
      '/cash/sessions',
      '/cash/registers',
      '/settings/fiscal-sequences',
      '/operations/logs',
    ]);

    return navigation.filter((item) => accountantPaths.has(item.href));
  }

  if (isAdminSession(session)) {
    return navigation;
  }

  if (canTakeOrders(session) && canUsePosSession(session)) {
    return navigation.filter((item) =>
      [
        '/orders',
        '/pos',
        '/returns',
        '/products',
        '/customers',
        '/invoices',
        '/quotations',
        '/receivables',
      ].includes(item.href),
    );
  }

  if (canTakeOrders(session)) {
    return navigation.filter((item) => item.href === '/orders');
  }

  if (canUsePosSession(session)) {
    return navigation.filter((item) => item.href === '/pos' || item.href === '/returns');
  }

  return [];
}

function getMobileQuickNavigation(items: NavigationItem[]) {
  const preferredPaths = ['/dashboard', '/pos', '/orders', '/invoices'];
  const quickItems: NavigationItem[] = [];

  preferredPaths.forEach((href) => {
    if (quickItems.length >= 1) return;
    const item = items.find((candidate) => candidate.href === href);
    if (item) quickItems.push(item);
  });

  items.forEach((item) => {
    if (quickItems.length < 1 && !quickItems.some((candidate) => candidate.href === item.href)) {
      quickItems.push(item);
    }
  });

  return quickItems;
}

function isNavigationItemActive(pathname: string, item: NavigationItem) {
  if (item.href === '/settings') return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

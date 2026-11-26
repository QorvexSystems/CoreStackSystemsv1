'use client';

import { Building2, ChevronDown, LogOut, Menu, Search } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, getSession, type AuthSession } from '@/lib/auth-session';
import { canAccessPath, getDefaultPathForSession } from '@/lib/authorization';
import { brand } from '@/lib/brand';
import { translateRole } from '@/lib/display-labels';
import { cn } from '@/lib/utils';
import { revokeThisDevice } from '@/lib/push-client';
import { CheckoutOverdueWatcher } from '@/components/hotel/checkout-overdue-watcher';
import { GlobalSearch } from './global-search';
import { NotificationBell } from './notification-bell';
import { MobileNavigation, Sidebar } from './sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [userMenu, setUserMenu] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const current = getSession();
    setSession(current);
    if (!current) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    } else if (!canAccessPath(current, pathname)) {
      router.replace(getDefaultPathForSession(current));
    }
  }, [pathname, router]);

  if (!session) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f7f6f2] text-sm text-slate-500">
        {session === undefined ? 'Validando sesión...' : 'Redirigiendo al acceso...'}
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-[#f7f6f2]">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
      <div
        className={cn(
          'min-h-screen pb-20 transition-[padding] duration-200 lg:pb-0',
          collapsed ? 'lg:pl-[4.75rem]' : 'lg:pl-[15rem]',
        )}
      >
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur print:hidden">
          <div className="flex h-16 items-center gap-4 px-4 sm:px-6">
            <button
              type="button"
              className="text-slate-500 lg:hidden"
              aria-label="Abrir navegación"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="hidden min-w-[15rem] items-center gap-3 xl:flex">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-light text-teal-deep">
                <Building2 className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-bold text-slate-950">Hotel Suite Ancla</p>
                <p className="text-xs text-slate-500">Operación del hotel</p>
              </div>
            </div>
            <div className="flex flex-1 justify-center">
              <GlobalSearch session={session} />
            </div>
            <button
              type="button"
              onClick={() => setMobileSearch((value) => !value)}
              className="rounded-lg p-2 text-slate-500 md:hidden"
              aria-label="Buscar"
            >
              <Search className="h-5 w-5" />
            </button>
            {session.role !== 'HOUSEKEEPING' && session.role !== 'ACCOUNTANT' ? (
              <NotificationBell session={session} />
            ) : null}
            <div className="relative">
              <button
                type="button"
                onClick={() => setUserMenu((value) => !value)}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-50"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0d746d] text-xs font-bold text-white">
                  {session.user.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="hidden text-left sm:block">
                  <span className="block max-w-32 truncate text-sm font-semibold text-slate-900">
                    {session.user.name}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {translateRole(session.role)}
                  </span>
                </span>
                <ChevronDown className="hidden h-4 w-4 text-slate-500 sm:block" />
              </button>
              {userMenu ? (
                <div className="absolute right-0 top-12 w-48 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
                  <button
                    type="button"
                    onClick={async () => {
                      // Este dispositivo deja de recibir los avisos de la cuenta que sale.
                      await revokeThisDevice(session.tenantId, session.accessToken);
                      clearSession();
                      router.replace('/login');
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <LogOut className="h-4 w-4" /> Cerrar sesión
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {mobileSearch ? (
            <div className="border-t border-slate-100 p-3 md:hidden">
              <GlobalSearch session={session} mobile />
            </div>
          ) : null}
        </header>
        <main className="mx-auto w-full max-w-[120rem] px-3 py-4 sm:px-5 sm:py-5">{children}</main>
        <CheckoutOverdueWatcher session={session} />
      </div>
      <MobileNavigation />
    </div>
  );
}

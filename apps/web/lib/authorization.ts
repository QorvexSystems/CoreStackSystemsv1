import type { AuthSession } from './auth-session';

const adminRoles = ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN'];
const receptionPaths = new Set(['/reservations', '/check-in-out', '/rooms', '/guests', '/housekeeping', '/express-invoices']);

export function isAdminSession(session: AuthSession | null | undefined) {
  return Boolean(session?.role && adminRoles.includes(session.role));
}

export function isAccountantSession(session: AuthSession | null | undefined) {
  return session?.role === 'ACCOUNTANT';
}

export function isWarehouseKeeperSession(session: AuthSession | null | undefined) {
  return session?.role === 'WAREHOUSE_KEEPER';
}

export function isReceptionSession(session: AuthSession | null | undefined) {
  return session?.role === 'RECEPTION';
}

export function isHousekeepingSession(session: AuthSession | null | undefined) {
  return session?.role === 'HOUSEKEEPING';
}

export function canTakeOrders(session: AuthSession | null | undefined) {
  return Boolean(
    isAdminSession(session) ||
    session?.role === 'ORDER_TAKER' ||
    session?.permissions.canTakeOrders,
  );
}

export function canUsePosSession(session: AuthSession | null | undefined) {
  return Boolean(
    isAdminSession(session) || session?.role === 'CASHIER' || session?.permissions.canUsePos,
  );
}

export function canAccessPath(session: AuthSession | null | undefined, pathname: string) {
  if (!session) {
    return false;
  }

  if (pathname === '/receivables' || pathname.startsWith('/receivables/')) {
    return false;
  }

  // Pantalla de cobro de una reservación (pad numérico para tablet).
  if (/^\/reservations\/[^/]+\/payment$/.test(pathname)) {
    return isAdminSession(session) || isReceptionSession(session) || session.role === 'CASHIER';
  }

  if (isReceptionSession(session)) {
    // Pantallas completas de crear/editar reservaciones.
    if (pathname === '/reservations/new' || /^\/reservations\/[^/]+\/edit$/.test(pathname)) return true;
    return receptionPaths.has(pathname);
  }

  if (isHousekeepingSession(session)) {
    return pathname === '/housekeeping' || pathname.startsWith('/housekeeping/');
  }

  // El contador del hotel solo trabaja con la facturación.
  if (isAccountantSession(session)) {
    return pathname === '/invoices' || pathname.startsWith('/invoices/') || pathname === '/fiscal-sequences';
  }

  if (isWarehouseKeeperSession(session)) {
    return pathname === '/warehouse';
  }

  if (
    session.role === 'ORDER_TAKER' &&
    ['/products', '/customers', '/invoices', '/quotations', '/receivables'].some(
      (path) => pathname === path || pathname.startsWith(path + '/'),
    )
  ) {
    return !pathname.endsWith('/new') && !pathname.endsWith('/edit');
  }

  if (pathname === '/quotations' || pathname.startsWith('/quotations/')) {
    return isAdminSession(session);
  }

  if (pathname === '/returns' || pathname.startsWith('/returns/')) {
    return canUsePosSession(session);
  }

  if (isAdminSession(session)) {
    return true;
  }

  if (canUsePosSession(session) && (pathname === '/pos' || pathname.startsWith('/pos/'))) {
    return true;
  }

  if (canTakeOrders(session) && (pathname === '/orders' || pathname.startsWith('/orders/'))) {
    return true;
  }

  return Boolean(
    session.permissions.canReprintReceipt &&
    pathname.startsWith('/invoices/') &&
    pathname.endsWith('/print'),
  );
}

export function getDefaultPathForSession(session: AuthSession | null | undefined) {
  if (!session) {
    return '/login';
  }

  if (isReceptionSession(session)) {
    return '/reservations';
  }

  if (isHousekeepingSession(session)) {
    return '/housekeeping';
  }

  // El administrador revisa disponibilidad todo el tiempo: entra directo al calendario de reservaciones.
  if (isAdminSession(session)) {
    return '/reservations';
  }

  if (isAccountantSession(session)) {
    return '/invoices';
  }

  if (isWarehouseKeeperSession(session)) {
    return '/warehouse';
  }

  if (canTakeOrders(session)) {
    return '/orders';
  }

  if (canUsePosSession(session)) {
    return '/pos';
  }

  return '/dashboard';
}

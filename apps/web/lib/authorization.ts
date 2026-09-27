import type { AuthSession } from './auth-session';

const adminRoles = ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN'];
const accountantExactPaths = new Set([
  '/dashboard',
  '/products',
  '/customers',
  '/inventory',
  '/invoices',
  '/cash/logs',
  '/cash/sessions',
  '/operations/logs',
]);
const accountantNestedPaths = [
  '/dashboard/',
  '/invoices/',
  '/suppliers/',
  '/purchase-orders/',
  '/supplier-invoices/',
  '/payables/',
  '/receivables/',
  '/credit-approvals/',
  '/operations/logs/',
];
const accountantModulePaths = new Set([
  '/suppliers',
  '/purchase-orders',
  '/supplier-invoices',
  '/payables',
  '/receivables',
  '/credit-approvals',
]);

export function isAdminSession(session: AuthSession | null | undefined) {
  return Boolean(session?.role && adminRoles.includes(session.role));
}

export function isAccountantSession(session: AuthSession | null | undefined) {
  return session?.role === 'ACCOUNTANT';
}

export function isWarehouseKeeperSession(session: AuthSession | null | undefined) {
  return session?.role === 'WAREHOUSE_KEEPER';
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

  if (isAccountantSession(session)) {
    return (
      accountantExactPaths.has(pathname) ||
      accountantModulePaths.has(pathname) ||
      accountantNestedPaths.some((prefix) => pathname.startsWith(prefix))
    );
  }

  if (isWarehouseKeeperSession(session)) {
    return pathname === '/warehouse';
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

  if (isAdminSession(session)) {
    return '/dashboard';
  }

  if (isAccountantSession(session)) {
    return '/dashboard';
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

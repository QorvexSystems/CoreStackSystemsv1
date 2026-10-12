import type { LoginResponse } from './api';
import { sessionCookieName, sessionKey } from './auth-constants';

export type AuthSession = {
  accessToken: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  salePricesIncludeTax: boolean;
  role: string;
  permissions: Record<string, boolean>;
  user: LoginResponse['user'];
  expiresAt: number;
};

export function saveSession(login: LoginResponse) {
  const membership = login.memberships[0];

  if (!membership) {
    throw new Error('User has no active tenant memberships.');
  }

  const session: AuthSession = {
    accessToken: login.accessToken,
    tenantId: membership.tenantId,
    tenantName: membership.tenantName,
    tenantSlug: membership.tenantSlug,
    salePricesIncludeTax: membership.salePricesIncludeTax,
    role: membership.role,
    permissions: membership.permissions,
    user: login.user,
    expiresAt: Date.now() + parseExpiresInSeconds(login.expiresIn) * 1000,
  };

  window.localStorage.setItem(sessionKey, JSON.stringify(session));
  setSessionCookie(parseExpiresInSeconds(login.expiresIn));
  return session;
}

export function getSession() {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(sessionKey);

  if (!raw) {
    return null;
  }

  try {
    const session = JSON.parse(raw) as AuthSession;

    if (
      !session.accessToken ||
      !session.tenantId ||
      !session.expiresAt ||
      session.expiresAt <= Date.now()
    ) {
      clearSession();
      return null;
    }

    return session;
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(sessionKey);
  document.cookie = `${sessionCookieName}=; Path=/; Max-Age=0; SameSite=Strict${getSecureCookieAttribute()}`;
}

function setSessionCookie(maxAgeSeconds: number) {
  document.cookie = `${sessionCookieName}=1; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Strict${getSecureCookieAttribute()}`;
}

function getSecureCookieAttribute() {
  return window.location.protocol === 'https:' ? '; Secure' : '';
}

function parseExpiresInSeconds(value: string) {
  const match = value.match(/^(\d+)([smhd])$/);

  if (!match) {
    return 8 * 60 * 60;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (unit === 's') {
    return amount;
  }

  if (unit === 'm') {
    return amount * 60;
  }

  if (unit === 'h') {
    return amount * 60 * 60;
  }

  return amount * 24 * 60 * 60;
}

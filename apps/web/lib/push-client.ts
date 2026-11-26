'use client';

import {
  getPushConfig,
  registerPushSubscription,
  revokePushSubscription,
} from './api';

// Notificaciones push en este dispositivo (mismo enfoque que MOI). En iPhone solo funcionan con el ERP
// instalado en la pantalla de inicio (iOS 16.4+), y el permiso debe pedirse desde un toque del usuario.

export type PushState = 'checking' | 'unsupported' | 'ios-install' | 'denied' | 'inactive' | 'active';

export function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function getPushState(): Promise<PushState> {
  if (isIOS() && !isStandalone()) return 'ios-install';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription && Notification.permission === 'granted' ? 'active' : 'inactive';
}

async function ensureServiceWorker() {
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: 'not-configured' | 'denied' | 'dismissed' | 'unsupported' | 'failed'; message?: string };

/** Debe llamarse desde un clic del usuario. */
export async function enablePush(tenantId: string, accessToken: string): Promise<EnableResult> {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  const config = await getPushConfig(tenantId, accessToken);
  if (!config.enabled || !config.publicKey) return { ok: false, reason: 'not-configured' };
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
  try {
    const registration = await ensureServiceWorker();
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      }));
    const json = subscription.toJSON();
    try {
      await registerPushSubscription(tenantId, accessToken, {
        endpoint: json.endpoint!,
        expirationTime: json.expirationTime ?? null,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      });
    } catch (error) {
      await subscription.unsubscribe().catch(() => undefined);
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'failed', message: (error as Error).message };
  }
}

export async function disablePush(tenantId: string, accessToken: string) {
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await revokePushSubscription(tenantId, accessToken, subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

/**
 * Al cerrar sesión: este teléfono deja de recibir los avisos de esa cuenta. Nunca bloquea el cierre
 * de sesión (máximo 3 segundos).
 */
export async function revokeThisDevice(tenantId: string, accessToken: string) {
  if (typeof window === 'undefined' || !supported()) return;
  await Promise.race([
    disablePush(tenantId, accessToken).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

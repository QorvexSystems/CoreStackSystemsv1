import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MembershipStatus, Role } from '@qorvex/database';
import webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';

export type PushPayload = {
  title: string;
  body: string;
  /** Ruta interna del ERP que se abre al tocar la notificación. */
  url: string;
  /** Un reenvío con el mismo tag reemplaza la notificación anterior en vez de duplicarla. */
  tag?: string;
};

export type PushSubscriptionInput = {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: { p256dh?: string; auth?: string };
};

// Solo servicios push reales: evita que el servidor haga solicitudes a direcciones arbitrarias (SSRF).
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const NOTIFY_ROLES: Role[] = [Role.ADMIN, Role.SUPER_ADMIN];
const SEND_TIMEOUT_MS = 8_000;

function isAllowedEndpoint(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
      return false;
    return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

/**
 * Notificaciones push al celular (Web Push con claves VAPID). Si faltan VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY o VAPID_SUBJECT, el push queda apagado y nada falla.
 */
@Injectable()
export class HotelPushService {
  private readonly logger = new Logger(HotelPushService.name);
  private ready: boolean | null = null;

  constructor(private readonly prisma: PrismaService) {}

  config() {
    return { enabled: this.isConfigured(), publicKey: this.isConfigured() ? process.env.VAPID_PUBLIC_KEY!.trim() : null };
  }

  private isConfigured() {
    if (this.ready !== null) return this.ready;
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim();
    if (!publicKey || !privateKey || !subject) return (this.ready = false);
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      return (this.ready = true);
    } catch {
      this.logger.error('Las claves VAPID no son válidas; push desactivado.');
      return (this.ready = false);
    }
  }

  async register(tenantId: string, userId: string, input: PushSubscriptionInput, userAgent?: string) {
    const endpoint = input.endpoint?.trim() ?? '';
    const p256dh = input.keys?.p256dh?.trim();
    const auth = input.keys?.auth?.trim();
    if (!endpoint || endpoint.length > 2048 || !isAllowedEndpoint(endpoint) || !p256dh || !auth)
      throw new BadRequestException('Suscripción de notificaciones no válida.');
    // Si otra cuenta usó este navegador antes, el dispositivo pasa a la sesión actual.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { tenantId, userId, endpoint, p256dh, auth, userAgent: userAgent?.slice(0, 300) },
      update: {
        tenantId,
        userId,
        p256dh,
        auth,
        userAgent: userAgent?.slice(0, 300),
        lastSeenAt: new Date(),
        failureCount: 0,
        revokedAt: null,
      },
    });
    return { ok: true as const };
  }

  async revoke(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.updateMany({
      where: { userId, endpoint, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true as const };
  }

  async sendTest(tenantId: string, userId: string) {
    const sent = await this.sendTo({ tenantId, userId }, {
      title: 'Notificaciones activadas',
      body: 'Así te avisaremos cuando llegue una solicitud de reserva desde la web.',
      url: '/reservations',
      tag: `test:${userId}`,
    });
    return { sent };
  }

  /** Avisa a los administradores del hotel en todos sus dispositivos. Nunca lanza error. */
  async notifyAdmins(tenantId: string, payload: PushPayload) {
    try {
      const admins = await this.prisma.membership.findMany({
        where: { tenantId, status: MembershipStatus.ACTIVE, role: { in: NOTIFY_ROLES } },
        select: { userId: true },
      });
      if (!admins.length) return 0;
      return await this.sendTo({ tenantId, userId: { in: admins.map((item) => item.userId) } }, payload);
    } catch (error) {
      this.logger.error(`No se pudo enviar el push a los administradores: ${String(error)}`);
      return 0;
    }
  }

  private async sendTo(
    where: { tenantId: string; userId: string | { in: string[] } },
    payload: PushPayload,
  ) {
    if (!this.isConfigured()) return 0;
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { ...where, revokedAt: null },
    });
    const body = JSON.stringify(payload);
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            body,
            { TTL: 60 * 60 * 24, urgency: 'high', timeout: SEND_TIMEOUT_MS },
          );
          await this.prisma.pushSubscription.update({
            where: { id: subscription.id },
            data: { lastSuccessAt: new Date(), failureCount: 0 },
          });
          return true;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          // 404/410: el navegador anuló la suscripción; se da de baja.
          await this.prisma.pushSubscription
            .update({
              where: { id: subscription.id },
              data:
                status === 404 || status === 410
                  ? { revokedAt: new Date() }
                  : { failureCount: { increment: 1 } },
            })
            .catch(() => undefined);
          this.logger.warn(`Push fallido (${status ?? 'sin código'}) para el dispositivo ${subscription.id}`);
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  }
}

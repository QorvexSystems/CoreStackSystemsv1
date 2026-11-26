import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export function normalizeWhatsappRecipient(value: string | null): string | null {
  let digits = (value ?? '').replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) digits = `1${digits}`;
  return /^[1-9][0-9]{10,14}$/.test(digits) ? digits : null;
}

@Injectable()
export class WhatsappReadyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappReadyService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  // Kept replaceable for isolated provider tests; real requests always use Meta's fixed origin.
  request: typeof fetch = (...args) => fetch(...args);

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}

  configuration() {
    const keys = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_READY_TEMPLATE'];
    const missing = keys.filter((key) => !this.config.get<string>(key)?.trim());
    const enabled = this.config.get<string>('WHATSAPP_AUTOMATIC_READY_ENABLED') === 'true';
    const version = this.config.get<string>('WHATSAPP_GRAPH_API_VERSION') ?? 'v23.0';
    const language = this.config.get<string>('WHATSAPP_TEMPLATE_LANGUAGE') ?? 'es';
    const valid =
      /^v\d+\.\d+$/.test(version) &&
      /^\d+$/.test(this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '') &&
      /^[a-z0-9_]+$/.test(this.config.get<string>('WHATSAPP_READY_TEMPLATE') ?? '') &&
      /^[a-z]{2}(?:_[A-Z]{2})?$/.test(language);
    return { configured: enabled && missing.length === 0 && valid, enabled, missing };
  }

  async status(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    const counts = await this.db.workshopReadyNotification.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: true,
    });
    return {
      ...this.configuration(),
      configured:
        this.configuration().configured &&
        tenant?.slug ===
          (this.config.get<string>('WHATSAPP_TENANT_SLUG') ?? 'solucionesautomotrizcyr'),
      counts: Object.fromEntries(counts.map((row) => [row.status, row._count])),
    };
  }

  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.processQueue().catch(() =>
          this.logger.error('No se pudo procesar la cola de avisos de WhatsApp.'),
        ),
      30000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async processQueue() {
    if (this.running || !this.configuration().configured) return;
    this.running = true;
    try {
      const now = new Date();
      const scope = {
        tenant: {
          slug: this.config.get<string>('WHATSAPP_TENANT_SLUG') ?? 'solucionesautomotrizcyr',
          status: 'ACTIVE' as const,
        },
      };
      // An interrupted send has an unknown delivery outcome. Never resend it blindly.
      await this.db.workshopReadyNotification.updateMany({
        where: {
          ticket: scope,
          status: 'SENDING',
          lockedAt: { lt: new Date(now.getTime() - 5 * 60000) },
        },
        data: { status: 'UNCERTAIN', lastError: 'REVIEW_DELIVERY_BEFORE_RETRY' },
      });
      const rows = await this.db.workshopReadyNotification.findMany({
        where: { ticket: scope, status: { in: ['PENDING', 'RETRY'] }, nextAttemptAt: { lte: now } },
        orderBy: { createdAt: 'asc' },
        take: 10,
        select: { id: true },
      });
      for (const row of rows) await this.deliver(row.id);
    } finally {
      this.running = false;
    }
  }

  private async deliver(id: string) {
    const job = await this.db.$transaction(async (tx) => {
      const row = await tx.workshopReadyNotification.findUnique({
        where: { id },
        include: {
          ticket: {
            include: {
              tenant: true,
              customer: true,
              vehicle: true,
              salesOrder: { include: { invoice: true } },
            },
          },
        },
      });
      if (!row || !['PENDING', 'RETRY'].includes(row.status) || row.nextAttemptAt > new Date())
        return null;
      const ticket = row.ticket;
      if (['DELIVERED', 'CANCELLED'].includes(ticket.status)) {
        await tx.workshopReadyNotification.update({
          where: { id },
          data: { status: 'CANCELLED', lastError: 'VEHICLE_NO_LONGER_AWAITING_PICKUP' },
        });
        return null;
      }
      const invoice = ticket.salesOrder?.invoice;
      const eligible =
        ticket.status === 'READY_FOR_DELIVERY' &&
        invoice?.status === 'PAID' &&
        invoice.tenantId === row.tenantId &&
        ticket.tenant.status === 'ACTIVE' &&
        invoice.balance.lte(0);
      const recipient = normalizeWhatsappRecipient(ticket.customer.phone);
      if (!eligible || !recipient) {
        await tx.workshopReadyNotification.updateMany({
          where: { id, status: { in: ['PENDING', 'RETRY'] } },
          data: {
            nextAttemptAt: new Date(Date.now() + 60000),
            lastError: !eligible ? 'WAITING_FOR_READY_AND_PAID' : 'VALID_CUSTOMER_PHONE_REQUIRED',
          },
        });
        return null;
      }
      const claimed = await tx.workshopReadyNotification.updateMany({
        where: { id, status: { in: ['PENDING', 'RETRY'] }, nextAttemptAt: { lte: new Date() } },
        data: {
          status: 'SENDING',
          lockedAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      return claimed.count === 1 ? { ...row, recipient } : null;
    });
    if (!job) return;
    const version = this.config.get<string>('WHATSAPP_GRAPH_API_VERSION') ?? 'v23.0';
    const phoneId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')!;
    const values = [
      job.ticket.customer.name,
      [job.ticket.vehicle.make, job.ticket.vehicle.model, job.ticket.vehicle.licensePlate]
        .filter(Boolean)
        .join(' · '),
      job.ticket.ticketNumber,
      job.ticket.tenant.address ?? job.ticket.tenant.name,
    ];
    try {
      const response = await this.request(
        `https://graph.facebook.com/${version}/${phoneId}/messages`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${this.config.get<string>('WHATSAPP_ACCESS_TOKEN')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: job.recipient,
            type: 'template',
            template: {
              name: this.config.get<string>('WHATSAPP_READY_TEMPLATE'),
              language: { code: this.config.get<string>('WHATSAPP_TEMPLATE_LANGUAGE') ?? 'es' },
              components: [
                {
                  type: 'body',
                  parameters: values.map((text) => ({
                    type: 'text',
                    text: text.replace(/\s+/g, ' ').slice(0, 1024),
                  })),
                },
              ],
            },
          }),
        },
      );
      if (!response.ok) {
        // 429 explicitly rejects the submission, so it is safe to retry. Timeouts/5xx can be ambiguous.
        const retry = response.status === 429 && job.attempts + 1 < 5;
        await this.db.workshopReadyNotification.update({
          where: { id },
          data: {
            status: retry ? 'RETRY' : response.status >= 500 ? 'UNCERTAIN' : 'FAILED',
            lastError: `META_HTTP_${response.status}`,
            nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts)),
          },
        });
        return;
      }
      const body = (await response.json()) as { messages?: Array<{ id?: string }> };
      const messageId = body.messages?.[0]?.id;
      await this.db.workshopReadyNotification.update({
        where: { id },
        data: messageId
          ? { status: 'SENT', messageId, sentAt: new Date(), lastError: null }
          : { status: 'UNCERTAIN', lastError: 'META_RESPONSE_MISSING_MESSAGE_ID' },
      });
    } catch {
      await this.db.workshopReadyNotification.update({
        where: { id },
        data: { status: 'UNCERTAIN', lastError: 'PROVIDER_OUTCOME_UNKNOWN_REVIEW_BEFORE_RETRY' },
      });
    }
  }
}

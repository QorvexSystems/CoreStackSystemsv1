import { Injectable, Logger } from '@nestjs/common';
import { ElectronicDocumentStatus } from '@qorvex/database';
import { Resend } from 'resend';
import { PrismaService } from '../../prisma/prisma.service';

type EcfEmailCopy = {
  electronicDocumentId: string;
  invoiceId: string;
  recipients: string[];
  subject: string;
  templateVariables: Record<string, string>;
};

type OrderReadyEmail = {
  orderId: string;
  orderNumber: string;
  recipient: string;
  clientName: string;
  deliveryLabel: string;
};

@Injectable()
export class ResendService {
  private readonly logger = new Logger(ResendService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sendEcfCopy(input: EcfEmailCopy) {
    if (process.env.ENABLE_EMAIL_DELIVERY !== 'true') {
      await this.markFailure(
        input.electronicDocumentId,
        'Correo real pendiente de configurar; envío desactivado.',
      );
      return;
    }
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    const templateId = process.env.RESEND_ECF_TEMPLATE_ID;

    if (!apiKey || !from || !templateId) {
      await this.markFailure(
        input.electronicDocumentId,
        'Falta configurar RESEND_API_KEY, RESEND_FROM o RESEND_ECF_TEMPLATE_ID.',
      );
      return;
    }

    try {
      const resend = new Resend(apiKey);
      if (!input.recipients.length) {
        throw new Error('No hay destinatarios para la copia e-CF.');
      }

      const deliveries = await Promise.all(
        input.recipients.map(async (recipient, index) => {
          const { data, error } = await resend.emails.send({
            from,
            to: [recipient],
            subject: input.subject,
            template: {
              id: templateId,
              variables: input.templateVariables,
            },
            headers: {
              'Idempotency-Key': `ecf-copy-${input.invoiceId}-${index}`,
            },
          });

          if (error || !data?.id) {
            throw new Error(error?.message ?? `Resend no pudo enviar el correo a ${recipient}.`);
          }

          return { recipient, emailId: data.id };
        }),
      );

      await this.prisma.electronicDocument.update({
        where: { id: input.electronicDocumentId },
        data: {
          status: ElectronicDocumentStatus.SENT,
          externalId: deliveries.map((delivery) => delivery.emailId).join(','),
          errorMessage: null,
          responsePayload: {
            provider: 'RESEND',
            status: 'SENT',
            deliveries,
            recipients: input.recipients,
            sentAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo enviar la copia e-CF.';
      this.logger.error(`No se pudo enviar la copia e-CF ${input.invoiceId}: ${message}`);
      await this.markFailure(input.electronicDocumentId, message);
    }
  }

  async sendOrderReady(input: OrderReadyEmail) {
    if (process.env.ENABLE_EMAIL_DELIVERY !== 'true')
      return {
        sent: false as const,
        error: 'Correo real pendiente de configurar; envío desactivado.',
      };
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!apiKey || !from) {
      return { sent: false as const, error: 'Falta configurar RESEND_API_KEY o RESEND_FROM.' };
    }
    try {
      const resend = new Resend(apiKey);
      const { data, error } = await resend.emails.send({
        from,
        to: [input.recipient],
        subject: `Tu orden ${input.orderNumber} está lista`,
        html: `<p>Hola ${escapeHtml(input.clientName)},</p><p>Tu orden <strong>${escapeHtml(input.orderNumber)}</strong> está lista.</p><p>${escapeHtml(input.deliveryLabel)}</p><p>Gracias por elegir Unique Personalizado.</p>`,
        headers: { 'Idempotency-Key': `order-ready-${input.orderId}` },
      });
      if (error || !data?.id) throw new Error(error?.message ?? 'Resend no confirmó el envío.');
      return { sent: true as const, id: data.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo enviar el correo.';
      this.logger.error(`No se pudo notificar la orden ${input.orderNumber}: ${message}`);
      return { sent: false as const, error: message.slice(0, 1000) };
    }
  }

  private async markFailure(electronicDocumentId: string, message: string) {
    await this.prisma.electronicDocument.update({
      where: { id: electronicDocumentId },
      data: {
        status: ElectronicDocumentStatus.FAILED,
        errorMessage: message.slice(0, 1000),
        responsePayload: {
          provider: 'RESEND',
          status: 'FAILED',
          error: message.slice(0, 1000),
        },
      },
    });
  }
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character]!,
  );
}

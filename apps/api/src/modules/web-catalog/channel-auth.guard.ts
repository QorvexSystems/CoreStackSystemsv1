import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@qorvex/database';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { channelCredentialsFromEnv, channelToleranceSeconds, NonceStore, verifyChannelRequest, type ChannelCredentials } from './channel-auth';

export type ChannelRequest = Request & { rawBody?: Buffer; channelTenantId?: string };

/**
 * Protege /channel/*. Sin configuración del canal responde 404 (funcionalidad apagada por defecto).
 * El tenant sale de la credencial, nunca de una cabecera o parámetro del cliente.
 */
@Injectable()
export class ChannelAuthGuard implements CanActivate {
  private readonly logger = new Logger(ChannelAuthGuard.name);
  private readonly nonces = new NonceStore();
  private tenantCache: { slug: string; id: string } | null = null;
  private lastPurge = 0;

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ChannelRequest>();
    const credentials: ChannelCredentials | null = channelCredentialsFromEnv(process.env);
    if (!credentials) throw new NotFoundException();

    const header = (name: string) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const toleranceSeconds = channelToleranceSeconds(process.env);
    const result = verifyChannelRequest(
      credentials,
      {
        keyId: header('x-channel-key-id'),
        timestamp: header('x-channel-timestamp'),
        nonce: header('x-channel-nonce'),
        signature: header('x-channel-signature'),
      },
      { method: request.method, pathAndQuery: request.originalUrl, body: request.rawBody ?? Buffer.alloc(0) },
      { nowMs: Date.now(), nonces: this.nonces, toleranceSeconds },
    );
    if (!result.ok) {
      this.logger.warn(`Solicitud de canal rechazada: ${result.reason}`);
      throw new UnauthorizedException();
    }

    await this.registerNonce(credentials.keyId, header('x-channel-nonce') as string, toleranceSeconds);

    if (this.tenantCache?.slug !== credentials.tenantSlug) {
      const tenant = await this.prisma.tenant.findUnique({ where: { slug: credentials.tenantSlug }, select: { id: true } });
      if (!tenant) throw new NotFoundException();
      this.tenantCache = { slug: credentials.tenantSlug, id: tenant.id };
    }
    request.channelTenantId = this.tenantCache.id;
    return true;
  }

  /**
   * Un nonce solo sirve una vez en TODAS las instancias: se guarda en la base compartida con restricción única.
   * Si la base no responde se rechaza (falla cerrada): sin ella no se puede garantizar la no repetición.
   */
  private async registerNonce(keyId: string, nonce: string, toleranceSeconds: number) {
    const now = Date.now();
    try {
      await this.prisma.channelNonce.create({ data: { keyId, nonce, expiresAt: new Date(now + toleranceSeconds * 2000) } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.warn('Solicitud de canal rechazada: replayed-nonce');
        throw new UnauthorizedException();
      }
      this.logger.error('No se pudo registrar el nonce del canal.');
      throw new ServiceUnavailableException();
    }
    if (now - this.lastPurge > 60_000) {
      this.lastPurge = now;
      void this.prisma.channelNonce.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }).catch(() => undefined);
    }
  }
}

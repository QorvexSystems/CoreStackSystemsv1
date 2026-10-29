import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { channelCredentialsFromEnv, signChannelRequest } from './channel-auth';

/**
 * Aviso opcional al e-commerce para que revalide su caché cuando cambia el catálogo web.
 * Deshabilitado salvo que existan CHANNEL_REVALIDATE_URL y las credenciales del canal. No transporta
 * datos comerciales: solo el tipo de evento y los IDs comerciales afectados, firmado con el mismo HMAC.
 * Es de mejor esfuerzo y con tope de 2 s: un fallo nunca bloquea ni revierte la operación del ERP (el e-commerce también
 * revalida por tiempo).
 */
@Injectable()
export class ChannelNotifierService {
  private readonly logger = new Logger(ChannelNotifierService.name);

  async notify(event: 'catalog.changed', ids: string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    const rawUrl = process.env.CHANNEL_REVALIDATE_URL?.trim();
    if (!rawUrl) return false;
    const credentials = channelCredentialsFromEnv(process.env);
    if (!credentials) return false;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      this.logger.warn('CHANNEL_REVALIDATE_URL no es una URL válida.');
      return false;
    }
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
      this.logger.warn('CHANNEL_REVALIDATE_URL debe usar https (http solo en localhost).');
      return false;
    }
    const body = JSON.stringify({ event, ids: [...new Set(ids)].slice(0, 100) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = signChannelRequest(credentials.secret, {
      timestamp,
      nonce,
      method: 'POST',
      pathAndQuery: url.pathname + url.search,
      body,
    });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-channel-key-id': credentials.keyId,
          'x-channel-timestamp': timestamp,
          'x-channel-nonce': nonce,
          'x-channel-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      this.logger.warn('No se pudo avisar al e-commerce; revalidará por tiempo.');
      return false;
    }
  }
}

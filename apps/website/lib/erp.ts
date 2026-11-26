import 'server-only';
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Cliente del ERP. Firma cada solicitud con HMAC-SHA256 igual que ChannelAuthGuard del API:
//   canonical = v1 \n timestamp \n nonce \n MÉTODO \n ruta?query \n sha256(cuerpo)
// El secreto solo existe en el servidor del sitio; el navegador habla con /api/* de este sitio.

export class ErpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function config() {
  const baseUrl = process.env.ERP_API_URL?.trim() || process.env.API_INTERNAL_URL?.trim();
  const keyId = process.env.CHANNEL_API_KEY_ID?.trim();
  const secret = process.env.CHANNEL_API_SECRET?.trim();
  if (!baseUrl || !keyId || !secret)
    throw new ErpError(503, 'Las reservas en línea no están configuradas todavía.');
  return { baseUrl: baseUrl.replace(/\/$/, ''), keyId, secret };
}

export async function erpRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const { baseUrl, keyId, secret } = config();
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(options.query ?? {}))
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const canonical = [
    'v1',
    timestamp,
    nonce,
    method,
    url.pathname + url.search,
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-channel-key-id': keyId,
        'x-channel-timestamp': timestamp,
        'x-channel-nonce': nonce,
        'x-channel-signature': signature,
      },
      body: body || undefined,
    });
  } catch {
    throw new ErpError(503, 'No pudimos comunicarnos con el sistema de reservas. Intenta de nuevo.');
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & { message?: unknown; code?: string })
    | null;
  if (!response.ok) {
    const raw = payload?.message;
    const message = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '';
    // Los 401/404 del canal indican configuración, no un error del huésped: no se exponen detalles.
    if (response.status === 401 || response.status === 404 || response.status >= 500)
      throw new ErpError(503, 'El sistema de reservas no está disponible en este momento.');
    throw new ErpError(response.status, message || 'No pudimos procesar la solicitud.', payload?.code);
  }
  return { status: response.status, data: payload as T };
}

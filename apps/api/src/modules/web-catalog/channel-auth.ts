// Autenticación servidor a servidor del canal e-commerce: HMAC-SHA256 sobre método, ruta, cuerpo, marca de
// tiempo y nonce. Pura (sin Nest) para poder probarla de forma aislada.
//   x-channel-key-id     identifica la credencial (y por tanto el tenant: nunca viene del cliente)
//   x-channel-timestamp  segundos Unix; se acepta una ventana corta
//   x-channel-nonce      único por solicitud; se rechaza si se repite dentro de la ventana
//   x-channel-signature  hex(HMAC_SHA256(secret, canonical))
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CHANNEL_SIGNATURE_VERSION = 'v1';
export const MIN_SECRET_LENGTH = 32;

export type ChannelCredentials = { keyId: string; secret: string; tenantSlug: string };

export type SignedParts = {
  timestamp: string;
  nonce: string;
  method: string;
  pathAndQuery: string;
  body: Buffer | string;
};

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function canonicalString(parts: SignedParts): string {
  return [
    CHANNEL_SIGNATURE_VERSION,
    parts.timestamp,
    parts.nonce,
    parts.method.toUpperCase(),
    parts.pathAndQuery,
    sha256Hex(parts.body),
  ].join('\n');
}

export const signChannelRequest = (secret: string, parts: SignedParts) =>
  createHmac('sha256', secret).update(canonicalString(parts)).digest('hex');

/** Memoria de nonces vistos. En despliegues con varias instancias la ventana de tiempo acota la repetición. */
export class NonceStore {
  private readonly seen = new Map<string, number>();
  check(nonce: string, nowMs: number, ttlMs: number): boolean {
    for (const [key, expires] of this.seen) if (expires <= nowMs) this.seen.delete(key);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs + ttlMs);
    return true;
  }
}

export type ChannelHeaders = { keyId?: string; timestamp?: string; nonce?: string; signature?: string };
export type VerifyResult = { ok: true } | { ok: false; reason: string };

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function verifyChannelRequest(
  credentials: ChannelCredentials,
  headers: ChannelHeaders,
  request: Omit<SignedParts, 'timestamp' | 'nonce'>,
  context: { nowMs: number; nonces: NonceStore; toleranceSeconds?: number },
): VerifyResult {
  const tolerance = context.toleranceSeconds ?? 300;
  const { keyId, timestamp, nonce, signature } = headers;
  if (!keyId || !timestamp || !nonce || !signature) return { ok: false, reason: 'missing-headers' };
  const supplied = Buffer.from(keyId);
  const expectedKey = Buffer.from(credentials.keyId);
  if (supplied.length !== expectedKey.length || !timingSafeEqual(supplied, expectedKey)) return { ok: false, reason: 'unknown-key' };
  if (!NONCE_PATTERN.test(nonce)) return { ok: false, reason: 'bad-nonce' };
  if (!/^\d{10}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  if (Math.abs(context.nowMs / 1000 - Number(timestamp)) > tolerance) return { ok: false, reason: 'stale-timestamp' };
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'bad-signature' };
  const expected = signChannelRequest(credentials.secret, { ...request, timestamp, nonce });
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return { ok: false, reason: 'bad-signature' };
  // El nonce se registra solo con firma válida: un atacante no puede agotar la memoria con basura.
  if (!context.nonces.check(nonce, context.nowMs, tolerance * 2 * 1000)) return { ok: false, reason: 'replayed-nonce' };
  return { ok: true };
}

/** Ventana de tolerancia del timestamp (30 a 600 s; por defecto 120). */
export function channelToleranceSeconds(env: Record<string, string | undefined>): number {
  const value = Number(env.CHANNEL_TIMESTAMP_TOLERANCE_SECONDS);
  return Number.isFinite(value) && value >= 30 && value <= 600 ? value : 120;
}

/** Lee la configuración del entorno; null = canal deshabilitado (comportamiento por defecto). */
export function channelCredentialsFromEnv(env: Record<string, string | undefined>): ChannelCredentials | null {
  const keyId = env.CHANNEL_API_KEY_ID?.trim();
  const secret = env.CHANNEL_API_SECRET?.trim();
  const tenantSlug = env.CHANNEL_TENANT_SLUG?.trim();
  if (!keyId || !secret || !tenantSlug) return null;
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`CHANNEL_API_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`);
  return { keyId, secret, tenantSlug };
}

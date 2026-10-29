// Validación y almacenamiento de imágenes del catálogo web. Funciones puras + un servicio mínimo sobre la API REST de
// Supabase Storage. La escritura solo ocurre desde el backend del ERP con la clave de servicio (nunca desde el navegador);
// el bucket es de LECTURA pública y debe existir de antemano: este servicio NO crea buckets.
import { createHash } from 'node:crypto';

export const MAX_WEB_IMAGE_BYTES = 5 * 1024 * 1024;
export const WEB_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type WebImageType = (typeof WEB_IMAGE_TYPES)[number];

const EXTENSION: Record<WebImageType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Detecta el tipo real por la firma del archivo; el tipo declarado por el navegador no es de fiar. */
export function sniffImageType(buffer: Buffer): WebImageType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export type ImageValidation = { ok: true; type: WebImageType; extension: string; sha256: string } | { ok: false; reason: string };

export function validateImageUpload(file: { buffer?: Buffer; size?: number; mimetype?: string } | undefined): ImageValidation {
  if (!file?.buffer?.length) return { ok: false, reason: 'FILE_REQUIRED' };
  if (file.buffer.length > MAX_WEB_IMAGE_BYTES) return { ok: false, reason: 'FILE_TOO_LARGE' };
  const type = sniffImageType(file.buffer);
  if (!type) return { ok: false, reason: 'UNSUPPORTED_TYPE' };
  if (file.mimetype && file.mimetype !== type) return { ok: false, reason: 'TYPE_MISMATCH' };
  return { ok: true, type, extension: EXTENSION[type], sha256: createHash('sha256').update(file.buffer).digest('hex') };
}

/** Ruta estable y por contenido: mismo archivo => misma URL (cacheable para siempre); nunca se sobrescribe. */
export function webImageObjectPath(input: { tenantId: string; groupId: string; imageId: string; sha256: string; extension: string }) {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_');
  return `web/${safe(input.tenantId)}/${safe(input.groupId)}/${safe(input.imageId)}-${input.sha256.slice(0, 12)}.${input.extension}`;
}

export type StorageConfig = { url: string; key: string; bucket: string };

export function storageConfigFromEnv(env: Record<string, string | undefined>): StorageConfig | null {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key, bucket: env.SUPABASE_WEB_CATALOG_BUCKET?.trim() || 'web-catalog' };
}

export const publicObjectUrl = (config: StorageConfig, objectPath: string) =>
  `${config.url}/storage/v1/object/public/${encodeURIComponent(config.bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;

export async function putObject(config: StorageConfig, objectPath: string, body: Buffer, contentType: string): Promise<'created' | 'exists'> {
  const response = await fetch(`${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${config.key}`, apikey: config.key, 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000, immutable' },
    body: new Blob([new Uint8Array(body)], { type: contentType }),
    signal: AbortSignal.timeout(20_000),
  });
  // La ruta lleva el hash del contenido: un objeto ya existente es el mismo archivo.
  if (response.status === 409 || response.status === 400) {
    const text = await response.text().catch(() => '');
    if (/exists|Duplicate/i.test(text)) return 'exists';
    throw new Error(`Storage respondió ${response.status}`);
  }
  if (!response.ok) throw new Error(`Storage respondió ${response.status}`);
  return 'created';
}

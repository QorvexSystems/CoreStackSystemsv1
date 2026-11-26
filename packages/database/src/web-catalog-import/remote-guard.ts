// Vía remota, separada de guard.ts (que sigue bloqueando cualquier base que no sea local de prueba).
// Solo autoriza UN proyecto Supabase y UN tenant, y exige evidencia de respaldo. No se lee ningún .env aquí:
// el llamador pasa el entorno explícitamente.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const AUTHORIZED_PROJECT_REF = 'judogvnjrqabxrlgeopm';
export const AUTHORIZED_TENANT_SLUG = 'hotel-ancla';
export const REMOTE_CONFIRMATION = `AUTHORIZED:${AUTHORIZED_PROJECT_REF}:${AUTHORIZED_TENANT_SLUG}`;
export const REQUIRED_MIGRATIONS = [
  '20261028120000_web_catalog_grouping',
  '20261029120000_channel_nonce',
  '20261030120000_web_catalog_sku_approval',
] as const;

export type RemoteEnv = Record<string, string | undefined>;
export type RemoteTarget = { url: string; backupPath: string; backupSha256: string; backupBytes: number };

function projectRefOf(url: URL): string | null {
  const direct = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (direct) return direct[1];
  if (/\.pooler\.supabase\.com$/.test(url.hostname)) {
    const user = decodeURIComponent(url.username);
    const dot = user.lastIndexOf('.');
    return dot >= 0 ? user.slice(dot + 1) : null;
  }
  return null;
}

/** Valida URL (proyecto autorizado), tenant, confirmación textual y archivo de respaldo. Lanza con todos los motivos. */
export function assertAuthorizedRemoteTarget(env: RemoteEnv, tenantSlug: string, backupPath: string | undefined): RemoteTarget {
  const problems: string[] = [];
  if (env.WEB_CATALOG_IMPORT_REMOTE !== REMOTE_CONFIRMATION) problems.push(`falta WEB_CATALOG_IMPORT_REMOTE=${REMOTE_CONFIRMATION}`);
  if (tenantSlug !== AUTHORIZED_TENANT_SLUG) problems.push(`tenant no autorizado: ${tenantSlug}`);

  const raw = env.DIRECT_URL;
  let url: string | undefined;
  if (!raw) {
    problems.push('DIRECT_URL no está definida en el entorno');
  } else {
    try {
      const parsed = new URL(raw);
      if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) problems.push('DIRECT_URL: protocolo no PostgreSQL');
      if (projectRefOf(parsed) !== AUTHORIZED_PROJECT_REF) problems.push('DIRECT_URL: no corresponde al proyecto autorizado');
      if (parsed.port === '6543') problems.push('DIRECT_URL: el puerto 6543 es el pooler de transacciones');
      if (decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'postgres') problems.push('DIRECT_URL: la base debe ser postgres');
      url = raw;
    } catch {
      problems.push('DIRECT_URL no es una URL válida');
    }
  }

  let backupSha256 = '';
  let backupBytes = 0;
  if (!backupPath || !existsSync(backupPath)) {
    problems.push('falta --backup=<archivo de respaldo existente>');
  } else {
    backupBytes = statSync(backupPath).size;
    if (backupBytes < 1024) problems.push('el respaldo es demasiado pequeño para ser válido');
    else backupSha256 = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  }

  if (problems.length) throw new Error(`Ejecución remota rechazada:\n - ${problems.join('\n - ')}`);
  return { url: url as string, backupPath: backupPath as string, backupSha256, backupBytes };
}

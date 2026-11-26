import 'server-only';

// Límite en memoria por IP para el formulario público (el ERP aplica además su propio límite por canal).
const buckets = new Map<string, number[]>();

export function allowRequest(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (buckets.size > 5_000) buckets.clear();
  const recent = (buckets.get(key) ?? []).filter((time) => now - time < windowMs);
  const allowed = recent.length < limit;
  if (allowed) recent.push(now);
  buckets.set(key, recent);
  return allowed;
}

export function clientIp(headers: Headers) {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'local'
  );
}

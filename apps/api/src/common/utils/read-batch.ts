/** Bound lazy Prisma queries so a small demo pool cannot exhaust its wait queue. */
export async function readInBatches<T extends readonly unknown[]>(
  queries: readonly [...{ [K in keyof T]: PromiseLike<T[K]> }],
): Promise<T> {
  let limit = 4;
  try {
    const configured = Number(
      new URL(process.env.DATABASE_URL ?? '').searchParams.get('connection_limit'),
    );
    if (configured > 0) limit = Math.min(configured, limit);
  } catch {
    /* Use the conservative default when no connection URL is available. */
  }
  const results: unknown[] = [];
  for (let offset = 0; offset < queries.length; offset += limit) {
    results.push(...(await Promise.all(queries.slice(offset, offset + limit))));
  }
  return results as unknown as T;
}

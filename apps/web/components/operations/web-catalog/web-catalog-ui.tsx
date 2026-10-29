'use client';

import { ImageOff, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { describeBlocker } from '@/lib/web-catalog-labels';
import { formatCurrency } from '@/lib/utils';

export const selectClassName =
  'flex h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-gold-dark focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60';

export const textareaClassName =
  'flex min-h-28 w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-gold-dark focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60';

/** Miniatura con respaldo cuando la URL no carga o no existe (las imágenes son URLs externas). */
export function ProductThumb({
  src,
  alt,
  className = 'h-12 w-12',
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground ${className}`}
        role="img"
        aria-label={`Sin imagen: ${alt}`}
      >
        <ImageOff className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md border border-border object-cover ${className}`}
    />
  );
}

export function PriceRange({ min, max }: { min: string | null; max: string | null }) {
  if (min === null || max === null) return <span className="text-muted-foreground">Sin precio</span>;
  if (min === max) return <span>{formatCurrency(Number(min))}</span>;
  return (
    <span>
      {formatCurrency(Number(min))} – {formatCurrency(Number(max))}
    </span>
  );
}

export function BlockerList({
  blockers,
  variantName,
  title = 'No se puede publicar todavía',
}: {
  blockers: string[];
  variantName?: (id: string) => string;
  title?: string;
}) {
  if (!blockers.length) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-900"
    >
      <p className="flex items-center gap-2 font-semibold">
        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        {blockers.map((code) => (
          <li key={code}>{describeBlocker(code, variantName)}</li>
        ))}
      </ul>
    </div>
  );
}

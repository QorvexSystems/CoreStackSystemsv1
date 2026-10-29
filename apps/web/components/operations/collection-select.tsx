'use client';

import { X } from 'lucide-react';

import type { WebCollectionOption } from '@/lib/api';

type CollectionSelectProps = {
  id: string;
  value: string;
  options: WebCollectionOption[];
  onChange: (handle: string) => void;
  className?: string;
};

/** Selector «Todas las colecciones» (mismas colecciones y nombres que el e-commerce, con su conteo). */
export function CollectionSelect({ id, value, options, onChange, className = '' }: CollectionSelectProps) {
  const selected = options.find((option) => option.handle === value);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <label htmlFor={id} className="sr-only">
        Colección
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`h-11 min-w-0 flex-1 rounded-md border bg-white px-3 text-sm ${
          selected ? 'border-zinc-900 font-medium' : 'border-input'
        } ${className}`}
      >
        <option value="">Todas las colecciones</option>
        {options.map((option) => (
          <option key={option.handle} value={option.handle}>
            {option.title} ({option.count})
          </option>
        ))}
      </select>
      {selected ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-input bg-white text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          aria-label="Quitar filtro de colección"
          title="Todas las colecciones"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

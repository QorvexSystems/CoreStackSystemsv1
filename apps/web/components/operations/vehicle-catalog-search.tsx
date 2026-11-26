'use client';
import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { searchVehicleCatalog } from '@/lib/vehicle-catalog';

export function VehicleCatalogSearch({ onSelect }: { onSelect: (make: string, model: string) => void }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = searchVehicleCatalog(query);
  const choose = (make: string, model: string) => {
    onSelect(make, model);
    setQuery(`${make} ${model}`);
    setOpen(false);
  };
  return <div className="relative sm:col-span-2">
    <label htmlFor={id} className="mb-2 block text-sm font-medium">Buscar marca y modelo</label>
    <div className="relative"><Search aria-hidden className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
      <Input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-results`} aria-activedescendant={open && results[active] ? `${id}-${active}` : undefined}
        autoComplete="off" className="pl-9" placeholder="Ej.: Honda CRV, Toyota Corolla…" value={query}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(current => Math.max(0, Math.min(results.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)))); }
          if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); choose(results[active].make, results[active].model); }
        }} />
    </div>
    {open ? <div id={`${id}-results`} role="listbox" aria-label="Marcas y modelos" className="mt-2 max-h-48 overflow-y-auto overscroll-contain rounded-lg border bg-white shadow-sm">
      {results.map(({ make, model }, index) => <button id={`${id}-${index}`} key={`${make}-${model}`} type="button" role="option" aria-selected={index === active}
        className={`block min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-blue-50 ${index === active ? 'bg-slate-100' : ''}`}
        onMouseDown={e => e.preventDefault()} onClick={() => choose(make, model)}>{make} <strong>{model}</strong></button>)}
      {!results.length ? <p className="p-3 text-sm text-muted-foreground">Sin coincidencias. Puedes escribir la marca y el modelo en los campos de abajo.</p> : null}
    </div> : null}
  </div>;
}

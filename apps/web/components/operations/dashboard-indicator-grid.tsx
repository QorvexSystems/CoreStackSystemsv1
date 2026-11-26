'use client';
import { useState } from 'react';
import { DASHBOARD_INDICATORS } from './dashboard-indicators.js';
import type { WorkshopVehicleAreaFinding } from '@/lib/api';

function Pictogram({ symbol }: { symbol: string }) {
  const paths: Record<string, string> = {
    engine: 'M8 14h5v-4h10v4h6l4 5h6v14h-6l-4 5H13v-7H8z M3 18v12 M3 24h5 M39 20h5v12h-5',
    oil: 'M7 23l18-8 9 8-4 7H13z M17 19l-3-7h10 M31 20l10-5 M9 22H4v8h9 M40 29q-6 8 0 10q6-2 0-10',
    battery: 'M7 15h34v23H7z M13 11h6v4 M30 11h6v4 M12 24h9 M16.5 19.5v9 M29 24h8',
    temperature: 'M20 31V9a4 4 0 0 1 8 0v22a8 8 0 1 1-8 0 M24 17h8 M24 24h8 M4 40q4-4 8 0t8 0t8 0t8 0t8 0',
    tpms: 'M13 8Q1 25 10 39h28Q47 25 35 8 M13 35v4 M19 35v4 M25 35v4 M31 35v4 M24 17v10 M24 32v1',
    steering: 'M8 24a16 16 0 1 0 32 0a16 16 0 1 0-32 0 M8 22h32 M24 22v18 M10 23l14 9 14-9',
    airbag: 'M12 10a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M12 19l7 6-3 10h14 M12 19v13H8 M29 15a9 9 0 1 0 18 0a9 9 0 1 0-18 0',
    seatbelt: 'M21 9a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M15 39l2-18 7-4 8 4 2 18 M13 34l23-17 M14 34h20 M21 34v8 M29 34v8',
    brake_pad: 'M14 24a10 10 0 1 0 20 0a10 10 0 1 0-20 0 M10 11q-10 13 0 26 M38 11q10 13 0 26 M6 16h5 M4 24h5 M6 32h5 M37 16h5 M39 24h5 M37 32h5',
    traction: 'M13 15l4-6h14l4 6 4 5v10H9V20z M13 30v5 M35 30v5 M14 20h20 M14 38q-8 4 0 7 M34 38q-8 4 0 7',
    gear: 'M17 9l-1-5h16l-1 5 5 4 5-1 5 12-5 3-1 6 3 4-11 8-4-4h-8l-4 4-11-8 3-4-1-6-5-3 5-12 5 1z M16 24a8 8 0 1 0 16 0a8 8 0 1 0-16 0',
    fuel: 'M7 40V8h21v32 M7 24h21 M11 12h13v9H11z M28 18h5v16q7 8 8-2V18l-6-7 M37 13v9h5',
    water_fuel: 'M8 8h26v22H8z M21 15q-8 9 0 11q8-2 0-11 M5 37q4-4 8 0t8 0t8 0t8 0t8 0',
    glow: 'M3 30h4q12-30 17 0q5-30 17 0h4 M7 30q12 16 17 0q5 16 17 0',
    key: 'M7 19a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M24 20h20 M34 20v7 M40 20v7',
    door: 'M16 11h16v28H16z M16 21h16 M8 15l8 6 M8 15v18l8 6 M32 21l8-6v18l-8 6',
    hood: 'M8 24l6-7h20l6 7v14H8z M12 24h24 M13 16l17-9 M13 38v4 M35 38v4',
    trunk: 'M8 22l6-7h20l6 7v16H8z M30 15l10-7 M13 38v4 M35 38v4 M14 27h20',
    washer: 'M7 33l5-17q12-8 24 0l5 17q-17-7-34 0 M24 32l8-16 M19 9l-3-6 M29 9l3-6 M24 8V1',
    lamp: 'M17 29q-12-18 7-19q19 1 7 19v8H17z M18 42h12 M24 3V0 M9 9L5 5 M39 9l4-4 M6 23H1 M42 23h5',
    high_beam: 'M24 11q-15 13 0 26h15V11z M18 12H3 M16 20H1 M16 28H1 M18 36H3',
    low_beam: 'M24 11q-15 13 0 26h15V11z M18 12L3 20 M16 20L1 28 M16 28L1 36 M18 36L3 44',
    fog: 'M25 11q-14 13 0 26h14V11z M17 15H2 M17 24H2 M17 33H2 M10 7q-8 7 0 14t0 17',
    arrows: 'M3 24l10-10v6h8v8h-8v6z M45 24L35 14v6h-8v8h8v6z',
    triangle: 'M24 5L3 41h42z M24 17v12 M24 34v1',
    wrench: 'M32 5l-6 8 7 7 9-7q2 13-11 14L13 44 4 35l18-17Q18 4 32 5z',
    gauge: 'M5 35a21 21 0 1 1 38 0 M24 28l11-13 M20 28a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M10 22l5 2 M18 10l2 5 M34 10l-3 5',
    lane: 'M8 43l8-38 M40 43L32 5 M19 21h10l4 7v10H15V28z',
    collision: 'M13 27l4-7h14l4 7v10H13z M6 9l6 7 M24 1v11 M42 9l-6 7 M6 24H1 M42 24h5',
    plug: 'M16 5v13 M32 5v13 M10 18h28v9q0 11-14 11T10 27z M24 38v8',
    turtle: 'M12 29q0-19 18-19q12 0 12 19H12z M12 22H5v7h7 M18 29v7 M34 29v7 M42 22l5 4 M26 13v14 M17 18h21',
    snow: 'M24 3v42 M6 13l36 22 M6 35l36-22 M18 6l6 6 6-6 M18 42l6-6 6 6 M7 20l8-2-2-8 M41 28l-8 2 2 8 M7 28l8 2-2 8 M41 20l-8-2 2-8',
  };
  return <svg viewBox="0 0 48 48" aria-hidden="true" className="h-12 w-12 max-w-full shrink-0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    {paths[symbol] ? <path d={paths[symbol]} /> : <><path d="M9 8q-13 16 0 32 M39 8q13 16 0 32" /><circle cx="24" cy="24" r="15" /><text x="24" y="28" textAnchor="middle" stroke="none" fill="currentColor" fontSize={symbol.length > 4 ? 7 : symbol.length > 2 ? 10 : 19} fontWeight="bold">{symbol}</text></>}
  </svg>;
}

export function DashboardIndicatorGrid({ findings, selectedAreaId, onSelect, compact = false }: {
  findings: WorkshopVehicleAreaFinding[];
  selectedAreaId?: string | null;
  onSelect?: (id: string) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const indicators = DASHBOARD_INDICATORS.filter(item => compact ? findings.some(f => f.areaId === item.id) : `${item.label} ${item.symbol}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()));
  return <section className="min-w-0 rounded-xl border bg-white p-3">
    <h4 className="mb-3 text-xs font-semibold uppercase text-slate-500">Testigos del tablero</h4>
    {!compact ? <label className="mb-3 block text-sm">Buscar testigo<input className="mt-1 h-11 w-full rounded-lg border px-3" type="search" placeholder="Ej.: ABS, aceite, TPMS, batería…" value={query} onChange={e => setQuery(e.target.value)} /></label> : null}
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 8rem), 1fr))' }}>
      {indicators.map(item => {
        const finding = findings.find(f => f.areaId === item.id);
        const content = <><span className={item.color === 'red' ? 'text-red-600' : item.color === 'blue' ? 'text-blue-600' : item.color === 'green' ? 'text-emerald-600' : 'text-amber-500'}><Pictogram symbol={item.symbol} /></span><span className="w-full min-w-0 break-words text-center text-xs font-semibold leading-4">{item.label}</span>{finding ? <span className={`max-w-full whitespace-normal rounded-full px-2 py-0.5 text-center text-[10px] ${finding.condition === 'OK' ? 'bg-emerald-100 text-emerald-800' : finding.condition === 'REPAIR' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>{finding.condition === 'OK' ? 'Correcto' : finding.condition === 'REPAIR' ? 'Por reparar' : 'Con atención'}</span> : null}</>;
        const style = `flex min-h-28 min-w-0 break-inside-avoid flex-col items-center justify-center gap-2 rounded-lg border p-3 ${selectedAreaId === item.id ? 'border-blue-600 ring-2 ring-blue-300' : finding ? 'border-slate-400 bg-slate-50' : 'border-slate-200 bg-white'} hover:border-blue-400`;
        return onSelect ? <button key={item.id} type="button" aria-pressed={selectedAreaId === item.id} aria-label={item.label} className={style} onClick={() => onSelect(item.id)}>{content}</button> : <div key={item.id} className={style}>{content}</div>;
      })}
    </div>
    {!indicators.length ? <p className="p-4 text-sm text-muted-foreground">No hay testigos que coincidan con la búsqueda.</p> : null}
  </section>;
}

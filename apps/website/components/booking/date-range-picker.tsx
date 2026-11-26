'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import clsx from 'clsx';
import {
  addDays,
  addMonths,
  daysBetween,
  formatMonth,
  formatShort,
  monthStart,
  weekdayIndex,
} from '@/lib/dates';

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

type Props = {
  today: string;
  lastBookable: string;
  maxNights: number;
  checkIn: string;
  checkOut: string;
  onChange: (checkIn: string, checkOut: string) => void;
  /** Habitaciones libres esa noche; undefined = aún cargando. */
  nightAvailability: (date: string) => number | undefined;
  onMonthsVisible: (firstMonth: string) => void;
  /** Texto bajo el calendario que explica sobre qué se calcula la disponibilidad. */
  scopeLabel: string;
};

export function DateRangePicker(props: Props) {
  const { today, checkIn, checkOut, onChange, onMonthsVisible } = props;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'checkIn' | 'checkOut'>('checkIn');
  const [month, setMonth] = useState(monthStart(checkIn || today));
  const [hover, setHover] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) onMonthsVisible(month);
  }, [open, month, onMonthsVisible]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !panelRef.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const openAt = (target: 'checkIn' | 'checkOut') => {
    setPhase(target === 'checkOut' && checkIn ? 'checkOut' : 'checkIn');
    setMonth(monthStart(target === 'checkOut' && checkOut ? checkOut : checkIn || today));
    setOpen(true);
  };

  /** Última salida posible desde la llegada: hasta la primera noche agotada (esa mañana sí se puede salir). */
  const latestCheckOut = (() => {
    if (!checkIn) return null;
    const limit = addDays(checkIn, props.maxNights);
    for (let date = checkIn; date < limit; date = addDays(date, 1))
      if (props.nightAvailability(date) === 0) return date === checkIn ? null : date;
    return limit;
  })();

  const state = (date: string) => {
    const nightFree = props.nightAvailability(date);
    const pastOrTooFar = date < today || date > addDays(props.lastBookable, 1);
    if (phase === 'checkOut' && checkIn && date > checkIn) {
      const allowed = latestCheckOut !== null && date <= latestCheckOut;
      return { disabled: !allowed, soldOut: nightFree === 0, nightFree };
    }
    return {
      disabled: pastOrTooFar || date > props.lastBookable || nightFree === 0,
      soldOut: nightFree === 0 && !pastOrTooFar,
      nightFree,
    };
  };

  const pick = (date: string) => {
    if (phase === 'checkOut' && checkIn && date > checkIn) {
      onChange(checkIn, date);
      setOpen(false);
      return;
    }
    onChange(date, '');
    setPhase('checkOut');
  };

  const rangeEnd = checkOut || (phase === 'checkOut' && hover && checkIn && hover > checkIn ? hover : '');
  const nights = checkIn && checkOut ? daysBetween(checkIn, checkOut) : 0;
  const canGoBack = month > monthStart(today);
  const canGoForward = addMonths(month, 1) <= monthStart(props.lastBookable);

  return (
    <div className="relative" ref={panelRef}>
      <div className="grid grid-cols-2 gap-3">
        {(['checkIn', 'checkOut'] as const).map((target) => {
          const value = target === 'checkIn' ? checkIn : checkOut;
          const active = open && phase === target;
          return (
            <div key={target}>
              <span className="field-label">{target === 'checkIn' ? 'Check-in' : 'Check-out'}</span>
              <button
                type="button"
                onClick={() => openAt(target)}
                aria-haspopup="dialog"
                aria-expanded={open}
                className={clsx('field text-left', active && 'border-sea ring-2 ring-sea/15')}
              >
                <CalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span className={value ? '' : 'text-muted/80'}>{value ? formatShort(value) : 'dd/mm/aaaa'}</span>
              </button>
            </div>
          );
        })}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="Selecciona las fechas de tu estadía"
          className="absolute left-0 right-0 top-full z-30 mt-2 rounded-2xl border border-line bg-white p-4 shadow-xl sm:-right-48 lg:right-auto lg:w-[600px]"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              {phase === 'checkIn' ? 'Elige tu día de llegada' : 'Ahora elige tu día de salida'}
              {nights > 0 && <span className="ml-2 font-normal text-muted">· {nights} {nights === 1 ? 'noche' : 'noches'}</span>}
            </p>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-muted hover:bg-sand" aria-label="Cerrar calendario">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="relative grid gap-6 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, -1))}
              disabled={!canGoBack}
              className="absolute left-0 top-0 rounded-md p-1 text-ink hover:bg-sand disabled:opacity-30"
              aria-label="Mes anterior"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, 1))}
              disabled={!canGoForward}
              className="absolute right-0 top-0 rounded-md p-1 text-ink hover:bg-sand disabled:opacity-30"
              aria-label="Mes siguiente"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            {[month, addMonths(month, 1)].map((first, index) => (
              <div key={first} className={index === 1 ? 'hidden sm:block' : ''}>
                <p className="mb-2 text-center text-sm font-semibold first-letter:uppercase">{formatMonth(first)}</p>
                <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-muted">
                  {WEEKDAYS.map((day, i) => (
                    <span key={i} className="py-1">{day}</span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-y-1" onMouseLeave={() => setHover(null)}>
                  {Array.from({ length: weekdayIndex(first) }, (_, i) => <span key={`pad-${i}`} />)}
                  {Array.from({ length: daysBetween(first, addMonths(first, 1)) }, (_, i) => {
                    const date = addDays(first, i);
                    const { disabled, soldOut, nightFree } = state(date);
                    const isStart = date === checkIn;
                    const isEnd = date === rangeEnd;
                    const inRange = checkIn && rangeEnd && date > checkIn && date < rangeEnd;
                    const low = !disabled && nightFree !== undefined && nightFree > 0 && nightFree <= 2;
                    return (
                      <button
                        key={date}
                        type="button"
                        disabled={disabled}
                        onClick={() => pick(date)}
                        onMouseEnter={() => setHover(date)}
                        title={soldOut ? 'Sin disponibilidad esa noche' : low ? `Quedan ${nightFree}` : undefined}
                        className={clsx(
                          'relative mx-auto flex h-9 w-full items-center justify-center text-sm transition',
                          inRange && 'bg-sea-light',
                          (isStart || isEnd) && 'rounded-lg bg-sea font-semibold text-white',
                          !isStart && !isEnd && !disabled && 'rounded-lg hover:bg-sea-light',
                          disabled && 'cursor-not-allowed text-muted/40',
                          soldOut && 'line-through decoration-rose-400/70',
                          date === today && !isStart && 'font-bold text-sea-dark',
                        )}
                      >
                        {Number(date.slice(8))}
                        {low && !isStart && !isEnd && (
                          <span className="absolute bottom-1 h-1 w-1 rounded-full bg-amber-500" aria-hidden />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3 text-[11px] text-muted">
            <span className="flex items-center gap-1.5"><span className="line-through decoration-rose-400">12</span> Sin disponibilidad</span>
            <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Últimas habitaciones</span>
            <span className="ml-auto">{props.scopeLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

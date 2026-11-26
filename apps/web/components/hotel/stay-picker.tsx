'use client';

import { ChevronLeft, ChevronRight, LogIn, LogOut, Minus, Moon, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { addDays, formatDayLong } from './reservations-calendar';

const WEEK = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
/** Horas fijas del hotel: llegada 3:00 PM y salida 11:00 AM (no se cambian). */
const ARRIVAL_TIME = '15:00';
const DEPARTURE_TIME = '11:00';

const dayOf = (value: string) => value.slice(0, 10);
const nightsBetween = (first: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);

function monthStart(key: string) {
  return `${key.slice(0, 7)}-01`;
}
function shiftMonth(key: string, offset: number) {
  const date = new Date(`${monthStart(key)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}
function monthTitle(key: string) {
  const text = new Intl.DateTimeFormat('es-DO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${key}T12:00:00Z`),
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}
export function formatTime(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

/**
 * Estadía para pantalla táctil: se toca el día de llegada y luego el de salida en el calendario, la hora se
 * elige con botones y las noches y personas se ajustan con + / −.
 */
export function StayPicker({
  checkIn,
  checkOut,
  adults,
  childrenCount,
  today,
  allowPastDay,
  onStayChange,
  onGuestsChange,
}: {
  /** Valores "YYYY-MM-DDTHH:mm" (hora local). */
  checkIn: string;
  checkOut: string;
  adults: number;
  childrenCount: number;
  today: string;
  /** Al editar, la llegada original puede ser un día ya pasado. */
  allowPastDay?: string;
  onStayChange: (checkIn: string, checkOut: string) => void;
  onGuestsChange: (adults: number, children: number) => void;
}) {
  const arrival = dayOf(checkIn);
  const departure = dayOf(checkOut);
  const nights = Math.max(0, nightsBetween(arrival, departure));
  const [picking, setPicking] = useState<'checkIn' | 'checkOut'>('checkIn');
  const [month, setMonth] = useState(() => monthStart(arrival || today));

  const setDates = (nextArrival: string, nextDeparture: string) =>
    onStayChange(`${nextArrival}T${ARRIVAL_TIME}`, `${nextDeparture}T${DEPARTURE_TIME}`);

  const pickDay = (day: string) => {
    if (picking === 'checkIn' || day <= arrival) {
      setDates(day, addDays(day, Math.max(1, nights)));
      setPicking('checkOut');
      return;
    }
    setDates(arrival, day);
    setPicking('checkIn');
  };
  const setNights = (value: number) => setDates(arrival, addDays(arrival, Math.max(1, value)));

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_27rem]">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p
            className={cn(
              'rounded-full px-4 py-2 text-base font-bold',
              picking === 'checkIn' ? 'bg-teal-light text-teal-deep' : 'bg-amber-50 text-amber-800',
            )}
          >
            {picking === 'checkIn' ? '1. Toca el día de llegada' : '2. Ahora toca el día de salida'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Mes anterior"
              onClick={() => setMonth((current) => shiftMonth(current, -1))}
              disabled={monthStart(today) >= month}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 text-slate-700 active:bg-slate-100 disabled:opacity-30"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              aria-label="Mes siguiente"
              onClick={() => setMonth((current) => shiftMonth(current, 1))}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 text-slate-700 active:bg-slate-100"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          {[month, shiftMonth(month, 1)].map((start, index) => (
            <MonthGrid
              key={start}
              start={start}
              className={index === 1 ? 'hidden lg:block' : undefined}
              today={today}
              allowPastDay={allowPastDay}
              arrival={arrival}
              departure={departure}
              onPick={pickDay}
            />
          ))}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
          <Stepper
            icon={<Moon className="h-5 w-5" />}
            label="Noches"
            value={nights}
            min={1}
            onChange={setNights}
            quick={[1, 2, 3, 7]}
          />
          <Stepper label="Adultos" value={adults} min={1} max={8} onChange={(value) => onGuestsChange(value, childrenCount)} />
          <Stepper label="Niños" value={childrenCount} min={0} max={8} onChange={(value) => onGuestsChange(adults, value)} />
        </div>
      </div>

      <div className="space-y-4">
        <DateCard
          tone="arrival"
          active={picking === 'checkIn'}
          day={arrival}
          time={ARRIVAL_TIME}
          onSelect={() => setPicking('checkIn')}
        />
        <DateCard
          tone="departure"
          active={picking === 'checkOut'}
          day={departure}
          time={DEPARTURE_TIME}
          onSelect={() => setPicking('checkOut')}
        />
      </div>
    </div>
  );
}

function MonthGrid({
  start,
  today,
  allowPastDay,
  arrival,
  departure,
  onPick,
  className,
}: {
  start: string;
  today: string;
  allowPastDay?: string;
  arrival: string;
  departure: string;
  onPick: (day: string) => void;
  className?: string;
}) {
  const offset = new Date(`${start}T12:00:00Z`).getUTCDay();
  const days: string[] = [];
  for (let day = start; day.slice(0, 7) === start.slice(0, 7); day = addDays(day, 1)) days.push(day);
  return (
    <div className={className}>
      <p className="mb-2 text-center text-lg font-extrabold text-slate-900">{monthTitle(start)}</p>
      <div className="grid grid-cols-7 gap-y-1 text-center">
        {WEEK.map((label, index) => (
          <span key={index} className="pb-1 text-sm font-bold text-slate-400">
            {label}
          </span>
        ))}
        {Array.from({ length: offset }, (_, index) => (
          <span key={`blank-${index}`} />
        ))}
        {days.map((day) => {
          const past = day < today && day !== allowPastDay;
          const isArrival = day === arrival;
          const isDeparture = day === departure;
          const inside = day > arrival && day < departure;
          return (
            <button
              key={day}
              type="button"
              disabled={past}
              onClick={() => onPick(day)}
              aria-label={formatDayLong(day)}
              className={cn(
                'relative h-14 text-lg font-semibold tabular-nums transition disabled:cursor-not-allowed disabled:text-slate-300',
                inside && 'bg-teal-light text-teal-deep',
                isArrival && 'rounded-l-2xl bg-teal text-white',
                isDeparture && 'rounded-r-2xl bg-amber-500 text-white',
                !inside && !isArrival && !isDeparture && 'rounded-2xl text-slate-800 hover:bg-slate-100',
              )}
            >
              {Number(day.slice(8))}
              {day === today ? (
                <span
                  className={cn(
                    'absolute bottom-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full',
                    isArrival || isDeparture ? 'bg-white' : 'bg-teal',
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DateCard({
  tone,
  active,
  day,
  time,
  onSelect,
}: {
  tone: 'arrival' | 'departure';
  active: boolean;
  day: string;
  time: string;
  onSelect: () => void;
}) {
  const arrival = tone === 'arrival';
  return (
    <div
      className={cn(
        'rounded-2xl border-2 p-4 transition',
        arrival ? 'border-teal/30 bg-teal-light/40' : 'border-amber-200 bg-amber-50/60',
        active && (arrival ? 'border-teal ring-4 ring-teal/15' : 'border-amber-500 ring-4 ring-amber-200'),
      )}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-center gap-3 text-left">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white',
            arrival ? 'bg-teal' : 'bg-amber-500',
          )}
        >
          {arrival ? <LogIn className="h-5 w-5" /> : <LogOut className="h-5 w-5" />}
        </span>
        <span className={cn('text-sm font-extrabold uppercase tracking-wider', arrival ? 'text-teal-deep' : 'text-amber-800')}>
          {arrival ? 'Llegada' : 'Salida'}
        </span>
        <span className={cn('ml-auto whitespace-nowrap text-2xl font-extrabold tabular-nums', arrival ? 'text-teal-deep' : 'text-amber-700')}>
          {formatTime(time)}
        </span>
      </button>
      <p className="mt-2 text-xl font-bold text-slate-900 first-letter:uppercase">{day ? formatDayLong(day) : '—'}</p>
      <p className="mt-1 text-sm text-slate-500">
        {arrival ? 'Check-in a las 3:00 PM' : 'Check-out a las 11:00 AM'} · hora fija del hotel
      </p>
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max = 60,
  onChange,
  quick,
  icon,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (value: number) => void;
  quick?: number[];
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <p className="flex items-center gap-2 text-sm font-bold text-slate-600">
        {icon}
        {label}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label={`Menos ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
          className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 text-slate-700 active:bg-slate-100 disabled:opacity-30"
        >
          <Minus className="h-5 w-5" />
        </button>
        <span className="text-3xl font-extrabold tabular-nums text-slate-900">{value}</span>
        <button
          type="button"
          aria-label={`Más ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 text-slate-700 active:bg-slate-100 disabled:opacity-30"
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>
      {quick ? (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {quick.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              className={cn(
                'h-10 rounded-lg border text-sm font-bold',
                option === value ? 'border-teal bg-teal-light text-teal-deep' : 'border-slate-200 text-slate-600 active:bg-slate-100',
              )}
            >
              {option === 7 ? '1 sem.' : option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

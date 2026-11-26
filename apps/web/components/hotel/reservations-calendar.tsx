'use client';

import {
  ArrowLeft,
  BedDouble,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  DoorOpen,
  List,
  Phone,
  Plus,
  UserRound,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ActionDialog } from '@/components/ui/action-dialog';
import type {
  CreateHotelReservationPayload,
  HotelChannel,
  HotelGuest,
  HotelReservation,
  HotelRoom,
  HotelRoomType,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatMoney, reservationStatusLabels } from './hotel-flow';

const TZ = 'America/Santo_Domingo';
const DAY_MS = 86_400_000;
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ACTIVE = ['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED', 'CHECKED_IN'];
const UNSELLABLE = ['MAINTENANCE', 'OUT_OF_SERVICE'];

export const hotelKey = (value: string | Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(value),
  );
export const addDays = (key: string, days: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const monthStart = (key: string) => `${key.slice(0, 7)}-01`;
const shiftMonth = (key: string, offset: number) => {
  const date = new Date(`${monthStart(key)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
};
const weekday = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
const formatMonth = (key: string) =>
  new Intl.DateTimeFormat('es-DO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
export const formatDayLong = (key: string) =>
  new Intl.DateTimeFormat('es-DO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${key}T12:00:00Z`),
  );

/** Noches que ocupa una reservación (fechas del hotel). */
export function stayRange(reservation: HotelReservation) {
  const first = hotelKey(reservation.checkIn);
  let end = hotelKey(reservation.checkOut);
  if (end <= first) end = addDays(first, 1);
  return { first, end };
}

/** ¿La reservación ocupa la noche `key`? Un huésped alojado con salida vencida sigue ocupando hoy. */
export function occupiesNight(reservation: HotelReservation, key: string, today: string) {
  if (!ACTIVE.includes(reservation.status)) return false;
  const { first, end } = stayRange(reservation);
  if (key >= first && key < end) return true;
  return reservation.status === 'CHECKED_IN' && key === today && end <= today;
}

/** Hora del hotel en formato "3:00 PM" / "11:00 AM". */
export const formatHour = (value: string | Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(value));

/** Llegada y salida de una reservación, bien visibles. */
export function StayHighlight({ checkIn, checkOut }: { checkIn: string; checkOut: string }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <div className="rounded-xl border-2 border-teal/40 bg-teal-light/50 px-3 py-2">
        <p className="text-[10px] font-extrabold uppercase tracking-wider text-teal-deep">Llegada</p>
        <p className="text-xs font-bold first-letter:uppercase text-slate-900">{formatDayLong(hotelKey(checkIn))}</p>
        <p className="text-xl font-extrabold tabular-nums text-teal-deep">{formatHour(checkIn)}</p>
      </div>
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2">
        <p className="text-[10px] font-extrabold uppercase tracking-wider text-amber-800">Salida</p>
        <p className="text-xs font-bold first-letter:uppercase text-slate-900">{formatDayLong(hotelKey(checkOut))}</p>
        <p className="text-xl font-extrabold tabular-nums text-amber-700">{formatHour(checkOut)}</p>
      </div>
    </div>
  );
}

export function shortTypeName(name: string) {
  if (/sencill/i.test(name)) return 'Sencilla';
  if (/doble/i.test(name)) return 'Doble';
  if (/apart/i.test(name)) return 'Apto';
  return name;
}

/**
 * Disponibilidad por tipo y noche calculada con las reservaciones y habitaciones cargadas (misma regla del
 * inventario del API: habitaciones vendibles menos reservaciones activas que ocupan esa noche).
 */
export function makeAvailability(
  reservations: HotelReservation[],
  rooms: HotelRoom[],
  roomTypes: HotelRoomType[],
  today: string,
) {
  const typeOfReservation = (reservation: HotelReservation) =>
    rooms.find((room) => room.id === reservation.room?.id)?.roomType.id ?? reservation.roomType.id;
  const sellable = new Map<string, number>();
  for (const type of roomTypes) sellable.set(type.id, 0);
  for (const room of rooms)
    if (!UNSELLABLE.includes(room.status)) sellable.set(room.roomType.id, (sellable.get(room.roomType.id) ?? 0) + 1);
  const availableOn = (typeId: string, key: string) => {
    const taken = reservations.filter((item) => typeOfReservation(item) === typeId && occupiesNight(item, key, today)).length;
    return Math.max(0, (sellable.get(typeId) ?? 0) - taken);
  };
  return { availableOn, typeOfReservation };
}

type Props = {
  reservations: HotelReservation[];
  rooms: HotelRoom[];
  roomTypes: HotelRoomType[];
  guests: HotelGuest[];
  channels: HotelChannel[];
  onOpenReservation: (id: string) => void;
  onCreate: (payload: CreateHotelReservationPayload) => Promise<unknown>;
  /** Solo en celular: acceso a la lista y a una reservación nueva (el encabezado de la página se oculta). */
  onShowList?: () => void;
  onNew?: () => void;
};

type DayStep = { kind: 'types' } | { kind: 'rooms'; typeId: string } | { kind: 'form'; typeId: string; roomId: string };

/** Calendario mensual de reservaciones con disponibilidad por tipo y creación rápida por habitación. */
export function ReservationsCalendar(props: Props) {
  const { reservations, rooms, roomTypes } = props;
  const today = hotelKey(new Date());
  const [month, setMonth] = useState(monthStart(today));
  const [day, setDay] = useState<string | null>(null);
  const [step, setStep] = useState<DayStep>({ kind: 'types' });

  const { availableOn, typeOfReservation } = useMemo(
    () => makeAvailability(reservations, rooms, roomTypes, today),
    [reservations, rooms, roomTypes, today],
  );

  const orderedTypes = [...roomTypes].sort((a, b) => Number(a.baseRate) - Number(b.baseRate));
  const firstCell = addDays(month, -weekday(month));
  const nextMonth = shiftMonth(month, 1);
  const weeks = Math.ceil((weekday(month) + Math.round((Date.parse(`${nextMonth}T00:00:00Z`) - Date.parse(`${month}T00:00:00Z`)) / DAY_MS)) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, index) => addDays(firstCell, index));

  const openDay = (key: string) => {
    setDay(key);
    setStep({ kind: 'types' });
  };
  const closeDay = () => setDay(null);

  const movements = (key: string) => {
    const arrivals = reservations
      .filter((item) => ACTIVE.concat('CHECKED_OUT').includes(item.status) && hotelKey(item.checkIn) === key)
      .map((item) => ({ item, kind: 'in' as const, time: item.checkIn }));
    const departures = reservations
      .filter((item) => ['CHECKED_IN', 'CONFIRMED', 'ASSIGNED', 'CHECKED_OUT'].includes(item.status) && hotelKey(item.checkOut) === key)
      .map((item) => ({ item, kind: 'out' as const, time: item.checkOut }));
    return [...arrivals, ...departures].sort((a, b) => +new Date(a.time) - +new Date(b.time));
  };

  return (
    <section className="overflow-hidden bg-white md:rounded-xl md:border md:border-slate-200 md:shadow-sm">
      <div className="flex flex-wrap items-center gap-2 px-1 pb-2 pt-1 md:border-b md:border-slate-200 md:px-3 md:py-2.5">
        <h2 className="order-first w-full text-3xl font-extrabold first-letter:uppercase md:order-none md:w-auto md:text-xl md:font-bold">
          <span className="md:hidden">{formatMonth(month).split(' ')[0]}</span>
          <span className="hidden md:inline">{formatMonth(month)}</span>
        </h2>
        <button
          type="button"
          onClick={() => setMonth(monthStart(today))}
          className="flex h-10 items-center gap-2 rounded-full border border-slate-200 px-4 text-sm font-semibold hover:bg-slate-50 md:order-first md:rounded-lg"
        >
          <CalendarDays className="hidden h-4 w-4 md:block" /> Hoy
        </button>
        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-full p-2 hover:bg-slate-100" aria-label="Mes anterior">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-full p-2 hover:bg-slate-100" aria-label="Mes siguiente">
          <ChevronRight className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-slate-500 md:hidden">{month.slice(0, 4)}</span>
        <div className="ml-auto flex items-center gap-1 md:hidden">
          {props.onShowList ? (
            <button type="button" onClick={props.onShowList} className="rounded-full border border-slate-200 p-2.5" aria-label="Ver lista">
              <List className="h-5 w-5" />
            </button>
          ) : null}
          {props.onNew ? (
            <button type="button" onClick={props.onNew} className="rounded-full bg-teal p-2.5 text-white" aria-label="Nueva reservación">
              <Plus className="h-5 w-5" />
            </button>
          ) : null}
        </div>
        <div className="ml-auto hidden items-center gap-3 text-[11px] text-slate-500 md:flex">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Disponibles</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> Agotado</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-teal" /> Llegada</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" /> Salida</span>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-slate-200 text-center text-[11px] font-semibold text-slate-500 md:bg-slate-50 md:text-left md:text-xs md:font-medium md:text-slate-600">
        {WEEKDAYS.map((name) => (
          <div key={name} className="py-1.5 md:px-2">
            <span className="hidden lg:inline">{name}</span>
            <span className="hidden md:inline lg:hidden">{name.slice(0, 3)}</span>
            <span className="md:hidden">{name[0]}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((key) => {
          const inMonth = key.slice(0, 7) === month.slice(0, 7);
          const past = key < today;
          const weekend = [0, 6].includes(weekday(key));
          const moves = movements(key);
          const arrivalsCount = moves.filter((move) => move.kind === 'in').length;
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => openDay(key)}
              onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && openDay(key)}
              className={cn(
                'group min-h-[4.6rem] cursor-pointer border-t border-slate-100 p-1 text-center transition md:min-h-[7.25rem] md:border-b md:border-r md:border-t-0 md:border-slate-200 md:p-1.5 md:text-left md:hover:bg-teal-light/30',
                !inMonth && 'max-md:pointer-events-none max-md:invisible md:bg-slate-50/70 md:text-slate-400',
                key === today && 'md:ring-2 md:ring-inset md:ring-teal',
              )}
            >
              <div className="flex justify-center md:justify-start">
                <span
                  className={cn(
                    'flex h-9 min-w-9 items-center justify-center rounded-full px-1.5 text-lg font-semibold md:h-7 md:min-w-7 md:text-sm',
                    key === today ? 'bg-teal text-white' : past || weekend ? 'text-slate-400' : 'text-slate-900',
                  )}
                >
                  <span className="md:hidden">{Number(key.slice(8))}</span>
                  <span className="hidden md:inline">
                    {key.endsWith('-01') ? `1 ${formatMonth(key).split(' ')[0].slice(0, 3)}` : Number(key.slice(8))}
                  </span>
                </span>
              </div>

              {/* Celular: un punto por tipo (verde libre / rojo agotado) y llegadas del día. */}
              {!past ? (
                <div className="mt-1 flex items-center justify-center gap-1 md:hidden">
                  {orderedTypes.map((type) => (
                    <span
                      key={type.id}
                      className={cn('h-1.5 w-1.5 rounded-full', availableOn(type.id, key) > 0 ? 'bg-emerald-500' : 'bg-rose-500')}
                    />
                  ))}
                </div>
              ) : null}
              {arrivalsCount ? (
                <span className="mt-1 inline-block rounded-full bg-teal-light px-1.5 text-[10px] font-bold text-teal-deep md:hidden">
                  {arrivalsCount} {arrivalsCount === 1 ? 'llega' : 'llegan'}
                </span>
              ) : null}

              {/* Tablet / PC: disponibilidad por tipo y llegadas/salidas con hora. */}
              {!past ? (
                <div className="mt-1 hidden flex-wrap gap-1 md:flex">
                  {orderedTypes.map((type) => {
                    const free = availableOn(type.id, key);
                    return (
                      <span
                        key={type.id}
                        title={`${type.name}: ${free} disponibles`}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-bold',
                          free > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600',
                        )}
                      >
                        {shortTypeName(type.name)} {free}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <div className="mt-1 hidden space-y-0.5 md:block">
                {moves.slice(0, 3).map(({ item, kind, time }) => (
                  <span
                    key={`${kind}-${item.id}`}
                    className={cn(
                      'flex w-full items-center gap-1 truncate rounded border-l-4 px-1.5 py-0.5 text-left text-[11px] font-semibold',
                      kind === 'out' ? 'border-amber-400 bg-amber-50 text-amber-900' : chipTone(item.status),
                    )}
                    title={`${kind === 'in' ? 'Llegada' : 'Salida'} ${formatHour(time)} · ${item.code} · ${item.guest.firstName} ${item.guest.lastName}`}
                  >
                    <span className="shrink-0 font-extrabold">{formatHour(time).replace(':00', '')}</span>
                    <span className="truncate">
                      {item.room ? `${item.room.number} · ` : ''}
                      {item.guest.firstName} {item.guest.lastName}
                    </span>
                  </span>
                ))}
                {moves.length > 3 ? (
                  <span className="block px-1 text-[10px] font-semibold text-slate-500">+{moves.length - 3} más</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {day ? (
        <DayDialog
          {...props}
          day={day}
          today={today}
          step={step}
          setStep={setStep}
          orderedTypes={orderedTypes}
          availableOn={availableOn}
          typeOfReservation={typeOfReservation}
          onClose={closeDay}
        />
      ) : null}
    </section>
  );
}

/** Qué significa que la habitación esté ocupada esa noche. */
function occupancyKind(reservation: HotelReservation) {
  if (reservation.status === 'CHECKED_IN')
    return { label: 'Alojado', tile: 'border-rose-300 bg-rose-50 hover:border-rose-500', text: 'text-rose-700', badge: 'bg-rose-600' };
  if (reservation.status === 'PENDING_REVIEW')
    return { label: 'Solicitud pendiente', tile: 'border-amber-300 bg-amber-50 hover:border-amber-500', text: 'text-amber-800', badge: 'bg-amber-500' };
  return { label: 'Reservada', tile: 'border-orange-300 bg-orange-50 hover:border-orange-500', text: 'text-orange-800', badge: 'bg-orange-500' };
}

const shortDay = (value: string) =>
  new Intl.DateTimeFormat('es-DO', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date(value));

function chipTone(status: string) {
  if (status === 'PENDING_REVIEW') return 'border-amber-400 bg-amber-50 text-amber-900';
  if (status === 'CHECKED_IN') return 'border-sky-500 bg-sky-50 text-sky-900';
  if (status === 'CHECKED_OUT') return 'border-slate-300 bg-slate-100 text-slate-500';
  return 'border-teal bg-teal-light/70 text-teal-deep';
}

function DayDialog(
  props: Props & {
    day: string;
    today: string;
    step: DayStep;
    setStep: (step: DayStep) => void;
    orderedTypes: HotelRoomType[];
    availableOn: (typeId: string, key: string) => number;
    typeOfReservation: (reservation: HotelReservation) => string;
    onClose: () => void;
  },
) {
  const { day, today, step, setStep, orderedTypes, availableOn, typeOfReservation, reservations, rooms } = props;
  const router = useRouter();
  const past = day < today;
  const type = step.kind !== 'types' ? orderedTypes.find((item) => item.id === step.typeId) ?? null : null;
  const room = step.kind === 'form' ? rooms.find((item) => item.id === step.roomId) ?? null : null;
  const occupying = reservations.filter((item) => occupiesNight(item, day, today));

  const title =
    step.kind === 'types'
      ? formatDayLong(day)
      : step.kind === 'rooms'
        ? `${type?.name ?? 'Habitaciones'} · ${formatDayLong(day)}`
        : `Reservar habitación ${room?.number ?? ''}`;

  return (
    <ActionDialog
      open
      eyebrow={step.kind === 'form' ? 'Nueva reservación' : 'Disponibilidad'}
      title={title}
      description={
        step.kind === 'types'
          ? past
            ? 'Día pasado: solo consulta.'
            : 'Elige el tipo de habitación para ver cuáles están libres esa noche.'
          : step.kind === 'rooms'
            ? 'Verde: libre (toca para reservar) · Rojo: alojado · Naranja: reservada · Amarillo: solicitud pendiente.'
            : 'Completa los datos del huésped y confirma.'
      }
      icon={<CalendarDays className="h-5 w-5" />}
      confirmLabel=""
      hideFooter
      size="lg"
      dismissible={step.kind !== 'form'}
      onClose={props.onClose}
      onConfirm={() => undefined}
    >
      {step.kind !== 'types' ? (
        <button
          type="button"
          onClick={() => setStep(step.kind === 'form' ? { kind: 'rooms', typeId: step.typeId } : { kind: 'types' })}
          className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-teal-deep"
        >
          <ArrowLeft className="h-4 w-4" /> {step.kind === 'form' ? 'Volver a las habitaciones' : 'Volver a los tipos'}
        </button>
      ) : null}

      {step.kind === 'types' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {orderedTypes.map((item) => {
            const free = availableOn(item.id, day);
            const total = rooms.filter((r) => r.roomType.id === item.id).length;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setStep({ kind: 'rooms', typeId: item.id })}
                className={cn(
                  'rounded-2xl border-2 p-4 text-left transition active:scale-[0.99]',
                  free > 0 ? 'border-emerald-200 bg-emerald-50/60 hover:border-emerald-400' : 'border-rose-200 bg-rose-50/60 hover:border-rose-400',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <BedDouble className="h-5 w-5" /> {item.name}
                </span>
                <span className={cn('mt-3 block text-5xl font-extrabold tabular-nums', free > 0 ? 'text-emerald-600' : 'text-rose-600')}>
                  {free}
                </span>
                <span className="text-xs text-slate-600">
                  {free === 1 ? 'disponible' : 'disponibles'} de {total}
                </span>
                <span className="mt-2 block text-xs font-semibold text-slate-700">{formatMoney(item.baseRate)} / noche</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {step.kind === 'rooms' && type ? (
        <RoomsGrid
          day={day}
          today={today}
          type={type}
          rooms={rooms.filter((r) => r.roomType.id === type.id)}
          occupying={occupying}
          typeOfReservation={typeOfReservation}
          typeFull={availableOn(type.id, day) === 0}
          past={past}
          onOpenReservation={(id) => {
            props.onClose();
            props.onOpenReservation(id);
          }}
          onPickRoom={(roomId) => {
            props.onClose();
            router.push(`/reservations/new?day=${day}&room=${roomId}`);
          }}
        />
      ) : null}

    </ActionDialog>
  );
}

function RoomsGrid({
  day,
  today,
  type,
  rooms,
  occupying,
  typeOfReservation,
  typeFull,
  past,
  onOpenReservation,
  onPickRoom,
}: {
  day: string;
  today: string;
  type: HotelRoomType;
  rooms: HotelRoom[];
  occupying: HotelReservation[];
  typeOfReservation: (reservation: HotelReservation) => string;
  typeFull: boolean;
  past: boolean;
  onOpenReservation: (id: string) => void;
  onPickRoom: (roomId: string) => void;
}) {
  const unassigned = occupying.filter((item) => !item.room && typeOfReservation(item) === type.id);
  return (
    <div className="space-y-3">
      {typeFull && !past ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          No queda cupo de {type.name} esa noche
          {unassigned.length ? ': hay reservas confirmadas sin habitación asignada que ocupan el cupo.' : '.'}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {[...rooms]
          .sort((a, b) => a.number.localeCompare(b.number, 'es', { numeric: true }))
          .map((room) => {
            const stay = occupying.find((item) => item.room?.id === room.id);
            const outOfService = ['MAINTENANCE', 'OUT_OF_SERVICE'].includes(room.status);
            if (stay) {
              const kind = occupancyKind(stay);
              const balance = Number(stay.totalAmount) - Number(stay.paidAmount);
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => onOpenReservation(stay.id)}
                  className={cn('rounded-2xl border-2 p-3 text-left', kind.tile)}
                >
                  <span className={cn('flex items-center justify-between gap-2 text-sm font-extrabold', kind.text)}>
                    Hab. {room.number}
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold text-white', kind.badge)}>
                      {kind.label}
                    </span>
                  </span>
                  <span className="mt-2 flex items-center gap-1.5 truncate text-sm font-bold text-slate-900">
                    <UserRound className="h-3.5 w-3.5 shrink-0" /> {stay.guest.firstName} {stay.guest.lastName}
                  </span>
                  {stay.guest.phone ? (
                    <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-700">
                      <Phone className="h-3.5 w-3.5 shrink-0" /> {stay.guest.phone}
                    </span>
                  ) : null}
                  <span className="mt-1.5 grid grid-cols-2 gap-1 text-[11px]">
                    <span className="rounded-md bg-white/70 px-1.5 py-0.5">
                      <span className="block font-bold text-teal-deep">Llega</span>
                      {shortDay(stay.checkIn)} · {formatHour(stay.checkIn)}
                    </span>
                    <span className="rounded-md bg-white/70 px-1.5 py-0.5">
                      <span className="block font-bold text-amber-700">Sale</span>
                      {shortDay(stay.checkOut)} · {formatHour(stay.checkOut)}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center justify-between text-[10px] text-slate-600">
                    <span>{stay.code}</span>
                    <span className={balance > 0.009 ? 'font-bold text-rose-600' : 'font-bold text-emerald-700'}>
                      {balance > 0.009 ? `Debe ${formatMoney(balance)}` : 'Pagada'}
                    </span>
                  </span>
                </button>
              );
            }
            if (outOfService)
              return (
                <div key={room.id} className="rounded-2xl border-2 border-slate-200 bg-slate-100 p-3 text-slate-500">
                  <span className="text-sm font-extrabold">Hab. {room.number}</span>
                  <span className="mt-2 block text-xs">Fuera de servicio</span>
                </div>
              );
            const disabled = past || typeFull;
            return (
              <button
                key={room.id}
                type="button"
                disabled={disabled}
                onClick={() => onPickRoom(room.id)}
                className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-3 text-left hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex items-center justify-between text-sm font-extrabold text-emerald-700">
                  Hab. {room.number}
                  <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">Libre</span>
                </span>
                <span className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
                  <DoorOpen className="h-4 w-4" /> {past ? 'Día pasado' : 'Toca para reservar'}
                </span>
                {room.floor ? <span className="mt-0.5 block text-[10px] text-slate-500">Piso {room.floor}</span> : null}
              </button>
            );
          })}
      </div>
      {unassigned.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-xs font-bold text-amber-900">Reservas de {type.name} sin habitación asignada esa noche</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {unassigned.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenReservation(item.id)}
                className="rounded-lg border border-amber-200 bg-white p-2 text-left text-xs hover:border-amber-400"
              >
                <span className="block font-bold text-slate-900">
                  {item.guest.firstName} {item.guest.lastName}
                </span>
                <span className="block text-slate-600">{item.guest.phone || 'Sin contacto'}</span>
                <span className="block text-[10px] text-slate-500">
                  {item.code} · {reservationStatusLabels[item.status] ?? item.status} · toca para asignar
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {day === today ? null : null}
    </div>
  );
}

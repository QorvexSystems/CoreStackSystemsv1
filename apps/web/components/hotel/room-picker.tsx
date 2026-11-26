'use client';

import { BedDouble, CheckCircle2, Clock3, DoorOpen, Sparkles, UserRound, Users } from 'lucide-react';
import { useMemo } from 'react';
import type { HotelReservation, HotelRoom, HotelRoomType } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatMoney } from './hotel-flow';
import { addDays, formatHour, makeAvailability, occupiesNight } from './reservations-calendar';

const UNSELLABLE = ['MAINTENANCE', 'OUT_OF_SERVICE'];
const shortDay = (value: string) =>
  new Intl.DateTimeFormat('es-DO', { timeZone: 'America/Santo_Domingo', day: 'numeric', month: 'short' }).format(new Date(value));

/**
 * Elegir tipo y habitación con tarjetas (como en el calendario de Reservaciones): cada tipo muestra cuántas
 * quedan libres en TODAS las noches de la estadía, y cada habitación aparece en verde si está libre o con
 * el huésped que la ocupa si no.
 */
export function RoomPicker({
  firstNight,
  endDay,
  today,
  roomTypes,
  rooms,
  reservations,
  editingId,
  roomTypeId,
  roomId,
  adults,
  onTypeChange,
  onRoomChange,
}: {
  firstNight: string;
  endDay: string;
  today: string;
  roomTypes: HotelRoomType[];
  rooms: HotelRoom[];
  reservations: HotelReservation[];
  editingId?: string;
  roomTypeId: string;
  roomId: string;
  adults: number;
  onTypeChange: (typeId: string) => void;
  onRoomChange: (roomId: string) => void;
}) {
  const others = useMemo(() => reservations.filter((item) => item.id !== editingId), [editingId, reservations]);
  const nightsList = useMemo(() => {
    const list: string[] = [];
    for (let day = firstNight; day < endDay && list.length < 366; day = addDays(day, 1)) list.push(day);
    return list.length ? list : [firstNight];
  }, [endDay, firstNight]);
  const { availableOn } = useMemo(() => makeAvailability(others, rooms, roomTypes, today), [others, rooms, roomTypes, today]);
  const orderedTypes = [...roomTypes].sort((a, b) => Number(a.baseRate) - Number(b.baseRate));
  const freeForStay = (typeId: string) => Math.min(...nightsList.map((night) => availableOn(typeId, night)));
  const conflictOf = (room: HotelRoom) =>
    others.find((item) => item.room?.id === room.id && nightsList.some((night) => occupiesNight(item, night, today)));
  const selectedType = orderedTypes.find((type) => type.id === roomTypeId);
  const typeRooms = rooms
    .filter((room) => room.roomType.id === roomTypeId)
    .sort((a, b) => a.number.localeCompare(b.number, 'es', { numeric: true }));
  const nights = nightsList.length;

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-lg font-extrabold text-slate-900">Tipo de habitación</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {orderedTypes.map((type) => {
            const free = freeForStay(type.id);
            const total = rooms.filter((room) => room.roomType.id === type.id).length;
            const selected = type.id === roomTypeId;
            const tooSmall = adults > type.capacityAdults;
            return (
              <button
                key={type.id}
                type="button"
                onClick={() => onTypeChange(type.id)}
                className={cn(
                  'relative rounded-2xl border-2 p-5 text-left transition active:scale-[0.99]',
                  selected
                    ? 'border-teal bg-teal-light/50 ring-4 ring-teal/15'
                    : free > 0
                      ? 'border-emerald-200 bg-emerald-50/50 hover:border-emerald-400'
                      : 'border-rose-200 bg-rose-50/50 hover:border-rose-400',
                )}
              >
                {selected ? <CheckCircle2 className="absolute right-4 top-4 h-7 w-7 text-teal" /> : null}
                <span className="flex items-center gap-2 text-lg font-extrabold text-slate-900">
                  <BedDouble className="h-6 w-6" /> {type.name}
                </span>
                <span className="mt-3 flex items-end gap-2">
                  <span className={cn('text-5xl font-extrabold tabular-nums leading-none', free > 0 ? 'text-emerald-600' : 'text-rose-600')}>
                    {free}
                  </span>
                  <span className="pb-1 text-sm text-slate-600">
                    {free === 1 ? 'libre' : 'libres'} de {total} para estas fechas
                  </span>
                </span>
                <span className="mt-3 block text-base font-bold text-slate-800">{formatMoney(type.baseRate)} / noche</span>
                <span className="block text-sm text-slate-600">
                  {nights} {nights === 1 ? 'noche' : 'noches'}: {formatMoney(Number(type.baseRate) * nights)}
                </span>
                <span className={cn('mt-2 flex items-center gap-1.5 text-sm', tooSmall ? 'font-bold text-rose-600' : 'text-slate-500')}>
                  <Users className="h-4 w-4" /> Hasta {type.capacityAdults} adultos
                  {tooSmall ? ' · no caben' : ''}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {selectedType ? (
        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h3 className="text-lg font-extrabold text-slate-900">Habitaciones · {selectedType.name}</h3>
            <p className="text-sm text-slate-500">Verde: libre en todas las noches · toca para elegirla</p>
          </div>
          {freeForStay(selectedType.id) === 0 ? (
            <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
              No queda cupo de {selectedType.name} en alguna de esas noches. Cambia las fechas o el tipo de habitación.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            <button
              type="button"
              onClick={() => onRoomChange('')}
              className={cn(
                'flex flex-col justify-center rounded-2xl border-2 border-dashed p-4 text-left',
                !roomId ? 'border-teal bg-teal-light/50 ring-4 ring-teal/15' : 'border-slate-300 bg-white hover:border-teal/50',
              )}
            >
              <span className="flex items-center gap-2 text-base font-extrabold text-slate-800">
                <Clock3 className="h-5 w-5" /> Asignar después
              </span>
              <span className="mt-1 text-sm text-slate-500">Se elige la habitación al hacer check-in.</span>
            </button>
            {typeRooms.map((room) => {
              const conflict = conflictOf(room);
              const outOfService = UNSELLABLE.includes(room.status);
              const selected = room.id === roomId;
              if (conflict) {
                const hosted = conflict.status === 'CHECKED_IN';
                return (
                  <div
                    key={room.id}
                    className={cn(
                      'rounded-2xl border-2 p-4',
                      hosted ? 'border-rose-200 bg-rose-50' : 'border-orange-200 bg-orange-50',
                    )}
                  >
                    <span className={cn('flex items-center justify-between text-xl font-extrabold', hosted ? 'text-rose-700' : 'text-orange-800')}>
                      {room.number}
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold text-white', hosted ? 'bg-rose-600' : 'bg-orange-500')}>
                        {hosted ? 'Alojado' : conflict.status === 'PENDING_REVIEW' ? 'Solicitud' : 'Reservada'}
                      </span>
                    </span>
                    <span className="mt-2 flex items-center gap-1.5 truncate text-sm font-bold text-slate-800">
                      <UserRound className="h-4 w-4 shrink-0" /> {conflict.guest.firstName} {conflict.guest.lastName}
                    </span>
                    <span className="mt-1 block text-xs text-slate-600">
                      {shortDay(conflict.checkIn)} {formatHour(conflict.checkIn)} → {shortDay(conflict.checkOut)} {formatHour(conflict.checkOut)}
                    </span>
                  </div>
                );
              }
              if (outOfService)
                return (
                  <div key={room.id} className="rounded-2xl border-2 border-slate-200 bg-slate-100 p-4 text-slate-500">
                    <span className="text-xl font-extrabold">{room.number}</span>
                    <span className="mt-2 block text-sm">Fuera de servicio</span>
                  </div>
                );
              const dirty = firstNight === today && room.housekeepingStatus !== 'CLEAN';
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => onRoomChange(room.id)}
                  className={cn(
                    'relative rounded-2xl border-2 p-4 text-left transition active:scale-[0.99]',
                    selected ? 'border-teal bg-teal-light/60 ring-4 ring-teal/15' : 'border-emerald-200 bg-emerald-50 hover:border-emerald-400',
                  )}
                >
                  <span className="flex items-center justify-between text-xl font-extrabold text-emerald-700">
                    {room.number}
                    {selected ? (
                      <CheckCircle2 className="h-6 w-6 text-teal" />
                    ) : (
                      <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white">Libre</span>
                    )}
                  </span>
                  <span className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
                    <DoorOpen className="h-4 w-4" /> {selected ? 'Elegida' : 'Toca para elegir'}
                  </span>
                  {dirty ? (
                    <span className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700">
                      <Sparkles className="h-3.5 w-3.5" /> Pendiente de limpieza
                    </span>
                  ) : room.floor ? (
                    <span className="mt-1 block text-xs text-slate-500">Piso {room.floor}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

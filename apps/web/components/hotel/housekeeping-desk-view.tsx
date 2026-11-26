'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, CheckCircle2, Clock3, LogIn, LogOut, RefreshCw, Sparkles, SprayCan } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  confirmHotelRoomCleaning,
  getHousekeepingRooms,
  updateHotelRoomState,
  type HotelRoom,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { cn } from '@/lib/utils';
import { formatDayLong, formatHour, hotelKey } from './reservations-calendar';

/**
 * Limpieza desde recepción (pantalla táctil de 15.6"): el personal de limpieza pasa por recepción, ve qué
 * habitaciones le tocan, se marca "en limpieza" y al terminar recepción confirma que quedó limpia.
 */
export function HousekeepingDeskView() {
  const session = getSession();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<HotelRoom | null>(null);
  const roomsQuery = useQuery({
    queryKey: ['hotel', 'housekeeping', session?.tenantId],
    queryFn: () => getHousekeepingRooms(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    refetchInterval: 30_000,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hotel'] });
  const start = useMutation({
    mutationFn: (room: HotelRoom) =>
      updateHotelRoomState(session!.tenantId, session!.accessToken, room.id, {
        status: 'CLEANING',
        housekeepingStatus: 'IN_PROGRESS',
      }),
    onSuccess: async (room) => {
      await invalidate();
      toast.success(`Habitación ${room.number}: en limpieza`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const confirm = useMutation({
    mutationFn: (room: HotelRoom) => confirmHotelRoomCleaning(session!.tenantId, session!.accessToken, room.id),
    onSuccess: async (room) => {
      setConfirming(null);
      await invalidate();
      toast.success(`Habitación ${room.number} lista y disponible`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const today = hotelKey(new Date());
  // Primero las que tienen llegada más pronto (hoy), luego por número.
  const rooms = [...(roomsQuery.data ?? [])].sort((a, b) => {
    const arrivalA = a.nextArrival ? +new Date(a.nextArrival.checkIn) : Infinity;
    const arrivalB = b.nextArrival ? +new Date(b.nextArrival.checkIn) : Infinity;
    return arrivalA - arrivalB || a.number.localeCompare(b.number, 'es', { numeric: true });
  });
  const inProgress = rooms.filter((room) => room.housekeepingStatus === 'IN_PROGRESS').length;
  const urgent = rooms.filter((room) => room.nextArrival && hotelKey(room.nextArrival.checkIn) <= today).length;

  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-light text-teal-deep">
          <Sparkles className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-teal">Recepción</p>
          <h1 className="text-2xl font-extrabold">Limpieza de habitaciones</h1>
          <p className="text-sm text-slate-500">
            Indica al personal qué habitaciones limpiar y confirma aquí cuando terminen.
          </p>
        </div>
        <div className="flex gap-2">
          <Counter label="Por limpiar" value={rooms.length - inProgress} tone="amber" />
          <Counter label="En limpieza" value={inProgress} tone="sky" />
          <Counter label="Llegan hoy" value={urgent} tone="rose" />
        </div>
        <button
          type="button"
          onClick={() => roomsQuery.refetch()}
          aria-label="Actualizar"
          className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 text-slate-600 active:bg-slate-100"
        >
          <RefreshCw className={cn('h-6 w-6', roomsQuery.isFetching && 'animate-spin')} />
        </button>
      </header>

      {roomsQuery.isLoading ? <Panel text="Cargando habitaciones…" /> : null}
      {roomsQuery.error ? <Panel text={(roomsQuery.error as Error).message} /> : null}
      {!roomsQuery.isLoading && !roomsQuery.error && !rooms.length ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-12 text-center">
          <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" />
          <h2 className="mt-3 text-2xl font-extrabold text-emerald-900">Todo está limpio</h2>
          <p className="mt-1 text-emerald-700">No hay habitaciones pendientes de limpieza.</p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {rooms.map((room) => {
          const cleaning = room.housekeepingStatus === 'IN_PROGRESS';
          const arrivesToday = room.nextArrival && hotelKey(room.nextArrival.checkIn) <= today;
          return (
            <article
              key={room.id}
              className={cn(
                'flex flex-col rounded-2xl border-2 bg-white p-4 shadow-sm',
                cleaning ? 'border-sky-300' : arrivesToday ? 'border-rose-300' : 'border-amber-200',
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl',
                    cleaning ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700',
                  )}
                >
                  {cleaning ? <SprayCan className="h-7 w-7" /> : <BedDouble className="h-7 w-7" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-3xl font-extrabold leading-none">{room.number}</p>
                  <p className="mt-1 truncate text-sm text-slate-500">
                    {room.roomType.name}
                    {room.floor ? ` · Piso ${room.floor}` : ''}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-extrabold',
                    cleaning ? 'bg-sky-100 text-sky-800' : 'bg-amber-100 text-amber-800',
                  )}
                >
                  {cleaning ? 'En limpieza' : 'Por limpiar'}
                </span>
              </div>

              <div className="mt-3 space-y-1.5 text-sm">
                {room.lastCheckout ? (
                  <p className="flex items-center gap-2 text-slate-600">
                    <LogOut className="h-4 w-4 shrink-0 text-amber-600" />
                    Salió {formatHour(room.lastCheckout.checkedOutAt ?? room.lastCheckout.checkOut)}
                  </p>
                ) : null}
                {room.nextArrival ? (
                  <p className={cn('flex items-center gap-2 font-semibold', arrivesToday ? 'text-rose-700' : 'text-slate-700')}>
                    <LogIn className="h-4 w-4 shrink-0" />
                    {arrivesToday ? 'Llega hoy' : `Llega ${formatDayLong(hotelKey(room.nextArrival.checkIn))}`} ·{' '}
                    {formatHour(room.nextArrival.checkIn)} · {room.nextArrival.guest}
                  </p>
                ) : (
                  <p className="flex items-center gap-2 text-slate-400">
                    <Clock3 className="h-4 w-4 shrink-0" /> Sin llegada próxima
                  </p>
                )}
                {room.lastCheckout?.specialRequests ? (
                  <p className="rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">Nota: {room.lastCheckout.specialRequests}</p>
                ) : null}
              </div>

              <div className="mt-auto grid gap-2 pt-4">
                {!cleaning ? (
                  <button
                    type="button"
                    disabled={start.isPending}
                    onClick={() => start.mutate(room)}
                    className="flex h-14 items-center justify-center gap-2 rounded-xl border-2 border-sky-300 bg-sky-50 text-base font-extrabold text-sky-800 active:bg-sky-100 disabled:opacity-50"
                  >
                    <SprayCan className="h-5 w-5" /> Empezar limpieza
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setConfirming(room)}
                  className="flex h-14 items-center justify-center gap-2 rounded-xl bg-teal text-base font-extrabold text-white active:bg-teal-dark"
                >
                  <CheckCircle2 className="h-5 w-5" /> Confirmar limpia
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <ActionDialog
        open={Boolean(confirming)}
        tone="success"
        eyebrow="Confirmar limpieza"
        title={confirming ? `¿La habitación ${confirming.number} quedó limpia?` : ''}
        description="Quedará disponible para asignar y hacer check-in."
        icon={<CheckCircle2 className="h-5 w-5" />}
        confirmLabel="Sí, quedó limpia"
        cancelLabel="Todavía no"
        isPending={confirm.isPending}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && confirm.mutate(confirming)}
      />
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: 'amber' | 'sky' | 'rose' }) {
  const tones = {
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    sky: 'bg-sky-50 text-sky-800 border-sky-200',
    rose: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  return (
    <div className={cn('min-w-[6.5rem] rounded-2xl border px-4 py-2 text-center', tones[tone])}>
      <p className="text-3xl font-extrabold leading-none">{value}</p>
      <p className="mt-1 text-xs font-bold">{label}</p>
    </div>
  );
}

function Panel({ text }: { text: string }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{text}</div>;
}

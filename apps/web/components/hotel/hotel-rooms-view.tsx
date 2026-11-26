'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, CheckCircle2, RefreshCw, Search, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { getHotelRooms, updateHotelRoomState } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { roomStatusLabels, roomStatusTones } from './hotel-flow';

export function HotelRoomsView() {
  const session = getSession();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const roomsQuery = useQuery({
    queryKey: ['hotel', 'rooms', session?.tenantId],
    queryFn: () => getHotelRooms(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const stateMutation = useMutation({
    mutationFn: ({
      roomId,
      payload,
    }: {
      roomId: string;
      payload: Parameters<typeof updateHotelRoomState>[3];
    }) => updateHotelRoomState(session!.tenantId, session!.accessToken, roomId, payload),
    onSuccess: async (room) => {
      await queryClient.invalidateQueries({ queryKey: ['hotel'] });
      toast.success(`Habitación ${room.number} actualizada`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const rooms = roomsQuery.data ?? [];
  const filtered = useMemo(
    () =>
      rooms.filter(
        (room) =>
          `${room.number} ${room.roomType.name}`.toLowerCase().includes(query.toLowerCase()) &&
          (status === 'ALL' ||
            room.status === status ||
            (status === 'OUT_OF_SERVICE' && room.status === 'MAINTENANCE')),
      ),
    [query, rooms, status],
  );

  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold text-teal">Inventario hotelero</p>
          <h1 className="mt-1 text-2xl font-extrabold">Habitaciones</h1>
          <p className="mt-1 text-sm text-slate-500">
            Disponibilidad y limpieza actualizadas por la operación de recepción.
          </p>
        </div>
        <button
          type="button"
          onClick={() => roomsQuery.refetch()}
          className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold"
        >
          <RefreshCw className={`h-4 w-4 ${roomsQuery.isFetching ? 'animate-spin' : ''}`} />{' '}
          Actualizar
        </button>
      </header>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Disponibles"
          value={rooms.filter((room) => room.status === 'AVAILABLE').length}
        />
        <Kpi label="Reservadas" value={rooms.filter((room) => room.status === 'RESERVED').length} />
        <Kpi label="Ocupadas" value={rooms.filter((room) => room.status === 'OCCUPIED').length} />
        <Kpi
          label="Pendientes / fuera de servicio"
          value={
            rooms.filter((room) =>
              ['CLEANING', 'MAINTENANCE', 'OUT_OF_SERVICE'].includes(room.status),
            ).length
          }
        />
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">Mapa operativo</h2>
            <p className="text-xs text-slate-500">
              Después del check-out la habitación queda en limpieza.
            </p>
          </div>
          <div className="flex gap-2">
            <label className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 rounded-lg border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-teal"
                placeholder="Buscar habitación..."
              />
            </label>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs"
            >
              <option value="ALL">Todos</option>
              {['AVAILABLE', 'RESERVED', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE'].map((value) => (
                <option key={value} value={value}>
                  {roomStatusLabels[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {roomsQuery.isLoading ? (
          <p className="p-8 text-center text-sm text-slate-500">Cargando habitaciones...</p>
        ) : null}
        {roomsQuery.error ? (
          <p className="p-8 text-center text-sm text-rose-600">
            {(roomsQuery.error as Error).message}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((room) => (
            <article
              key={room.id}
              className="rounded-xl border border-slate-200 p-4 transition hover:border-teal/40"
            >
              <div className="flex items-start justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-light text-teal-deep">
                  <BedDouble className="h-5 w-5" />
                </span>
                <span
                  className={`rounded-full px-2 py-1 text-[10px] font-semibold ${roomStatusTones[room.status]}`}
                >
                  {roomStatusLabels[room.status]}
                </span>
              </div>
              <p className="mt-3 text-xl font-extrabold">Hab. {room.number}</p>
              <p className="text-xs font-semibold text-slate-700">{room.roomType.name}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                Limpieza: {housekeepingLabel(room.housekeepingStatus)}
              </p>
              <div className="mt-4">
                {['CLEANING'].includes(room.status) || room.housekeepingStatus !== 'CLEAN' ? (
                  <button
                    disabled={stateMutation.isPending}
                    onClick={() =>
                      stateMutation.mutate({
                        roomId: room.id,
                        payload: { status: 'AVAILABLE', housekeepingStatus: 'CLEAN' },
                      })
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" /> Marcar limpia y disponible
                  </button>
                ) : null}
                {room.status === 'AVAILABLE' ? (
                  <button
                    disabled={stateMutation.isPending}
                    onClick={() =>
                      stateMutation.mutate({
                        roomId: room.id,
                        payload: { status: 'OUT_OF_SERVICE', housekeepingStatus: 'INSPECTING' },
                      })
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 py-2 text-xs font-semibold disabled:opacity-50"
                  >
                    <Wrench className="h-4 w-4" /> Marcar fuera de servicio
                  </button>
                ) : null}
                {['MAINTENANCE', 'OUT_OF_SERVICE'].includes(room.status) ? (
                  <button
                    disabled={stateMutation.isPending}
                    onClick={() =>
                      stateMutation.mutate({
                        roomId: room.id,
                        payload: { status: 'AVAILABLE', housekeepingStatus: 'CLEAN' },
                      })
                    }
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" /> Restablecer habitación
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
    </article>
  );
}

function housekeepingLabel(value: string) {
  return (
    { CLEAN: 'Limpia', DIRTY: 'Sucia', INSPECTING: 'Inspección', IN_PROGRESS: 'En proceso' }[
      value
    ] ?? value
  );
}

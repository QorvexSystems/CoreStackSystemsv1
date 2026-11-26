'use client';

import { useQuery } from '@tanstack/react-query';
import { BedDouble, CheckCircle2, ChevronRight, RefreshCw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { getHousekeepingRooms } from '@/lib/api';
import { getSession } from '@/lib/auth-session';

export function HousekeepingMobileView() {
  const session = getSession();
  const roomsQuery = useQuery({
    queryKey: ['hotel', 'housekeeping', session?.tenantId],
    queryFn: () => getHousekeepingRooms(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    refetchInterval: 30_000,
  });
  const rooms = roomsQuery.data ?? [];

  return (
    <div className="mx-auto min-h-[calc(100vh-8rem)] w-full max-w-lg pb-24 sm:pb-8">
      <header className="sticky top-0 z-10 -mx-1 rounded-b-2xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur sm:static sm:mx-0 sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-light text-teal-deep">
              <Sparkles className="h-6 w-6" />
            </span>
            <div>
              <p className="text-xs font-semibold text-teal">Hotel Ancla</p>
              <h1 className="text-xl font-extrabold">Limpieza</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => roomsQuery.refetch()}
            aria-label="Actualizar lista"
            className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 text-slate-600 active:bg-slate-100"
          >
            <RefreshCw className={`h-5 w-5 ${roomsQuery.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="mt-4 rounded-xl bg-slate-950 p-4 text-white">
          <p className="text-sm text-slate-300">Habitaciones pendientes</p>
          <p className="mt-1 text-3xl font-extrabold">{rooms.length}</p>
        </div>
      </header>

      <main className="mt-4 space-y-3">
        {roomsQuery.isLoading ? <Message text="Cargando habitaciones..." /> : null}
        {roomsQuery.error ? <Message text={(roomsQuery.error as Error).message} error /> : null}
        {!roomsQuery.isLoading && !roomsQuery.error && !rooms.length ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
            <h2 className="mt-3 text-lg font-bold text-emerald-900">Todo está limpio</h2>
            <p className="mt-1 text-sm text-emerald-700">No tienes habitaciones pendientes.</p>
          </div>
        ) : null}
        {rooms.map((room) => (
          <Link
            key={room.id}
            href={`/housekeeping/${room.id}`}
            className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition active:scale-[0.99] active:bg-slate-50"
          >
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
                <BedDouble className="h-7 w-7" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-2xl font-extrabold">Habitación {room.number}</p>
                <p className="text-sm text-slate-500">
                  {room.roomType.name}
                  {room.floor ? ` · Piso ${room.floor}` : ''}
                </p>
              </div>
              <ChevronRight className="h-6 w-6 shrink-0 text-slate-400" />
            </div>
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              Pendiente de limpieza
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-teal-deep">
              Ver detalles de la habitación
            </p>
          </Link>
        ))}
      </main>
    </div>
  );
}

function Message({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={`rounded-2xl border p-8 text-center text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-white text-slate-500'}`}
    >
      {text}
    </div>
  );
}

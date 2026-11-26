'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  BedDouble,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Layers3,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import { confirmHotelRoomCleaning, getHousekeepingRoom, type HotelRoom } from '@/lib/api';
import { getSession } from '@/lib/auth-session';

export function HousekeepingRoomDetail({ roomId }: { roomId: string }) {
  const session = getSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const roomQuery = useQuery({
    queryKey: ['hotel', 'housekeeping', roomId, session?.tenantId],
    queryFn: () => getHousekeepingRoom(session!.tenantId, session!.accessToken, roomId),
    enabled: Boolean(session),
  });
  const confirmMutation = useMutation({
    mutationFn: () => confirmHotelRoomCleaning(session!.tenantId, session!.accessToken, roomId),
    onSuccess: async (room) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hotel', 'housekeeping'] }),
        queryClient.invalidateQueries({ queryKey: ['hotel', 'rooms'] }),
      ]);
      toast.success(`Habitación ${room.number} lista y disponible`);
      router.replace('/housekeeping');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const room = roomQuery.data;

  return (
    <div className="mx-auto min-h-[calc(100vh-8rem)] w-full max-w-lg pb-28 sm:pb-8">
      <header className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Link
          href="/housekeeping"
          aria-label="Volver a habitaciones pendientes"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-700 active:bg-slate-100"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <p className="text-xs font-semibold text-teal">Hotel Ancla · Limpieza</p>
          <h1 className="text-xl font-extrabold">Detalle de habitación</h1>
        </div>
      </header>

      {roomQuery.isLoading ? <Message text="Cargando detalles..." /> : null}
      {roomQuery.error ? <Message text={(roomQuery.error as Error).message} error /> : null}
      {room ? <RoomDetails room={room} onConfirm={() => setConfirmOpen(true)} /> : null}

      <ActionDialog
        open={confirmOpen}
        title={`¿Habitación ${room?.number} está completamente limpia?`}
        description="Al confirmar, la habitación quedará disponible para una nueva reservación."
        tone="success"
        confirmLabel="Sí, confirmar limpieza"
        cancelLabel="Todavía no"
        isPending={confirmMutation.isPending}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => confirmMutation.mutate()}
      />
    </div>
  );
}

function RoomDetails({ room, onConfirm }: { room: HotelRoom; onConfirm: () => void }) {
  const amenities = Array.isArray(room.roomType.amenities) ? room.roomType.amenities : [];
  const checkoutDate = room.lastCheckout?.checkedOutAt ?? room.lastCheckout?.checkOut;

  return (
    <main className="mt-4 space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
            <BedDouble className="h-8 w-8" />
          </span>
          <div>
            <p className="text-sm text-slate-500">Habitación</p>
            <h2 className="text-3xl font-extrabold">{room.number}</h2>
            <p className="text-sm font-medium text-slate-600">{room.roomType.name}</p>
          </div>
        </div>
        <div className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          Pendiente de limpieza
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <DetailCard
          icon={Layers3}
          label="Ubicación"
          value={room.floor ? `Piso ${room.floor}` : 'Piso no indicado'}
        />
        <DetailCard
          icon={Users}
          label="Capacidad"
          value={`${room.roomType.capacityAdults} adultos`}
        />
        <DetailCard
          icon={CalendarCheck}
          label="Último check-out"
          value={checkoutDate ? formatDate(checkoutDate) : 'Sin registro'}
          wide
        />
      </section>

      {amenities.length ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-teal" />
            <h3 className="font-bold">Amenidades de la habitación</h3>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {amenities.map((amenity) => (
              <span
                key={amenity}
                className="rounded-full bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700"
              >
                {amenity}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {room.notes || room.lastCheckout?.specialRequests ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-teal" />
            <h3 className="font-bold">Notas importantes</h3>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {room.notes ?? room.lastCheckout?.specialRequests}
          </p>
        </section>
      ) : null}

      <button
        type="button"
        onClick={onConfirm}
        className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-teal px-5 text-lg font-extrabold text-white shadow-lg active:scale-[0.99] active:bg-teal-dark"
      >
        <CheckCircle2 className="h-6 w-6" /> Confirmar limpieza
      </button>
      <p className="px-4 text-center text-xs leading-5 text-slate-500">
        Confirma solamente cuando la habitación esté lista para recibir al próximo huésped.
      </p>
    </main>
  );
}

function DetailCard({
  icon: Icon,
  label,
  value,
  wide = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${wide ? 'col-span-2' : ''}`}
    >
      <Icon className="h-5 w-5 text-teal" />
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 font-bold text-slate-900">{value}</p>
    </div>
  );
}

function Message({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={`mt-4 rounded-2xl border p-8 text-center text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-white text-slate-500'}`}
    >
      {text}
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

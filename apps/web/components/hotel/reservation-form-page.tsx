'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { FormPage } from '@/components/ui/form-page';
import {
  createHotelReservation,
  getHotelChannels,
  getHotelGuests,
  getHotelReservations,
  getHotelRooms,
  getHotelRoomTypes,
  updateHotelReservation,
  type CreateHotelReservationPayload,
  type HotelReservation,
  type UpdateHotelReservationPayload,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { QuickReservationForm } from './quick-reservation-form';
import { ReservationDialog } from './reservation-dialog';
import { formatDayLong, hotelKey, makeAvailability } from './reservations-calendar';

function useHotelData() {
  const session = getSession();
  const auth = session ? ([session.tenantId, session.accessToken] as const) : null;
  const key = session?.tenantId;
  const enabled = Boolean(auth);
  return {
    session,
    reservations: useQuery({ queryKey: ['hotel', 'reservations', key], queryFn: () => getHotelReservations(auth![0], auth![1]), enabled }),
    rooms: useQuery({ queryKey: ['hotel', 'rooms', key], queryFn: () => getHotelRooms(auth![0], auth![1]), enabled }),
    roomTypes: useQuery({ queryKey: ['hotel', 'room-types', key], queryFn: () => getHotelRoomTypes(auth![0], auth![1]), enabled }),
    channels: useQuery({ queryKey: ['hotel', 'channels', key], queryFn: () => getHotelChannels(auth![0], auth![1]), enabled }),
    guests: useQuery({ queryKey: ['hotel', 'guests', key], queryFn: () => getHotelGuests(auth![0], auth![1]), enabled }),
  };
}

/** Al terminar, vuelve a Reservaciones con "Siguiente acción" abierto para esa reservación. */
function useFinish() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = getSession();
  return async (reservation: HotelReservation) => {
    queryClient.setQueryData<HotelReservation[]>(['hotel', 'reservations', session?.tenantId], (current) =>
      current ? [...current.filter((item) => item.id !== reservation.id), reservation] : [reservation],
    );
    await queryClient.invalidateQueries({ queryKey: ['hotel'] });
    router.push(`/reservations?open=${reservation.id}`);
  };
}

/** Pantalla completa para crear una reservación (asistente completo o reserva rápida desde el calendario). */
export function NewReservationPage() {
  const router = useRouter();
  const params = useSearchParams();
  const day = params.get('day');
  const roomId = params.get('room');
  const data = useHotelData();
  const finish = useFinish();
  const create = useMutation({
    mutationFn: (payload: CreateHotelReservationPayload) =>
      createHotelReservation(data.session!.tenantId, data.session!.accessToken, payload),
    onSuccess: async (reservation) => {
      toast.success(`Reservación ${reservation.code} creada`);
      await finish(reservation);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const today = hotelKey(new Date());
  const loaded = data.reservations.data && data.rooms.data && data.roomTypes.data && data.channels.data && data.guests.data;
  const availability = useMemo(
    () =>
      data.reservations.data && data.rooms.data && data.roomTypes.data
        ? makeAvailability(data.reservations.data, data.rooms.data, data.roomTypes.data, today)
        : null,
    [data.reservations.data, data.rooms.data, data.roomTypes.data, today],
  );
  const back = () => router.push('/reservations');

  if (!data.session) return <Message text="Inicia sesión nuevamente." />;
  if (!loaded || !availability) return <Message text="Cargando…" />;

  // Reserva rápida: fecha y habitación elegidas en el calendario.
  if (day && roomId) {
    const room = data.rooms.data!.find((item) => item.id === roomId);
    const roomTypes = [...data.roomTypes.data!].sort((a, b) => Number(a.baseRate) - Number(b.baseRate));
    const roomType = roomTypes.find((type) => type.id === room?.roomType.id);
    if (!room || !roomType) return <Message text="No encontramos esa habitación." />;
    return (
      <FormPage
        eyebrow="Nueva reservación"
        title={`Reservar habitación ${room.number}`}
        description={`${roomType.name} · llegada ${formatDayLong(day)}`}
        icon={<CalendarPlus className="h-5 w-5" />}
        onBack={back}
        backLabel="Calendario"
        footer={null}
      >
        <QuickReservationForm
          day={day}
          today={today}
          room={room}
          roomType={roomType}
          roomTypes={roomTypes}
          reservations={data.reservations.data!}
          guests={data.guests.data!}
          channels={data.channels.data!}
          availableOn={availability.availableOn}
          onCreate={async (payload) => {
            await create.mutateAsync(payload);
          }}
        />
      </FormPage>
    );
  }

  return (
    <ReservationDialog
      variant="page"
      open
      roomTypes={data.roomTypes.data!}
      rooms={data.rooms.data!}
      reservations={data.reservations.data!}
      channels={data.channels.data!}
      guests={data.guests.data!}
      isPending={create.isPending}
      onClose={back}
      onSubmit={(payload) => create.mutate(payload)}
    />
  );
}

/** Pantalla completa para editar una reservación antes del check-in. */
export function EditReservationPage({ reservationId }: { reservationId: string }) {
  const router = useRouter();
  const data = useHotelData();
  const finish = useFinish();
  const update = useMutation({
    mutationFn: (payload: UpdateHotelReservationPayload) =>
      updateHotelReservation(data.session!.tenantId, data.session!.accessToken, reservationId, payload),
    onSuccess: async (reservation) => {
      toast.success(`Reservación ${reservation.code} actualizada`);
      await finish(reservation);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const loaded = data.reservations.data && data.rooms.data && data.roomTypes.data && data.channels.data && data.guests.data;
  const reservation = data.reservations.data?.find((item) => item.id === reservationId);
  const back = () => router.push(`/reservations?open=${reservationId}`);

  if (!data.session) return <Message text="Inicia sesión nuevamente." />;
  if (!loaded) return <Message text="Cargando…" />;
  if (!reservation) return <Message text="No encontramos esta reservación." />;
  if (!['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(reservation.status))
    return <Message text="Esta reservación ya no se puede editar (solo antes del check-in)." />;

  return (
    <ReservationDialog
      variant="page"
      open
      editing={reservation}
      roomTypes={data.roomTypes.data!}
      rooms={data.rooms.data!}
      reservations={data.reservations.data!}
      channels={data.channels.data!}
      guests={data.guests.data!}
      isPending={update.isPending}
      onClose={back}
      onSubmit={() => undefined}
      onUpdate={(_, payload) => update.mutate(payload)}
    />
  );
}

function Message({ text }: { text: string }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{text}</div>;
}

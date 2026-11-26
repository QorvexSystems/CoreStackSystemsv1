'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BedDouble,
  CalendarDays,
  CircleDollarSign,
  DoorOpen,
  Pencil,
  List,
  LogOut,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  assignHotelRoom,
  applyHotelGuestCredit,
  createHotelReservation,
  updateHotelReservation,
  type UpdateHotelReservationPayload,
  getHotelChannels,
  getHotelGuests,
  getHotelReservations,
  getHotelRooms,
  getHotelRoomTypes,
  recordHotelPayment,
  updateHotelReservationStatus,
  type CreateHotelReservationPayload,
  type HotelReservation,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { isReceptionSession } from '@/lib/authorization';
import { cn } from '@/lib/utils';
import { ChannelBadge, ChannelLabel } from './channel-logo';
import {
  canCollectReservationPayment,
  canDeleteReservation,
  formatMoney,
  formatStayDateTime,
  nightsBetween,
  reservationBalance,
  reservationStatusLabels,
  reservationStatusTones,
} from './hotel-flow';
import { PaymentReceiptDialog } from './payment-receipt-dialog';
import { ReservationsCalendar, StayHighlight } from './reservations-calendar';
import { whatsappUrl } from './whatsapp';
import { CheckInChoiceDialog } from './check-in-choice-dialog';
import { CheckoutConfirmDialog, earlyCheckoutPreview } from './checkout-confirm-dialog';
import { DeleteReservationDialog } from './delete-reservation-dialog';
import { GuestWhatsAppButton } from './guest-whatsapp-button';

export function ReservationsView() {
  const params = useSearchParams();
  const router = useRouter();
  const session = getSession();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState('ACTIVE');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkInAsk, setCheckInAsk] = useState<HotelReservation | null>(null);
  const [deleting, setDeleting] = useState<HotelReservation | null>(null);
  const [roomChoice, setRoomChoice] = useState('');
  const [reservationOpen, setReservationOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Reservaciones se trabaja solo en el calendario (la lista quedó retirada).
  const view = 'calendar' as 'calendar' | 'list';
  const [checkoutReservation, setCheckoutReservation] = useState<HotelReservation | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [receiptReservation, setReceiptReservation] = useState<HotelReservation | null>(null);

  useEffect(() => {
    if (params.get('new') === '1') router.replace('/reservations/new');
    // Desde la campanita: abrir una solicitud o su edición.
    const open = params.get('open');
    const edit = params.get('edit');
    if (open) {
      setSelectedId(open);
      setActionOpen(true);
    }
    if (edit) router.replace(`/reservations/${edit}/edit`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const auth = session ? ([session.tenantId, session.accessToken] as const) : null;
  const reservationsQuery = useQuery({
    queryKey: ['hotel', 'reservations', session?.tenantId],
    queryFn: () => getHotelReservations(auth![0], auth![1]),
    enabled: Boolean(auth),
  });
  const roomsQuery = useQuery({
    queryKey: ['hotel', 'rooms', session?.tenantId],
    queryFn: () => getHotelRooms(auth![0], auth![1]),
    enabled: Boolean(auth),
  });
  const roomTypesQuery = useQuery({
    queryKey: ['hotel', 'room-types', session?.tenantId],
    queryFn: () => getHotelRoomTypes(auth![0], auth![1]),
    enabled: Boolean(auth),
  });
  const channelsQuery = useQuery({
    queryKey: ['hotel', 'channels', session?.tenantId],
    queryFn: () => getHotelChannels(auth![0], auth![1]),
    enabled: Boolean(auth),
  });
  const guestsQuery = useQuery({
    queryKey: ['hotel', 'guests', session?.tenantId],
    queryFn: () => getHotelGuests(auth![0], auth![1]),
    enabled: Boolean(auth),
  });

  const invalidateHotel = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hotel', 'reservations'] }),
      queryClient.invalidateQueries({ queryKey: ['hotel', 'rooms'] }),
      queryClient.invalidateQueries({ queryKey: ['hotel', 'channels'] }),
      queryClient.invalidateQueries({ queryKey: ['hotel', 'guests'] }),
      queryClient.invalidateQueries({ queryKey: ['hotel', 'dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['hotel', 'requests'] }),
    ]);
  };
  const createMutation = useMutation({
    mutationFn: (payload: CreateHotelReservationPayload) =>
      createHotelReservation(auth![0], auth![1], payload),
    onSuccess: async (reservation) => {
      // La reservación nueva entra a la lista al instante, así "Siguiente acción" abre esa y no otra.
      queryClient.setQueryData<HotelReservation[]>(['hotel', 'reservations', session?.tenantId], (current) =>
        current ? [...current.filter((item) => item.id !== reservation.id), reservation] : [reservation],
      );
      setReservationOpen(false);
      setSelectedId(reservation.id);
      setActionOpen(true);
      await invalidateHotel();
      toast.success(`Reservación ${reservation.code} creada`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const updateMutation = useMutation({
    mutationFn: ({
      reservationId,
      payload,
    }: {
      reservationId: string;
      payload: UpdateHotelReservationPayload;
    }) => updateHotelReservation(auth![0], auth![1], reservationId, payload),
    onSuccess: async (reservation) => {
      setEditingId(null);
      setSelectedId(reservation.id);
      setActionOpen(true);
      await invalidateHotel();
      toast.success(`Reservación ${reservation.code} actualizada`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const assignMutation = useMutation({
    mutationFn: ({ reservationId, roomId }: { reservationId: string; roomId: string }) =>
      assignHotelRoom(auth![0], auth![1], reservationId, roomId),
    onSuccess: async () => {
      await invalidateHotel();
      toast.success('Habitación asignada');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const statusMutation = useMutation({
    mutationFn: ({
      reservationId,
      nextStatus,
      grantCredit,
      payLater,
    }: {
      reservationId: string;
      nextStatus: string;
      grantCredit?: boolean;
      payLater?: boolean;
    }) =>
      updateHotelReservationStatus(auth![0], auth![1], reservationId, nextStatus, { grantCredit, payLater }),
    onSuccess: async (reservation) => {
      setCheckoutReservation(null);
      setCheckInAsk(null);
      await invalidateHotel();
      toast.success(`Estado actualizado: ${reservationStatusLabels[reservation.status]}`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const creditMutation = useMutation({
    mutationFn: (reservationId: string) => applyHotelGuestCredit(auth![0], auth![1], reservationId),
    onSuccess: async (reservation) => {
      setReceiptReservation(reservation);
      await invalidateHotel();
      toast.success('Crédito a favor aplicado');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const paymentMutation = useMutation({
    mutationFn: ({
      reservationId,
      payload,
    }: {
      reservationId: string;
      payload: Parameters<typeof recordHotelPayment>[3];
    }) => recordHotelPayment(auth![0], auth![1], reservationId, payload),
    onSuccess: async (reservation) => {
      setPaymentOpen(false);
      setReceiptReservation(reservation);
      await invalidateHotel();
      toast.success('Cobro registrado correctamente');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reservations = reservationsQuery.data ?? [];
  useEffect(() => {
    if (!selectedId && reservations[0]) setSelectedId(reservations[0].id);
  }, [reservations, selectedId]);
  const selected =
    reservations.find((item) => item.id === selectedId) ?? (selectedId ? null : reservations[0] ?? null);
  useEffect(() => setRoomChoice(selected?.room?.id ?? ''), [selected?.id, selected?.room?.id]);

  const filtered = useMemo(
    () =>
      reservations.filter((item) => {
        const text = [
          item.code,
          item.guest.firstName,
          item.guest.lastName,
          item.channel?.name,
          item.room?.number,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const matchesStatus =
          status === 'ALL' ||
          (status === 'ACTIVE' &&
            ['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(item.status)) ||
          item.status === status;
        const stayStart = localDateKey(item.checkIn);
        const stayEnd = localDateKey(item.checkOut);
        const matchesDates = (!dateFrom || stayEnd >= dateFrom) && (!dateTo || stayStart <= dateTo);
        return text.includes(query.toLowerCase()) && matchesStatus && matchesDates;
      }),
    [dateFrom, dateTo, query, reservations, status],
  );
  const compatibleRooms = (roomsQuery.data ?? []).filter(
    (room) =>
      room.roomType.id === selected?.roomType.id &&
      room.status === 'AVAILABLE' &&
      room.housekeepingStatus === 'CLEAN' &&
      !reservations.some(
        (reservation) =>
          reservation.id !== selected?.id &&
          reservation.room?.id === room.id &&
          !['CANCELLED', 'CHECKED_OUT', 'NO_SHOW'].includes(reservation.status) &&
          new Date(reservation.checkIn) < new Date(selected?.checkOut ?? 0) &&
          new Date(reservation.checkOut) > new Date(selected?.checkIn ?? 0),
      ),
  );
  const channelSummary = (channelsQuery.data ?? []).map((channel) => ({
    name: channel.name,
    value: reservations.filter((reservation) => reservation.channel?.id === channel.id).length,
  }));
  const busy = assignMutation.isPending || statusMutation.isPending;

  if (!session) return <EmptyState text="Inicia sesión nuevamente para operar el hotel." />;
  if (reservationsQuery.isLoading) return <EmptyState text="Cargando operación hotelera..." />;
  if (reservationsQuery.error)
    return <EmptyState text={(reservationsQuery.error as Error).message} />;

  return (
    <div className="space-y-3 pb-5">
      <header
        className={`${view === 'calendar' ? 'hidden md:flex' : 'flex'} flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center`}
      >
        <div>
          <p className="text-xs font-semibold text-teal">Reservaciones</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Flujo de reservaciones</h1>
          <p className="mt-1 text-sm text-slate-500">
            Crea, asigna, cobra y completa la estadía desde un solo lugar.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => reservationsQuery.refetch()}
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold"
          >
            <RefreshCw
              className={`h-4 w-4 ${reservationsQuery.isFetching ? 'animate-spin' : ''}`}
            />{' '}
            Actualizar
          </button>
          <button
            type="button"
            onClick={() => router.push('/reservations/new')}
            className="flex items-center gap-2 rounded-lg bg-teal px-4 py-2.5 text-sm font-semibold text-white"
          >
            <Plus className="h-4 w-4" /> Nueva reservación
          </button>
        </div>
      </header>

      {/* Recepción no ve los totales del hotel (información sensible). */}
      {isReceptionSession(session) ? null : (
      <section className={`${view === 'calendar' ? 'hidden md:grid' : 'grid'} gap-3 sm:grid-cols-2 xl:grid-cols-4`}>
        <Stat
          title="Reservaciones"
          value={String(reservations.length)}
          detail="Registradas en el sistema"
        />
        <Stat
          title="Por asignar"
          value={String(
            reservations.filter(
              (item) => !item.room && !['CANCELLED', 'CHECKED_OUT'].includes(item.status),
            ).length,
          )}
          detail="Requieren habitación"
        />
        <Stat
          title="En estadía"
          value={String(reservations.filter((item) => item.status === 'CHECKED_IN').length)}
          detail="Huéspedes alojados"
        />
        <Stat
          title="Balance pendiente"
          value={formatMoney(reservations.reduce((sum, item) => sum + reservationBalance(item), 0))}
          detail="Pendiente de cobro"
        />
      </section>
      )}

      {view === 'calendar' ? (
        <ReservationsCalendar
          reservations={reservations}
          rooms={roomsQuery.data ?? []}
          roomTypes={roomTypesQuery.data ?? []}
          guests={guestsQuery.data ?? []}
          channels={channelsQuery.data ?? []}
          onOpenReservation={(id) => {
            setSelectedId(id);
            setActionOpen(true);
          }}
          onCreate={(payload) => createMutation.mutateAsync(payload)}
          onNew={() => router.push('/reservations/new')}
        />
      ) : (
      <section className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_14.5rem]">
        <article className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-sm font-bold">Reservaciones registradas</h2>
              <p className="text-xs text-slate-500">
                Por defecto ves las reservas que todavía requieren atención.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 w-64 rounded-lg border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-teal"
                  placeholder="Buscar huésped, reserva o canal..."
                />
              </label>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs"
              >
                <option value="ACTIVE">Reservadas y pendientes</option>
                <option value="PENDING_REVIEW">Pendiente de revisión</option>
                <option value="CONFIRMED">Confirmada</option>
                <option value="ASSIGNED">Habitación asignada</option>
                <option value="CHECKED_IN">En estadía</option>
                <option value="CHECKED_OUT">Check-out completado</option>
                <option value="CANCELLED">Cancelada</option>
                <option value="NO_SHOW">No se presentó</option>
                <option value="ALL">Todos los estados</option>
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3 sm:flex-row sm:items-end">
            <label className="grid gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Desde
              <span className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 normal-case">
                <CalendarDays className="h-4 w-4 text-teal" />
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => setDateFrom(event.target.value)}
                  className="bg-transparent text-xs font-semibold text-slate-800 outline-none"
                />
              </span>
            </label>
            <label className="grid gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Hasta
              <span className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 normal-case">
                <CalendarDays className="h-4 w-4 text-teal" />
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => setDateTo(event.target.value)}
                  className="bg-transparent text-xs font-semibold text-slate-800 outline-none"
                />
              </span>
            </label>
            <button
              type="button"
              onClick={() => {
                setStatus('ACTIVE');
                setDateFrom('');
                setDateTo('');
                setQuery('');
              }}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:border-teal hover:text-teal-deep"
            >
              <RotateCcw className="h-4 w-4" /> Limpiar filtros
            </button>
            <p className="pb-2 text-[10px] text-slate-500 sm:ml-auto">
              Las fechas incluyen reservaciones cuya estadía cruza el periodo seleccionado.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[58rem] text-left text-xs">
              <thead className="bg-slate-50 text-[11px] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Reserva</th>
                  <th className="px-3 py-3">Huésped</th>
                  <th className="px-3 py-3">Estadía</th>
                  <th className="px-3 py-3">Habitación</th>
                  <th className="px-3 py-3">Canal</th>
                  <th className="px-3 py-3">Balance</th>
                  <th className="px-3 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setActionOpen(true);
                    }}
                    className={`cursor-pointer border-t border-slate-100 transition hover:bg-teal-light/30 ${item.id === selected?.id ? 'bg-teal-light/60' : ''}`}
                  >
                    <td className="px-4 py-3 font-bold">{item.code}</td>
                    <td className="px-3 py-3">
                      <span className="block font-semibold">
                        {item.guest.firstName} {item.guest.lastName}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {item.guest.phone || 'Sin contacto'}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="block">
                        {formatStayDateTime(item.checkIn)} – {formatStayDateTime(item.checkOut)}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {nightsBetween(item.checkIn, item.checkOut)} noches
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      {item.room ? `Hab. ${item.room.number}` : item.roomType.name}
                    </td>
                    <td className="px-3 py-3">
                      {item.channel ? <ChannelBadge name={item.channel.name} /> : '—'}
                    </td>
                    <td
                      className={`px-3 py-3 font-semibold ${reservationBalance(item) > 0 ? 'text-rose-600' : 'text-emerald-700'}`}
                    >
                      {formatMoney(reservationBalance(item))}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-semibold ${reservationStatusTones[item.status]}`}
                      >
                        {reservationStatusLabels[item.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length ? (
            <p className="border-t p-8 text-center text-sm text-slate-500">
              No hay reservaciones con esos filtros.
            </p>
          ) : null}
        </article>

        <aside className="space-y-3">

          <article className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <h2 className="text-sm font-bold">Resumen por canal</h2>
            <div className="mt-2 space-y-1.5">
              {channelSummary.map((item) => (
                <div key={item.name} className="flex items-center justify-between text-xs">
                  <ChannelLabel name={item.name} />
                  <span className="font-bold">{item.value}</span>
                </div>
              ))}
            </div>
          </article>
        </aside>
      </section>
      )}

          {selected ? (
            <ActionDialog
              open={actionOpen}
              title={`${selected.code} · ${selected.guest.firstName} ${selected.guest.lastName}`}
              description="Revisa la reserva y ejecuta la siguiente acción del flujo."
              eyebrow="Siguiente acción"
              confirmLabel=""
              hideFooter
              size="md"
              onClose={() => setActionOpen(false)}
              onConfirm={() => undefined}
            >
              <article>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-semibold text-slate-500">Estado de la reservación</p>
                  <span
                    className={`rounded-full px-2 py-1 text-[9px] font-semibold ${reservationStatusTones[selected.status]}`}
                  >
                    {reservationStatusLabels[selected.status]}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <ReservationInfoCard
                    icon={BedDouble}
                    label="Habitación"
                    value={selected.room ? `Hab. ${selected.room.number}` : 'Sin asignar'}
                    detail={`${selected.room ? 'Tipo de habitación' : 'Tipo solicitado'}: ${selected.roomType.name}`}
                    tone={selected.room ? 'teal' : 'amber'}
                    highlightDetail
                  />
                  <ReservationInfoCard
                    icon={CalendarDays}
                    label="Estadía"
                    value={`${nightsBetween(selected.checkIn, selected.checkOut)} ${nightsBetween(selected.checkIn, selected.checkOut) === 1 ? 'noche' : 'noches'}`}
                    detail={`${formatStayDateTime(selected.checkIn)} – ${formatStayDateTime(selected.checkOut)}`}
                    tone="slate"
                  />
                </div>

                <StayHighlight checkIn={selected.checkIn} checkOut={selected.checkOut} />

                {guestCredit(selected) > 0 ? (
                  <div className="mt-3 rounded-xl border border-teal/30 bg-teal-light/40 px-3 py-2.5 text-xs text-teal-deep">
                    <span className="font-bold">Crédito a favor del huésped: {formatMoney(guestCredit(selected))}</span>
                    {' · '}
                    {(selected.guest.credits ?? [])
                      .map(
                        (credit) =>
                          `${credit.nights} ${credit.nights === 1 ? 'noche' : 'noches'} de ${credit.sourceReservation?.code ?? 'una estadía anterior'}`,
                      )
                      .join(', ')}
                  </div>
                ) : null}

                <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <span className="text-xs font-semibold text-slate-500">Canal de reservación</span>
                  {selected.channel ? <ChannelBadge name={selected.channel.name} /> : '—'}
                </div>

                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
                    Resumen del pago
                  </p>
                  <dl className="mt-2 grid grid-cols-3 divide-x divide-slate-200 text-xs">
                    <div className="pr-3">
                      <dt className="text-slate-500">Total</dt>
                      <dd className="mt-1 font-bold text-slate-900">
                        {formatMoney(selected.totalAmount)}
                      </dd>
                    </div>
                    <div className="px-3">
                      <dt className="text-slate-500">Pagado</dt>
                      <dd className="mt-1 font-bold text-slate-900">
                        {formatMoney(selected.paidAmount)}
                      </dd>
                    </div>
                    <div className="pl-3">
                      <dt className="text-slate-500">Balance</dt>
                      <dd
                        className={
                          reservationBalance(selected)
                            ? 'mt-1 font-extrabold text-rose-600'
                            : 'mt-1 font-extrabold text-emerald-700'
                        }
                      >
                        {formatMoney(reservationBalance(selected))}
                      </dd>
                    </div>
                  </dl>
                </div>

                {!selected.room && !['CANCELLED', 'CHECKED_OUT'].includes(selected.status) ? (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-semibold text-amber-900">1. Asignar habitación</p>
                    <div className="mt-2 flex gap-2">
                      <select
                        value={roomChoice}
                        onChange={(event) => setRoomChoice(event.target.value)}
                        className="h-9 min-w-0 flex-1 rounded-lg border border-amber-200 bg-white px-2 text-xs"
                      >
                        <option value="">Seleccionar</option>
                        {compatibleRooms.map((room) => (
                          <option key={room.id} value={room.id}>
                            Hab. {room.number}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={!roomChoice || busy}
                        onClick={() =>
                          assignMutation.mutate({ reservationId: selected.id, roomId: roomChoice })
                        }
                        className="rounded-lg bg-amber-600 px-3 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Asignar
                      </button>
                    </div>
                  </div>
                ) : null}

                {selected.status === 'PENDING_REVIEW' && selected.channel?.type === 'DIRECT_WEB' ? (
                  <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3">
                    <p className="text-xs font-bold text-sky-900">
                      Solicitud{selected.channel ? ` desde ${selected.channel.name}` : ''} pendiente de aprobación
                    </p>
                    <p className="mt-1 text-[11px] text-sky-800">
                      Revisa los datos; puedes modificarla antes de aprobarla.
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          statusMutation.mutate({ reservationId: selected.id, nextStatus: 'CONFIRMED' })
                        }
                        className="rounded-lg bg-teal px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                      >
                        Aprobar solicitud
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `¿Rechazar la solicitud ${selected.code}? La reservación quedará cancelada.`,
                            )
                          )
                            statusMutation.mutate({ reservationId: selected.id, nextStatus: 'CANCELLED' });
                        }}
                        className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-bold text-rose-700 disabled:opacity-50"
                      >
                        Rechazar
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 grid gap-2">
                  <GuestWhatsAppButton reservation={selected} />
                  {['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(selected.status) ? (
                    <FlowButton
                      icon={Pencil}
                      label="Editar reservación"
                      disabled={busy || updateMutation.isPending}
                      onClick={() => {
                        setActionOpen(false);
                        router.push(`/reservations/${selected.id}/edit`);
                      }}
                    />
                  ) : null}
                  {['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(selected.status) ? (
                    <FlowButton
                      icon={DoorOpen}
                      label="Registrar check-in"
                      disabled={!selected.room || busy}
                      onClick={() => {
                        setActionOpen(false);
                        if (reservationBalance(selected) > 0) {
                          setCheckInAsk(selected);
                          return;
                        }
                        statusMutation.mutate({
                          reservationId: selected.id,
                          nextStatus: 'CHECKED_IN',
                        });
                      }}
                    />
                  ) : null}
                  {reservationBalance(selected) > 0 &&
                  !['CANCELLED', 'CHECKED_OUT'].includes(selected.status) &&
                  guestCredit(selected) > 0 ? (
                    <FlowButton
                      icon={CircleDollarSign}
                      label={`Aplicar crédito a favor · ${formatMoney(Math.min(guestCredit(selected), reservationBalance(selected)))}`}
                      disabled={creditMutation.isPending}
                      onClick={() => creditMutation.mutate(selected.id)}
                    />
                  ) : null}
                  {reservationBalance(selected) > 0 && !['CANCELLED'].includes(selected.status) ? (
                    <FlowButton
                      icon={CircleDollarSign}
                      label={`Ejecutar pago · ${formatMoney(reservationBalance(selected))}`}
                      disabled={
                        paymentMutation.isPending || !canCollectReservationPayment(selected)
                      }
                      onClick={() =>
                        router.push(
                          `/reservations/${selected.id}/payment?return=${encodeURIComponent(`/reservations?open=${selected.id}`)}`,
                        )
                      }
                    />
                  ) : null}
                  {selected.status === 'CHECKED_IN' ? (
                    <FlowButton
                      icon={LogOut}
                      label="Registrar check-out"
                      disabled={reservationBalance(selected) > 0 || busy}
                      onClick={() => {
                        setActionOpen(false);
                        if (earlyCheckoutPreview(selected)) {
                          setCheckoutReservation(selected);
                          return;
                        }
                        statusMutation.mutate({
                          reservationId: selected.id,
                          nextStatus: 'CHECKED_OUT',
                        });
                      }}
                    />
                  ) : null}
                </div>
                {canDeleteReservation(selected) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActionOpen(false);
                      setDeleting(selected);
                    }}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-3 py-2.5 text-sm font-bold text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="h-4 w-4" /> Eliminar reservación
                  </button>
                ) : null}
                {reservationBalance(selected) > 0 && !canCollectReservationPayment(selected) ? (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                    El cobro se habilitará el día de llegada. No se aceptan pagos por adelantado.
                  </p>
                ) : null}
                {selected.status === 'CHECKED_IN' && reservationBalance(selected) > 0 ? (
                  <p className="mt-2 text-[11px] text-amber-700">
                    Debes cobrar el balance antes del check-out.
                  </p>
                ) : null}
              </article>
            </ActionDialog>
          ) : null}
      <CheckInChoiceDialog
        reservation={checkInAsk}
        isPending={statusMutation.isPending}
        onClose={() => setCheckInAsk(null)}
        onPayNow={(item) =>
          router.push(
            `/reservations/${item.id}/payment?return=${encodeURIComponent(`/reservations?open=${item.id}`)}`,
          )
        }
        onPayLater={(item) =>
          statusMutation.mutate({ reservationId: item.id, nextStatus: 'CHECKED_IN', payLater: true })
        }
      />
      <DeleteReservationDialog
        reservation={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => setSelectedId(null)}
      />
      <PaymentReceiptDialog
        reservation={receiptReservation}
        open={Boolean(receiptReservation)}
        onClose={() => setReceiptReservation(null)}
      />
      <CheckoutConfirmDialog
        reservation={checkoutReservation}
        isPending={statusMutation.isPending}
        onCancel={() => setCheckoutReservation(null)}
        onConfirm={({ grantCredit }) =>
          checkoutReservation &&
          statusMutation.mutate({
            reservationId: checkoutReservation.id,
            nextStatus: 'CHECKED_OUT',
            grantCredit,
          })
        }
      />
    </div>
  );
}

/** Crédito a favor disponible del huésped de la reservación. */
function guestCredit(reservation: HotelReservation) {
  return (reservation.guest.credits ?? []).reduce(
    (sum, credit) => sum + Number(credit.remainingAmount),
    0,
  );
}

function Stat({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
      <p className="mt-1 text-[11px] text-slate-500">{detail}</p>
    </article>
  );
}

function FlowButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof BedDouble;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-teal-dark disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100"
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}

function ReservationInfoCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  highlightDetail = false,
}: {
  icon: typeof BedDouble;
  label: string;
  value: string;
  detail: string;
  tone: 'teal' | 'amber' | 'slate';
  highlightDetail?: boolean;
}) {
  const tones = {
    teal: 'bg-teal-light text-teal-deep',
    amber: 'bg-amber-50 text-amber-700',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
          {label}
        </span>
        <strong className="mt-0.5 block text-sm text-slate-950">{value}</strong>
        <span
          className={cn(
            'mt-0.5 block text-[11px] leading-4 text-slate-500',
            highlightDetail &&
              'w-fit rounded-md bg-teal-light/80 px-2 py-1 font-semibold text-teal-deep',
          )}
        >
          {detail}
        </span>
      </span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function localDateKey(value: string | Date) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

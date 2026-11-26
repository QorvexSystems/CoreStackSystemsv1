'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  BellRing,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  DoorOpen,
  LogOut,
  MessageCircle,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  UserX,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  getHotelReservations,
  recoverHotelReservation,
  updateHotelReservationStatus,
  type HotelReservation,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import {
  canDeleteReservation,
  checkoutAlert,
  formatMoney,
  formatStayDate,
  formatStayDateTime,
  hasReceptionPayment,
  isPastNoShowDeadline,
  reservationBalance,
  reservationStatusLabels,
  reservationStatusTones,
} from './hotel-flow';
import { CheckInChoiceDialog } from './check-in-choice-dialog';
import { CheckoutConfirmDialog, earlyCheckoutPreview } from './checkout-confirm-dialog';
import { DeleteReservationDialog } from './delete-reservation-dialog';
import { ExpressInvoiceButton } from './express-invoice-dialog';
import { PaymentReceiptDialog } from './payment-receipt-dialog';
import { whatsappUrl } from './whatsapp';

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN'];
const NO_SHOW_RETENTION_MS = 24 * 3_600_000;

export function HotelFrontDeskView() {
  const session = getSession();
  const isAdmin = ADMIN_ROLES.includes(session?.role ?? '');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [receiptReservation, setReceiptReservation] = useState<HotelReservation | null>(null);
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [checkoutReservation, setCheckoutReservation] = useState<HotelReservation | null>(null);
  const [checkInAsk, setCheckInAsk] = useState<HotelReservation | null>(null);
  const [deleting, setDeleting] = useState<HotelReservation | null>(null);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Reloj para las alertas de salida (11:00 AM / 12:00 PM) y la hora de inasistencia (9:00 PM).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const reservationsQuery = useQuery({
    queryKey: ['hotel', 'reservations', session?.tenantId],
    queryFn: () => getHotelReservations(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    refetchInterval: 60_000,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hotel'] });
  const statusMutation = useMutation({
    mutationFn: ({
      id,
      status,
      grantCredit,
      payLater,
    }: {
      id: string;
      status: string;
      grantCredit?: boolean;
      payLater?: boolean;
    }) =>
      updateHotelReservationStatus(session!.tenantId, session!.accessToken, id, status, {
        grantCredit,
        payLater,
      }),
    onSuccess: async (reservation, variables) => {
      setCheckoutReservation(null);
      setCheckInAsk(null);
      await invalidate();
      toast.success(
        variables.grantCredit
          ? `${reservationStatusLabels[reservation.status]} · crédito a favor guardado en la ficha del huésped`
          : variables.payLater
            ? 'Check-in registrado · el huésped paga al final'
            : reservationStatusLabels[reservation.status],
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const recoverMutation = useMutation({
    mutationFn: (id: string) => recoverHotelReservation(session!.tenantId, session!.accessToken, id),
    onSuccess: async (reservation) => {
      await invalidate();
      toast.success(
        reservation.room
          ? `Reservación ${reservation.code} recuperada · Hab. ${reservation.room.number}`
          : `Reservación ${reservation.code} recuperada · su habitación ya estaba ocupada, asígnale otra`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reservations = reservationsQuery.data ?? [];
  const weekStart = startOfWeek(weekAnchor);
  const weekEnd = addDays(weekStart, 7);
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const selectedDateKey = localDateKey(weekAnchor);
  const todayKey = localDateKey(now);
  const isTodaySelected = selectedDateKey === todayKey;
  const arrivals = reservations
    .filter(
      (item) =>
        ['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(item.status) &&
        !isPastNoShowDeadline(item, now) &&
        localDateKey(item.checkIn) === selectedDateKey,
    )
    .sort((first, second) => +new Date(first.checkIn) - +new Date(second.checkIn));
  const allInHouse = reservations.filter((item) => item.status === 'CHECKED_IN');
  const inHouse = allInHouse
    .filter(
      (item) =>
        localDateKey(item.checkIn) <= selectedDateKey &&
        // Hoy también aparecen los que debían salir antes y siguen sin check-out.
        (localDateKey(item.checkOut) >= selectedDateKey || isTodaySelected),
    )
    .sort((first, second) => +new Date(first.checkOut) - +new Date(second.checkOut));
  const departuresForDay = allInHouse
    .filter((item) =>
      isTodaySelected
        ? localDateKey(item.checkOut) <= selectedDateKey
        : localDateKey(item.checkOut) === selectedDateKey,
    )
    .sort((first, second) => +new Date(first.checkOut) - +new Date(second.checkOut));
  const overdueCount = departuresForDay.filter((item) => checkoutAlert(item, now) === 'overdue').length;
  const completed = reservations
    .filter(
      (item) =>
        item.status === 'CHECKED_OUT' &&
        localDateKey(item.checkedOutAt ?? item.checkOut) === selectedDateKey,
    )
    .sort(
      (first, second) =>
        +new Date(second.checkedOutAt ?? second.checkOut) -
        +new Date(first.checkedOutAt ?? first.checkOut),
    );
  const noShows = reservations
    .filter((item) => item.status === 'NO_SHOW' && item.noShowAt)
    .sort((first, second) => +new Date(second.noShowAt!) - +new Date(first.noShowAt!));

  const query = search.trim().toLocaleLowerCase('es');
  const results = useMemo(() => {
    if (!query) return [];
    const digits = query.replace(/\D/g, '');
    return reservations
      .filter((item) => {
        const text = [
          item.guest.firstName,
          item.guest.lastName,
          `${item.guest.firstName} ${item.guest.lastName}`,
          item.code,
          item.room?.number,
          item.roomType.name,
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase('es');
        const numbers = [item.guest.phone, item.guest.documentNumber].map((value) => (value ?? '').replace(/\D/g, ''));
        return text.includes(query) || (digits.length >= 3 && numbers.some((value) => value.includes(digits)));
      })
      .sort((first, second) => +new Date(second.checkIn) - +new Date(first.checkIn))
      .slice(0, 12);
  }, [query, reservations]);

  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <p className="text-xs font-semibold text-teal">Operación de recepción</p>
          <h1 className="mt-1 text-2xl font-extrabold">Check-in / Check-out</h1>
          <p className="mt-1 text-sm text-slate-500">
            Llegada a las 3:00 PM y salida a las 11:00 AM. Habitación asignada, check-in, cobro y check-out.
          </p>
        </div>
        <ExpressInvoiceButton />
      </header>
      <WeekFilter
        weekStart={weekStart}
        weekEnd={weekEnd}
        weekDays={weekDays}
        reservations={reservations}
        selectedDate={weekAnchor}
        onToday={() => setWeekAnchor(new Date())}
        onPrevious={() => setWeekAnchor(addDays(weekAnchor, -7))}
        onNext={() => setWeekAnchor(addDays(weekAnchor, 7))}
        onDateChange={setWeekAnchor}
      />

      {/* Buscador de huéspedes y reservaciones que no se presentaron */}
      <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative flex-1">
            <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar huésped: nombre, teléfono, cédula, reservación o habitación…"
              className="h-12 w-full rounded-xl border border-slate-200 pl-12 pr-11 text-base outline-none focus:border-teal focus:ring-4 focus:ring-teal/10"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Limpiar búsqueda"
                className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            ) : null}
          </label>
          <button
            type="button"
            onClick={() => setNoShowOpen(true)}
            className={`inline-flex h-12 items-center justify-center gap-2 rounded-xl border-2 px-4 text-sm font-extrabold ${
              noShows.length
                ? 'border-orange-300 bg-orange-50 text-orange-800'
                : 'border-slate-200 bg-white text-slate-600'
            }`}
          >
            <UserX className="h-5 w-5" /> No se presentaron
            <span
              className={`grid h-7 min-w-7 place-items-center rounded-full px-2 text-xs ${
                noShows.length ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-500'
              }`}
            >
              {noShows.length}
            </span>
          </button>
        </div>
        {query ? (
          <div className="mt-3 space-y-2">
            {results.length ? (
              results.map((item) => (
                <SearchResult
                  key={item.id}
                  reservation={item}
                  now={now}
                  isAdmin={isAdmin}
                  onShowDay={() => {
                    setWeekAnchor(
                      item.status === 'CHECKED_IN'
                        ? new Date()
                        : item.status === 'CHECKED_OUT'
                          ? new Date(item.checkedOutAt ?? item.checkOut)
                          : new Date(item.checkIn),
                    );
                    setSearch('');
                  }}
                />
              ))
            ) : (
              <p className="rounded-lg border border-dashed p-5 text-center text-sm text-slate-500">
                No hay huéspedes ni reservaciones con “{search.trim()}”.
              </p>
            )}
          </div>
        ) : null}
      </section>

      {departuresForDay.length ? (
        <section
          aria-live="polite"
          className={`rounded-xl border p-4 shadow-sm ${
            overdueCount ? 'border-rose-300 bg-rose-50' : 'border-amber-200 bg-amber-50'
          }`}
        >
          <div className={`flex items-center gap-2 ${overdueCount ? 'text-rose-800' : 'text-amber-900'}`}>
            {overdueCount ? <AlarmClock className="h-5 w-5" /> : <BellRing className="h-5 w-5" />}
            <h2 className="text-sm font-extrabold">
              {overdueCount
                ? `${overdueCount} ${overdueCount === 1 ? 'habitación sigue' : 'habitaciones siguen'} sin check-out (salida 11:00 AM)`
                : `Salidas de ${formatSelectedDay(weekAnchor)} · 11:00 AM (${departuresForDay.length})`}
            </h2>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {departuresForDay.map((reservation) => {
              const alert = checkoutAlert(reservation, now);
              return (
                <div
                  key={reservation.id}
                  className={`rounded-lg border-2 bg-white p-3 ${
                    alert === 'overdue' ? 'border-rose-400' : alert === 'due' ? 'border-amber-400' : 'border-amber-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-extrabold text-slate-900">
                        {reservation.room ? `Habitación ${reservation.room.number}` : 'Sin habitación'}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {reservation.guest.firstName} {reservation.guest.lastName}
                      </p>
                    </div>
                    <span
                      className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold ${
                        alert === 'overdue'
                          ? 'bg-rose-600 text-white'
                          : alert === 'due'
                            ? 'bg-amber-400 text-amber-950'
                            : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      <Clock3 className="h-3 w-3" /> 11:00 AM
                    </span>
                  </div>
                  <p
                    className={`mt-2 text-xs font-semibold ${
                      alert === 'overdue' ? 'text-rose-700' : 'text-amber-800'
                    }`}
                  >
                    {alert === 'overdue'
                      ? localDateKey(reservation.checkOut) < todayKey
                        ? `Debía salir el ${formatStayDate(reservation.checkOut)} y aún no se ha hecho check-out.`
                        : 'Pasó más de 1 hora de la salida y aún no se ha hecho check-out.'
                      : alert === 'due'
                        ? 'Ya es la hora de salida: haz el check-out.'
                        : `Check-out programado para ${formatSelectedDay(weekAnchor)}.`}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {reservationsQuery.isLoading ? <PanelMessage text="Cargando recepción..." /> : null}
      {reservationsQuery.error ? (
        <PanelMessage text={(reservationsQuery.error as Error).message} />
      ) : null}
      {!reservationsQuery.isLoading && !reservationsQuery.error ? (
        <section className="grid gap-3 xl:grid-cols-3">
          <FrontDeskColumn
            title={`Llegadas del ${formatShortSelectedDay(weekAnchor)}`}
            count={arrivals.length}
            empty="No hay llegadas pendientes para este día."
          >
            {arrivals.map((reservation) => {
              const balance = reservationBalance(reservation);
              return (
                <ReservationCard key={reservation.id} reservation={reservation} focus="arrival">
                  <div className="flex flex-wrap justify-end gap-2">
                    {canDeleteReservation(reservation) ? (
                      <button
                        type="button"
                        onClick={() => setDeleting(reservation)}
                        aria-label={`Eliminar reservación ${reservation.code}`}
                        title="Eliminar reservación"
                        className="grid h-9 w-9 place-items-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                    {!reservation.room ? (
                      <Link
                        href={`/reservations?q=${reservation.code}`}
                        className="rounded-lg border border-teal px-3 py-2 text-[11px] font-semibold text-teal-deep"
                      >
                        Asignar habitación
                      </Link>
                    ) : (
                      <button
                        disabled={statusMutation.isPending}
                        onClick={() =>
                          balance > 0
                            ? setCheckInAsk(reservation)
                            : statusMutation.mutate({ id: reservation.id, status: 'CHECKED_IN' })
                        }
                        className="flex items-center gap-1.5 rounded-lg bg-teal px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50"
                      >
                        <DoorOpen className="h-3.5 w-3.5" /> Check-in
                      </button>
                    )}
                  </div>
                </ReservationCard>
              );
            })}
          </FrontDeskColumn>
          <FrontDeskColumn
            title="Huéspedes alojados ese día"
            count={inHouse.length}
            empty="No hay estadías activas para este día."
          >
            {inHouse.map((reservation) => {
              const balance = reservationBalance(reservation);
              const alert = checkoutAlert(reservation, now);
              return (
                <ReservationCard
                  key={reservation.id}
                  reservation={reservation}
                  focus="stay"
                  alert={alert}
                >
                  {balance > 0 ? (
                    <button
                      onClick={() => router.push(`/reservations/${reservation.id}/payment?return=/check-in-out`)}
                      className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-[11px] font-semibold text-white"
                    >
                      <CircleDollarSign className="h-3.5 w-3.5" /> Cobrar {formatMoney(balance)}
                    </button>
                  ) : (
                    <button
                      disabled={statusMutation.isPending}
                      onClick={() =>
                        earlyCheckoutPreview(reservation)
                          ? setCheckoutReservation(reservation)
                          : statusMutation.mutate({ id: reservation.id, status: 'CHECKED_OUT' })
                      }
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50 ${
                        alert === 'overdue' ? 'bg-rose-600' : 'bg-teal'
                      }`}
                    >
                      <LogOut className="h-3.5 w-3.5" /> Check-out
                    </button>
                  )}
                </ReservationCard>
              );
            })}
          </FrontDeskColumn>
          <FrontDeskColumn
            title={`Salidas completadas el ${formatShortSelectedDay(weekAnchor)}`}
            count={completed.length}
            empty="No hay salidas completadas para este día."
          >
            {completed.map((reservation) => (
              <ReservationCard key={reservation.id} reservation={reservation} focus="departure" />
            ))}
          </FrontDeskColumn>
        </section>
      ) : null}

      {/* Check-in con balance: cobrar ahora o al final */}
      <CheckInChoiceDialog
        reservation={checkInAsk}
        isPending={statusMutation.isPending}
        onClose={() => setCheckInAsk(null)}
        onPayNow={(item) => router.push(`/reservations/${item.id}/payment?return=/check-in-out`)}
        onPayLater={(item) => statusMutation.mutate({ id: item.id, status: 'CHECKED_IN', payLater: true })}
      />

      {/* Reservaciones que no se presentaron (9:00 PM sin check-in) */}
      {noShowOpen ? (
        <ActionDialog
          open
          size="lg"
          tone="warning"
          eyebrow="Sin check-in a las 9:00 PM"
          title="No se presentaron"
          description="Ya no ocupan habitación ni aparecen en el calendario. Si el huésped llega, recupérala; si no, se borra sola 24 horas después."
          icon={<UserX className="h-5 w-5" />}
          confirmLabel="Cerrar"
          hideCancel
          onClose={() => setNoShowOpen(false)}
          onConfirm={() => setNoShowOpen(false)}
        >
          {noShows.length ? (
            <div className="space-y-2">
              {noShows.map((item) => {
                const left = new Date(item.noShowAt!).getTime() + NO_SHOW_RETENTION_MS - now.getTime();
                const keeps = hasReceptionPayment(item);
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 rounded-xl border border-orange-200 bg-orange-50/60 p-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-extrabold text-slate-900">
                        {item.guest.firstName} {item.guest.lastName}
                      </p>
                      <p className="text-sm text-slate-600">
                        {item.code} · {item.room ? `Hab. ${item.room.number}` : item.roomType.name} ·{' '}
                        {formatStayDate(item.checkIn)} → {formatStayDate(item.checkOut)}
                      </p>
                      <p className="mt-0.5 text-xs font-semibold text-orange-800">
                        {keeps
                          ? 'Tiene un cobro registrado: no se borra sola.'
                          : `Se borra en ${formatRemaining(left)}`}
                        {item.guest.phone ? ` · Tel. ${item.guest.phone}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {isAdmin && whatsappUrl(item.guest.phone) ? (
                        <a
                          href={whatsappUrl(item.guest.phone, `Hola ${item.guest.firstName}, le escribimos del Hotel Suite Ancla sobre su reservación ${item.code}.`)!}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Escribir por WhatsApp"
                          className="grid h-11 w-11 place-items-center rounded-xl bg-[#25D366] text-white"
                        >
                          <MessageCircle className="h-5 w-5" />
                        </a>
                      ) : null}
                      {canDeleteReservation(item) ? (
                        <button
                          type="button"
                          onClick={() => setDeleting(item)}
                          aria-label="Eliminar"
                          className="grid h-11 w-11 place-items-center rounded-xl border border-rose-200 bg-white text-rose-600"
                        >
                          <Trash2 className="h-5 w-5" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={recoverMutation.isPending}
                        onClick={() => recoverMutation.mutate(item.id)}
                        className="flex h-11 items-center gap-2 rounded-xl bg-teal px-4 text-sm font-extrabold text-white disabled:opacity-50"
                      >
                        <Undo2 className="h-4 w-4" /> Recuperar reservación
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-slate-500">
              No hay reservaciones sin presentarse.
            </p>
          )}
        </ActionDialog>
      ) : null}

      <DeleteReservationDialog reservation={deleting} onClose={() => setDeleting(null)} />
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
          statusMutation.mutate({ id: checkoutReservation.id, status: 'CHECKED_OUT', grantCredit })
        }
      />
    </div>
  );
}

/** Un resultado del buscador: estado del huésped y (para el administrador) acceso directo a WhatsApp. */
function SearchResult({
  reservation,
  now,
  isAdmin,
  onShowDay,
}: {
  reservation: HotelReservation;
  now: Date;
  isAdmin: boolean;
  onShowDay: () => void;
}) {
  const alert = checkoutAlert(reservation, now);
  const balance = reservationBalance(reservation);
  const chat = isAdmin
    ? whatsappUrl(
        reservation.guest.phone,
        `Hola ${reservation.guest.firstName}, le escribimos del Hotel Suite Ancla sobre su reservación ${reservation.code}.`,
      )
    : null;
  const stateText =
    reservation.status === 'CHECKED_IN'
      ? alert === 'overdue'
        ? 'Alojado · check-out pendiente (salida 11:00 AM)'
        : `Alojado · sale ${formatStayDate(reservation.checkOut)} 11:00 AM`
      : reservation.status === 'CHECKED_OUT'
        ? `Salió ${formatStayDateTime(reservation.checkedOutAt ?? reservation.checkOut)}`
        : reservation.status === 'NO_SHOW'
          ? 'No se presentó a su llegada'
          : `Llega ${formatStayDate(reservation.checkIn)} 3:00 PM`;
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center ${
        alert === 'overdue' ? 'border-rose-300 bg-rose-50' : 'border-slate-200'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-base font-extrabold text-slate-900">
            {reservation.guest.firstName} {reservation.guest.lastName}
          </p>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${reservationStatusTones[reservation.status]}`}>
            {reservationStatusLabels[reservation.status]}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {reservation.code} · {reservation.room ? `Hab. ${reservation.room.number}` : 'Sin habitación'} ·{' '}
          {reservation.roomType.name} · {formatStayDate(reservation.checkIn)} → {formatStayDate(reservation.checkOut)}
        </p>
        <p className={`text-xs font-semibold ${alert === 'overdue' ? 'text-rose-700' : 'text-teal-deep'}`}>
          {stateText}
          {balance > 0 ? <span className="text-rose-600"> · Balance {formatMoney(balance)}</span> : null}
          {reservation.guest.phone ? <span className="text-slate-500"> · Tel. {reservation.guest.phone}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {chat ? (
          <a
            href={chat}
            target="_blank"
            rel="noreferrer"
            className="flex h-11 items-center gap-2 rounded-xl bg-[#25D366] px-4 text-sm font-extrabold text-white"
          >
            <MessageCircle className="h-4 w-4" /> WhatsApp
          </a>
        ) : null}
        <button
          type="button"
          onClick={onShowDay}
          className="flex h-11 items-center gap-2 rounded-xl border border-teal px-4 text-sm font-bold text-teal-deep"
        >
          <CalendarDays className="h-4 w-4" /> Ver día
        </button>
      </div>
    </div>
  );
}

function formatRemaining(ms: number) {
  if (ms <= 0) return 'unos minutos';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function WeekFilter({
  weekStart,
  weekEnd,
  weekDays,
  reservations,
  selectedDate,
  onToday,
  onPrevious,
  onNext,
  onDateChange,
}: {
  weekStart: Date;
  weekEnd: Date;
  weekDays: Date[];
  reservations: HotelReservation[];
  selectedDate: Date;
  onToday: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onDateChange: (date: Date) => void;
}) {
  const isTodaySelected = localDateKey(selectedDate) === localDateKey(new Date());

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToday}
            className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-xs font-bold text-slate-700 transition hover:border-teal hover:text-teal-deep"
          >
            Hoy
          </button>
          <div className="flex overflow-hidden rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={onPrevious}
              className="grid h-9 w-9 place-items-center border-r border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-teal-deep"
              aria-label="Semana anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onNext}
              className="grid h-9 w-9 place-items-center text-slate-500 transition hover:bg-slate-50 hover:text-teal-deep"
              aria-label="Semana siguiente"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-teal">
              Calendario operativo
            </p>
            <h2 className="text-sm font-extrabold text-slate-950">
              {formatWeekRange(weekStart, addDays(weekEnd, -1))}
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isTodaySelected ? (
            <button
              type="button"
              onClick={onToday}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-teal hover:bg-teal-light/40 hover:text-teal-deep"
            >
              <RotateCcw className="h-4 w-4" />
              Limpiar filtro
            </button>
          ) : null}
          <label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600">
            <CalendarDays className="h-4 w-4 text-teal" />
            Ir a fecha
            <input
              type="date"
              value={localDateKey(selectedDate)}
              onChange={(event) => {
                if (event.target.value) onDateChange(parseLocalDate(event.target.value));
              }}
              className="bg-transparent font-bold text-slate-900 outline-none"
              aria-label="Seleccionar día operativo"
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="grid min-w-[47rem] grid-cols-7 divide-x divide-slate-200">
          {weekDays.map((day) => {
            const arrivals = reservations.filter(
              (reservation) =>
                !['CANCELLED', 'NO_SHOW'].includes(reservation.status) &&
                localDateKey(reservation.checkIn) === localDateKey(day),
            ).length;
            const departures = reservations.filter(
              (reservation) =>
                !['CANCELLED', 'NO_SHOW'].includes(reservation.status) &&
                localDateKey(reservation.checkOut) === localDateKey(day),
            ).length;
            const today = localDateKey(day) === localDateKey(new Date());
            const selected = localDateKey(day) === localDateKey(selectedDate);
            return (
              <button
                type="button"
                key={localDateKey(day)}
                onClick={() => onDateChange(day)}
                aria-pressed={selected}
                className={`min-h-20 px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal ${
                  selected
                    ? 'bg-teal text-white'
                    : today
                      ? 'bg-teal-light/60'
                      : 'bg-white hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[10px] font-bold uppercase ${selected ? 'text-white/80' : 'text-slate-500'}`}
                  >
                    {new Intl.DateTimeFormat('es-DO', { weekday: 'short' })
                      .format(day)
                      .replace('.', '')}
                  </span>
                  <span
                    className={`grid h-7 w-7 place-items-center rounded-full text-xs font-extrabold ${
                      selected
                        ? 'bg-white text-teal-deep'
                        : today
                          ? 'bg-teal text-white'
                          : 'text-slate-900'
                    }`}
                  >
                    {day.getDate()}
                  </span>
                </div>
                <div
                  className={`mt-2 space-y-0.5 text-[10px] ${selected ? 'text-white/80' : 'text-slate-500'}`}
                >
                  <p>
                    <strong className={selected ? 'text-white' : 'text-slate-800'}>
                      {arrivals}
                    </strong>{' '}
                    {arrivals === 1 ? 'llegada' : 'llegadas'}
                  </p>
                  <p>
                    <strong className={selected ? 'text-white' : 'text-slate-800'}>
                      {departures}
                    </strong>{' '}
                    {departures === 1 ? 'salida' : 'salidas'}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FrontDeskColumn({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">{title}</h2>
        <span className="rounded-full bg-teal-light px-2 py-1 text-xs font-bold text-teal-deep">
          {count}
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {count ? (
          children
        ) : (
          <p className="rounded-lg border border-dashed p-6 text-center text-xs text-slate-500">
            {empty}
          </p>
        )}
      </div>
    </article>
  );
}

function ReservationCard({
  reservation,
  children,
  focus,
  alert = null,
}: {
  reservation: HotelReservation;
  children?: React.ReactNode;
  focus: 'arrival' | 'stay' | 'departure';
  /** Salida: 'due' desde las 11:00 AM (amarillo), 'overdue' desde las 12:00 PM (rojo). */
  alert?: 'due' | 'overdue' | null;
}) {
  const highlightedDate = focus === 'arrival' ? reservation.checkIn : reservation.checkOut;
  const highlightedLabel =
    focus === 'arrival'
      ? 'Llegada programada'
      : focus === 'departure'
        ? 'Salida registrada'
        : 'Salida programada';
  const isToday = localDateKey(highlightedDate) === localDateKey(new Date());

  return (
    <div
      className={`rounded-lg border p-3 shadow-sm ${
        alert === 'overdue'
          ? 'border-2 border-rose-500 bg-rose-50'
          : alert === 'due'
            ? 'border-2 border-amber-400 bg-amber-50/60'
            : 'border-slate-200'
      }`}
    >
      {alert ? (
        <p
          className={`-mx-3 -mt-3 mb-3 flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-[11px] font-extrabold ${
            alert === 'overdue' ? 'bg-rose-600 text-white' : 'bg-amber-400 text-amber-950'
          }`}
        >
          <AlarmClock className="h-3.5 w-3.5" />
          {alert === 'overdue' ? 'CHECK-OUT PENDIENTE · salida 11:00 AM' : 'HORA DE SALIDA · 11:00 AM'}
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold">
            {reservation.guest.firstName} {reservation.guest.lastName}
          </p>
          <p className="text-[10px] text-slate-500">
            {reservation.code} ·{' '}
            {reservation.room ? `Hab. ${reservation.room.number}` : 'Sin habitación'}
          </p>
          <p className="mt-0.5 text-[10px] font-semibold text-teal-deep">
            Tipo: {reservation.roomType.name}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-[9px] font-semibold ${reservationStatusTones[reservation.status]}`}
        >
          {reservationStatusLabels[reservation.status]}
        </span>
      </div>
      <div
        className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 ${
          isToday ? 'border-amber-300 bg-amber-50' : 'border-teal/20 bg-teal-light/40'
        }`}
      >
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
            isToday ? 'bg-amber-500 text-white' : 'bg-white text-teal-deep'
          }`}
        >
          <CalendarDays className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[9px] font-extrabold uppercase tracking-[0.12em] text-slate-500">
            {highlightedLabel}
          </span>
          <strong className="block text-xs text-slate-950">
            {formatProminentDate(highlightedDate)}
          </strong>
        </span>
        {isToday ? (
          <span className="rounded-full bg-amber-500 px-2 py-1 text-[9px] font-extrabold text-white">
            HOY
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <p className="text-[10px] text-slate-500">
          {formatStayDateTime(reservation.checkIn)} → {formatStayDateTime(reservation.checkOut)}
          <br />
          Balance:{' '}
          <strong
            className={reservationBalance(reservation) ? 'text-rose-600' : 'text-emerald-700'}
          >
            {formatMoney(reservationBalance(reservation))}
          </strong>
        </p>
        {children}
      </div>
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

function startOfWeek(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return date;
}

function addDays(value: Date, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function parseLocalDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatSelectedDay(value: Date) {
  return new Intl.DateTimeFormat('es-DO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(value);
}

function formatShortSelectedDay(value: Date) {
  return new Intl.DateTimeFormat('es-DO', {
    day: 'numeric',
    month: 'short',
  })
    .format(value)
    .replace('.', '');
}

function formatProminentDate(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatWeekRange(start: Date, end: Date) {
  const startMonth = new Intl.DateTimeFormat('es-DO', { month: 'short' })
    .format(start)
    .replace('.', '');
  const endMonth = new Intl.DateTimeFormat('es-DO', { month: 'long' }).format(end);
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${start.getDate()}–${end.getDate()} de ${endMonth} de ${end.getFullYear()}`;
  }
  return `${start.getDate()} ${startMonth} – ${end.getDate()} ${endMonth} de ${end.getFullYear()}`;
}

function PanelMessage({ text }: { text: string }) {
  return (
    <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">{text}</div>
  );
}

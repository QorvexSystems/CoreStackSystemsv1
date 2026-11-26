'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BedDouble, CalendarDays, MessageCircle, Users } from 'lucide-react';
import { roomContentFor } from '@/lib/content';
import { addDays, addMonths, daysBetween, monthStart } from '@/lib/dates';
import type {
  ApiError,
  AvailabilityCalendar,
  HotelCatalog,
  ReservationConfirmation,
  StayAvailability,
} from '@/lib/types';
import { CheckoutDialog, type CardSummary, type GuestDetails } from './checkout-dialog';
import { DateRangePicker } from './date-range-picker';
import { RoomCard } from './room-card';
import { RoomDetailDialog } from './room-detail-dialog';
import { SummaryCard } from './summary-card';

type Props = { catalog: HotelCatalog | null; unavailableReason: string | null };

export function BookingExperience({ catalog, unavailableReason }: Props) {
  if (!catalog) return <BookingUnavailable reason={unavailableReason} />;
  return <Booking catalog={catalog} unavailableReason={unavailableReason} />;
}

const emptyGuest: GuestDetails = { firstName: '', lastName: '', documentType: 'CEDULA', documentNumber: '', phone: '', notes: '' };

function Booking({ catalog, unavailableReason }: { catalog: HotelCatalog; unavailableReason: string | null }) {
  const { today, roomTypes } = catalog;
  const lastBookable = addDays(today, catalog.bookingWindowDays);
  const maxAdults = Math.max(1, ...roomTypes.map((room) => room.capacityAdults));
  const maxChildren = Math.max(0, ...roomTypes.map((room) => room.capacityChildren));
  const contents = useMemo(
    () => new Map(roomTypes.map((room) => [room.id, roomContentFor(room.name)])),
    [roomTypes],
  );

  const [checkIn, setCheckIn] = useState(addDays(today, 1));
  const [checkOut, setCheckOut] = useState(addDays(today, 3));
  const [adults, setAdults] = useState(Math.min(2, maxAdults));
  const [children, setChildren] = useState(0);
  const [roomTypeId, setRoomTypeId] = useState('');
  const [guest, setGuest] = useState<GuestDetails>(emptyGuest);

  const [stay, setStay] = useState<StayAvailability | null>(null);
  const [stayLoading, setStayLoading] = useState(false);
  const [stayError, setStayError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [calendar, setCalendar] = useState<Record<string, Record<string, number>>>({});
  const loadedMonths = useRef(new Set<string>());

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [detailRoomId, setDetailRoomId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ReservationConfirmation | null>(null);
  const reference = useRef<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // ---- Calendario de disponibilidad (por noche y tipo), cargado por bloques de dos meses ----
  const loadMonths = useCallback(
    async (first: string) => {
      const months = [first, addMonths(first, 1)];
      if (months.every((month) => loadedMonths.current.has(month))) return;
      months.forEach((month) => loadedMonths.current.add(month));
      const from = first < today ? today : first;
      const days = Math.max(1, daysBetween(from, addMonths(first, 2)));
      try {
        const response = await fetch(`/api/calendar?from=${from}&days=${Math.min(days, 186)}`);
        if (!response.ok) throw new Error();
        const data = (await response.json()) as AvailabilityCalendar;
        setCalendar((current) => {
          const next = { ...current };
          for (const row of data.roomTypes) {
            const nights = { ...(next[row.roomTypeId] ?? {}) };
            row.available.forEach((count, index) => (nights[addDays(data.from, index)] = count));
            next[row.roomTypeId] = nights;
          }
          return next;
        });
      } catch {
        months.forEach((month) => loadedMonths.current.delete(month));
      }
    },
    [today],
  );

  const resetCalendar = useCallback(() => {
    loadedMonths.current.clear();
    setCalendar({});
    void loadMonths(monthStart(checkIn || today));
  }, [checkIn, loadMonths, today]);

  useEffect(() => {
    void loadMonths(monthStart(today));
  }, [loadMonths, today]);

  const nightAvailability = useCallback(
    (date: string) => {
      const candidates = roomTypeId
        ? roomTypes.filter((room) => room.id === roomTypeId)
        : roomTypes.filter((room) => adults <= room.capacityAdults && children <= room.capacityChildren);
      if (!candidates.length) return 0;
      let best: number | undefined;
      for (const room of candidates) {
        const value = calendar[room.id]?.[date];
        if (value !== undefined) best = Math.max(best ?? 0, value);
      }
      return best;
    },
    [adults, calendar, children, roomTypeId, roomTypes],
  );

  // ---- Disponibilidad y precio de la estadía elegida ----
  useEffect(() => {
    if (!checkIn || !checkOut) {
      setStay(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStayLoading(true);
      setStayError(null);
      try {
        const query = new URLSearchParams({ checkIn, checkOut, adults: String(adults), children: String(children) });
        const response = await fetch(`/api/availability?${query}`, { signal: controller.signal });
        const data = (await response.json()) as StayAvailability | ApiError;
        if (!response.ok) throw new Error((data as ApiError).message);
        setStay(data as StayAvailability);
      } catch (error) {
        if (controller.signal.aborted) return;
        setStay(null);
        setStayError(error instanceof Error && error.message ? error.message : 'No pudimos consultar la disponibilidad.');
      } finally {
        if (!controller.signal.aborted) setStayLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [adults, checkIn, checkOut, children, refreshKey]);

  const selectedRoom = roomTypes.find((room) => room.id === roomTypeId) ?? null;
  const detailRoom = roomTypes.find((room) => room.id === detailRoomId) ?? null;
  const selectedStay = stay?.roomTypes.find((row) => row.roomTypeId === roomTypeId);
  const stayMatches = Boolean(stay && stay.checkIn === checkIn && stay.checkOut === checkOut);
  const quote = stayMatches && selectedStay ? selectedStay.quote : null;

  const blockedReason = (() => {
    if (!catalog.bookingEnabled) return unavailableReason ?? 'Las reservas en línea están pausadas.';
    if (!checkIn || !checkOut) return 'Selecciona tus fechas de llegada y salida.';
    if (!selectedRoom) return 'Selecciona una habitación para continuar.';
    if (stayLoading || !stayMatches) return 'Verificando disponibilidad…';
    if (stayError) return stayError;
    if (selectedStay && !selectedStay.fitsGuests) return `${selectedRoom.name} no admite esa cantidad de huéspedes.`;
    if (selectedStay && selectedStay.available === 0) return `${selectedRoom.name} no está disponible en esas fechas.`;
    return null;
  })();

  const guestsLabel = [
    `${adults} ${adults === 1 ? 'adulto' : 'adultos'}`,
    children ? `${children} ${children === 1 ? 'niño' : 'niños'}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  // La referencia de idempotencia se conserva mientras se reintenta la MISMA reserva.
  const requestKey = JSON.stringify([roomTypeId, checkIn, checkOut, adults, children, guest]);
  useEffect(() => {
    reference.current = null;
  }, [requestKey]);

  /** Último paso de la pasarela: la reserva llega al ERP ya pagada. */
  const payAndBook = async (card: CardSummary): Promise<string | null> => {
    reference.current ??= crypto.randomUUID().replace(/-/g, '');
    try {
      const response = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reference: reference.current,
          roomTypeId,
          checkIn,
          checkOut,
          adults,
          children,
          ...guest,
          notes: guest.notes || undefined,
          paymentMethod: 'CARD',
          cardLast4: card.last4,
          cardBrand: card.brand,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as ReservationConfirmation & ApiError;
      if (!response.ok) {
        if (response.status === 409) {
          setRefreshKey((value) => value + 1);
          resetCalendar();
          setCheckoutOpen(false);
          setSubmitError(data.message || 'Esa habitación se acaba de agotar para tus fechas.');
          return data.message || 'Esa habitación se acaba de agotar.';
        }
        return data.message || 'No pudimos completar tu reserva. Intenta de nuevo.';
      }
      setConfirmation(data);
      setCheckoutOpen(false);
      setSubmitError(null);
      requestAnimationFrame(() => summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return null;
    } catch {
      return 'Se perdió la conexión. Intenta de nuevo; no se duplicará tu reserva.';
    }
  };

  const resetAll = () => {
    setConfirmation(null);
    setRoomTypeId('');
    setGuest(emptyGuest);
    setRefreshKey((value) => value + 1);
    resetCalendar();
  };

  const scopeLabel = selectedRoom
    ? `Disponibilidad de ${selectedRoom.name}`
    : 'Disponibilidad de cualquier habitación';
  const locked = Boolean(confirmation);

  return (
    <section id="reservar" className="mx-auto max-w-7xl px-4 pb-10 sm:px-6">
      {/* ---- Barra de búsqueda (estilo aerolínea): fechas, huéspedes y tipo ---- */}
      <div className="card relative z-20 -mt-10 p-4 sm:p-5">
        <fieldset disabled={locked} className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,1.2fr)] lg:items-end">
          <legend className="sr-only">Busca disponibilidad</legend>
          <DateRangePicker
            today={today}
            lastBookable={lastBookable}
            maxNights={catalog.maxStayNights}
            checkIn={checkIn}
            checkOut={checkOut}
            onChange={(nextIn, nextOut) => {
              setCheckIn(nextIn);
              setCheckOut(nextOut);
              setSubmitError(null);
            }}
            nightAvailability={nightAvailability}
            onMonthsVisible={loadMonths}
            scopeLabel={scopeLabel}
          />
          <div className="grid grid-cols-2 gap-3 lg:contents">
            <label>
              <span className="field-label">Adultos</span>
              <span className="field">
                <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <select value={adults} onChange={(event) => setAdults(Number(event.target.value))}>
                  {Array.from({ length: maxAdults }, (_, i) => i + 1).map((value) => (
                    <option key={value} value={value}>
                      {value} {value === 1 ? 'adulto' : 'adultos'}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label>
              <span className="field-label">Niños</span>
              <span className="field">
                <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <select value={children} onChange={(event) => setChildren(Number(event.target.value))} disabled={maxChildren === 0}>
                  {Array.from({ length: maxChildren + 1 }, (_, i) => i).map((value) => (
                    <option key={value} value={value}>
                      {value} {value === 1 ? 'niño' : 'niños'}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          </div>
          <label className="block">
            <span className="field-label">Tipo de habitación</span>
            <span className="field">
              <BedDouble className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <select value={roomTypeId} onChange={(event) => setRoomTypeId(event.target.value)}>
                <option value="">Todas las habitaciones</option>
                {roomTypes.map((room) => {
                  const row = stay?.roomTypes.find((item) => item.roomTypeId === room.id);
                  return (
                    <option key={room.id} value={room.id} disabled={row ? !row.bookable : !room.sellable}>
                      {room.name}
                      {row && !row.bookable ? ' — no disponible' : ''}
                    </option>
                  );
                })}
              </select>
            </span>
          </label>
        </fieldset>
      </div>

      {!catalog.bookingEnabled && (
        <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {unavailableReason} Puedes escribirnos por WhatsApp para reservar.
        </p>
      )}
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        {/* ---- Habitaciones ---- */}
        <div id="habitaciones" className="space-y-4">
          <header className="flex gap-3">
            <BedDouble className="mt-1 h-6 w-6 shrink-0 text-sea" aria-hidden />
            <div>
              <h2 className="font-serif text-xl font-semibold">Nuestras habitaciones</h2>
              <p className="text-[13px] text-muted">Selecciona la habitación que mejor se adapte a tu estadía.</p>
            </div>
          </header>
          {stayError && (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {stayError}
            </p>
          )}
          {roomTypes.length === 0 && (
            <p className="card p-6 text-center text-sm text-muted">Pronto publicaremos nuestras habitaciones.</p>
          )}
          {roomTypes.map((room) => (
            <RoomCard
              key={room.id}
              room={room}
              content={contents.get(room.id)!}
              onOpen={() => setDetailRoomId(room.id)}
              stay={stayMatches ? stay?.roomTypes.find((row) => row.roomTypeId === room.id) : undefined}
              loading={Boolean(checkIn && checkOut) && (stayLoading || !stayMatches) && !stayError}
              selected={room.id === roomTypeId}
              disabled={locked || !catalog.bookingEnabled}
              onSelect={() => {
                setRoomTypeId(room.id === roomTypeId ? '' : room.id);
                setSubmitError(null);
              }}
            />
          ))}
        </div>

        {/* ---- Resumen ---- */}
        <div ref={summaryRef}>
          <SummaryCard
            room={selectedRoom}
            image={selectedRoom ? contents.get(selectedRoom.id)!.photos[0]?.src ?? null : null}
            checkIn={checkIn}
            checkOut={checkOut}
            guestsLabel={guestsLabel}
            quote={quote}
            canSubmit={!blockedReason}
            blockedReason={blockedReason}
            error={submitError}
            confirmation={confirmation}
            onCheckout={() => {
              setSubmitError(null);
              setCheckoutOpen(true);
            }}
            onReset={resetAll}
          />
        </div>
      </div>

      {detailRoom && (
        <RoomDetailDialog
          room={detailRoom}
          content={contents.get(detailRoom.id)!}
          stay={stayMatches ? stay?.roomTypes.find((row) => row.roomTypeId === detailRoom.id) : undefined}
          selected={detailRoom.id === roomTypeId}
          canSelect={
            !locked &&
            catalog.bookingEnabled &&
            (stayMatches
              ? Boolean(stay?.roomTypes.find((row) => row.roomTypeId === detailRoom.id)?.bookable)
              : detailRoom.sellable)
          }
          onSelect={() => {
            setRoomTypeId(detailRoom.id);
            setSubmitError(null);
          }}
          onClose={() => setDetailRoomId(null)}
        />
      )}

      {selectedRoom && quote && (
        <CheckoutDialog
          open={checkoutOpen}
          onClose={() => setCheckoutOpen(false)}
          room={selectedRoom}
          checkIn={checkIn}
          checkOut={checkOut}
          guestsLabel={guestsLabel}
          quote={quote}
          guest={guest}
          onGuestChange={setGuest}
          onPay={payAndBook}
        />
      )}
    </section>
  );
}

function BookingUnavailable({ reason }: { reason: string | null }) {
  return (
    <section id="reservar" className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
      <div className="card p-8">
        <CalendarDays className="mx-auto h-10 w-10 text-sea" aria-hidden />
        <h2 className="mt-4 font-serif text-2xl font-semibold">Reservas en línea no disponibles</h2>
        <p className="mt-2 text-muted">
          {reason ?? 'Estamos teniendo problemas para consultar la disponibilidad.'} Intenta de nuevo en unos
          minutos o contáctanos directamente.
        </p>
        <a href="#contacto" className="btn-outline mt-6">
          <MessageCircle className="h-4 w-4" aria-hidden /> Ver datos de contacto
        </a>
      </div>
    </section>
  );
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Crown,
  IdCard,
  MessageCircle,
  Pencil,
  Phone,
  ReceiptText,
  Search,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  getHotelGuests,
  getHotelReservations,
  updateHotelGuest,
  type HotelGuest,
  type HotelReservation,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { isAdminSession, isReceptionSession } from '@/lib/authorization';
import { cn } from '@/lib/utils';
import { formatMoney, formatStayDateTime, reservationStatusLabels, reservationStatusTones } from './hotel-flow';
import { PaymentReceiptDialog } from './payment-receipt-dialog';
import { whatsappUrl } from './whatsapp';

type Filter = 'ALL' | 'INCOMPLETE' | 'FREQUENT';

/** Directorio de huéspedes: buscar, ver la ficha con su historial y completar los datos que falten. */
export function GuestsView() {
  const session = getSession();
  const canEdit = isAdminSession(session) || isReceptionSession(session);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const guestsQuery = useQuery({
    queryKey: ['hotel', 'guests', session?.tenantId],
    queryFn: () => getHotelGuests(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const guests = useMemo(() => guestsQuery.data ?? [], [guestsQuery.data]);
  const incompleteCount = guests.filter(isIncomplete).length;
  const frequentCount = guests.filter((guest) => validStays(guest) >= 2).length;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('es');
    const digits = normalized.replace(/\D/g, '');
    return guests.filter((guest) => {
      if (filter === 'INCOMPLETE' && !isIncomplete(guest)) return false;
      if (filter === 'FREQUENT' && validStays(guest) < 2) return false;
      if (!normalized) return true;
      const text = [guest.firstName, guest.lastName, guest.phone, guest.documentNumber, ...(guest.reservations ?? []).map((r) => r.code)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('es');
      if (text.includes(normalized)) return true;
      return digits.length >= 4 && [guest.phone, guest.documentNumber].some((value) => (value ?? '').replace(/\D/g, '').includes(digits));
    });
  }, [filter, guests, query]);
  const selected = guests.find((guest) => guest.id === selectedId) ?? null;
  const editing = guests.find((guest) => guest.id === editingId) ?? null;

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard icon={Users} label="Huéspedes registrados" value={guests.length} active={filter === 'ALL'} onClick={() => setFilter('ALL')} />
        <StatCard
          icon={AlertTriangle}
          label="Sin teléfono o documento"
          value={incompleteCount}
          tone="amber"
          active={filter === 'INCOMPLETE'}
          onClick={() => setFilter(filter === 'INCOMPLETE' ? 'ALL' : 'INCOMPLETE')}
        />
        <StatCard
          icon={Crown}
          label="Frecuentes y VIP"
          value={frequentCount}
          active={filter === 'FREQUENT'}
          onClick={() => setFilter(filter === 'FREQUENT' ? 'ALL' : 'FREQUENT')}
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div>
            <h2 className="text-base font-extrabold">Directorio de huéspedes</h2>
            <p className="text-sm text-slate-500">
              {filter === 'INCOMPLETE'
                ? 'Huéspedes a los que les falta el teléfono o el documento.'
                : filter === 'FREQUENT'
                  ? 'Huéspedes con 2 o más estadías.'
                  : 'Toca un huésped para ver su ficha e historial.'}
            </p>
          </div>
          <label className="relative block w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-12 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-10 text-sm outline-none focus:border-teal"
              placeholder="Nombre, teléfono, cédula o reserva…"
            />
            {query ? (
              <button
                type="button"
                aria-label="Limpiar búsqueda"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </label>
        </div>

        <ul className="divide-y divide-slate-100">
          {filtered.map((guest) => (
            <GuestRow
              key={guest.id}
              guest={guest}
              canEdit={canEdit}
              onOpen={() => setSelectedId(guest.id)}
              onEdit={() => setEditingId(guest.id)}
            />
          ))}
        </ul>
        {guestsQuery.isLoading ? <Message text="Cargando huéspedes…" /> : null}
        {guestsQuery.error ? <Message text={(guestsQuery.error as Error).message} error /> : null}
        {!guestsQuery.isLoading && !guestsQuery.error && !filtered.length ? (
          <Message text="No hay huéspedes con esos criterios." />
        ) : null}
      </section>

      <GuestProfileDialog
        guest={selected}
        canEdit={canEdit}
        onClose={() => setSelectedId(null)}
        onEdit={() => setEditingId(selected?.id ?? null)}
      />
      <GuestEditDialog guest={editing} onClose={() => setEditingId(null)} />
    </>
  );
}

function GuestRow({
  guest,
  canEdit,
  onOpen,
  onEdit,
}: {
  guest: HotelGuest;
  canEdit: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const stays = validStays(guest);
  const last = guest.reservations?.[0];
  return (
    <li className="flex items-center gap-3 px-4 py-3 transition hover:bg-teal-light/20">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar guest={guest} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[15px] font-extrabold capitalize text-slate-950">
              {fullName(guest)}
            </p>
            <SegmentBadge stays={stays} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <Phone className="h-3.5 w-3.5 text-slate-400" />
              {guest.phone ? formatPhone(guest.phone) : <Missing text="Sin teléfono" />}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <IdCard className="h-3.5 w-3.5 text-slate-400" />
              {guest.documentNumber ? documentText(guest) : <Missing text="Sin documento" />}
            </span>
          </div>
        </div>
        <div className="hidden shrink-0 text-right md:block">
          <p className="text-sm font-bold text-slate-900">
            {stays} {stays === 1 ? 'estadía' : 'estadías'}
          </p>
          <p className="text-xs text-slate-500">
            {last ? `Última: ${shortDate(last.checkIn)}` : 'Sin reservaciones'}
          </p>
        </div>
        <ChevronRight className="hidden h-5 w-5 shrink-0 text-slate-300 sm:block" />
      </button>
      {canEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-700 hover:border-teal hover:text-teal-deep"
        >
          <Pencil className="h-4 w-4" /> Editar
        </button>
      ) : null}
    </li>
  );
}

function GuestProfileDialog({
  guest,
  canEdit,
  onClose,
  onEdit,
}: {
  guest: HotelGuest | null;
  canEdit: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const session = getSession();
  const [invoiceReservation, setInvoiceReservation] = useState<HotelReservation | null>(null);
  // Las reservaciones completas (con pagos y datos fiscales del hotel) alimentan la factura del historial.
  const fullReservations = useQuery({
    queryKey: ['hotel', 'reservations', session?.tenantId],
    queryFn: () => getHotelReservations(session!.tenantId, session!.accessToken),
    enabled: Boolean(session && guest),
  });
  if (!guest) return null;
  const reservations = guest.reservations ?? [];
  const withPayments = new Map((fullReservations.data ?? []).map((reservation) => [reservation.id, reservation]));
  const stays = validStays(guest);
  const visits = reservations.filter((reservation) => ['CHECKED_IN', 'CHECKED_OUT'].includes(reservation.status)).length;
  const spent = reservations
    .filter((reservation) => !['CANCELLED', 'NO_SHOW'].includes(reservation.status))
    .reduce((sum, reservation) => sum + Number(reservation.paidAmount ?? 0), 0);
  const credits = guest.credits ?? [];
  const availableCredit = credits.reduce((sum, credit) => sum + Number(credit.remainingAmount), 0);
  const chat = whatsappUrl(guest.phone);

  return (
    <ActionDialog
      open
      title={fullName(guest)}
      eyebrow="Ficha del huésped"
      icon={<UserRound className="h-5 w-5" />}
      confirmLabel="Cerrar"
      hideCancel
      size="lg"
      onClose={onClose}
      onConfirm={onClose}
    >
      {/* Contacto */}
      <section className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Avatar guest={guest} large />
            <div>
              <SegmentBadge stays={stays} />
              {guest.nationality ? <p className="mt-1 text-xs text-slate-500">{guest.nationality}</p> : null}
            </div>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-teal bg-white px-4 text-sm font-bold text-teal-deep hover:bg-teal-light/40"
            >
              <Pencil className="h-4 w-4" /> Editar datos
            </button>
          ) : null}
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <ContactItem icon={Phone} label="Teléfono / WhatsApp" value={guest.phone ? formatPhone(guest.phone) : null}>
            {chat ? (
              <a
                href={chat}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700"
              >
                <MessageCircle className="h-4 w-4" /> WhatsApp
              </a>
            ) : null}
          </ContactItem>
          <ContactItem icon={IdCard} label="Documento" value={guest.documentNumber ? documentText(guest) : null} />
        </dl>
        {guest.notes ? (
          <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm text-slate-700">
            <span className="font-bold">Notas: </span>
            {guest.notes}
          </p>
        ) : null}
        {isIncomplete(guest) && canEdit ? (
          <p className="mt-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Faltan datos de contacto. Toca «Editar datos» para completarlos.
          </p>
        ) : null}
      </section>

      {/* Resumen */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Reservaciones" value={String(stays)} />
        <Metric label="Estadías realizadas" value={String(visits)} />
        <Metric label="Total pagado" value={formatMoney(spent)} />
      </div>

      {credits.length ? (
        <section className="rounded-xl border border-teal/30 bg-teal-light/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-teal-deep">Crédito a favor</h3>
            <span className="rounded-full bg-white px-2.5 py-1 text-xs font-extrabold text-teal-deep">
              {formatMoney(availableCredit)} disponible
            </span>
          </div>
          <ul className="mt-2 space-y-1.5 text-xs">
            {credits.map((credit) => (
              <li key={credit.id} className="flex items-start justify-between gap-3">
                <span className="text-slate-700">{credit.reason}</span>
                <span className="shrink-0 font-bold text-slate-900">
                  {Number(credit.remainingAmount) > 0
                    ? `${formatMoney(credit.remainingAmount)} de ${formatMoney(credit.amount)}`
                    : 'Usado'}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-500">
            Se aplica como pago desde &quot;Siguiente acción&quot; en su próxima reservación.
          </p>
        </section>
      ) : null}

      {/* Historial */}
      <section>
        <h3 className="flex items-center gap-2 text-sm font-extrabold">
          <CalendarDays className="h-4 w-4 text-teal" /> Historial de estadías
        </h3>
        <ol className="mt-3 space-y-2">
          {reservations.map((reservation) => {
            const full = withPayments.get(reservation.id);
            const payment = full?.payments?.[0];
            return (
              <li key={reservation.id}>
                <button
                  type="button"
                  onClick={() =>
                    full && payment
                      ? setInvoiceReservation(full)
                      : toast.info(
                          fullReservations.isLoading
                            ? 'Cargando facturas…'
                            : `${reservation.code} todavía no tiene factura: no se ha registrado ningún pago.`,
                        )
                  }
                  className="grid w-full gap-2 rounded-xl border border-slate-200 p-3 text-left transition hover:border-teal/50 hover:bg-teal-light/20 sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-extrabold">{reservation.code}</span>
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', reservationStatusTones[reservation.status])}>
                        {reservationStatusLabels[reservation.status] ?? reservation.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] font-semibold text-teal-deep">
                      {reservation.room ? `Habitación ${reservation.room.number}` : 'Sin habitación'} · {reservation.roomType.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {formatStayDateTime(reservation.checkIn)} → {formatStayDateTime(reservation.checkOut)} · {reservation.channel?.name || 'Interno'}
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <p className="text-sm font-extrabold">{formatMoney(reservation.totalAmount)}</p>
                    {payment ? (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                        <ReceiptText className="h-3 w-3" /> Factura {payment.receiptNumber}
                      </span>
                    ) : (
                      <span className="mt-1 block text-[11px] font-semibold text-slate-400">Sin factura</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
        {!reservations.length ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">
            Este huésped todavía no tiene reservaciones registradas.
          </p>
        ) : null}
      </section>
      <PaymentReceiptDialog
        reservation={invoiceReservation}
        open={Boolean(invoiceReservation)}
        autoPrint={false}
        onClose={() => setInvoiceReservation(null)}
      />
    </ActionDialog>
  );
}

const fieldClass =
  'mt-1.5 h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-base font-normal outline-none focus:border-teal';

function GuestEditDialog({ guest, onClose }: { guest: HotelGuest | null; onClose: () => void }) {
  const session = getSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => formFrom(guest));
  useEffect(() => setForm(formFrom(guest)), [guest]);
  const update = <K extends keyof ReturnType<typeof formFrom>>(key: K, value: ReturnType<typeof formFrom>[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const docDigits = form.documentNumber.replace(/\D/g, '');
  const docError =
    form.documentNumber.trim() &&
    (form.documentType === 'CEDULA'
      ? docDigits.length !== 11 && 'La cédula debe tener 11 dígitos.'
      : form.documentNumber.replace(/[^\dA-Za-z]/g, '').length < 5 && 'El pasaporte debe tener al menos 5 caracteres.');
  const phoneDigits = form.phone.replace(/\D/g, '');
  const phoneError = form.phone.trim() && phoneDigits.length < 10 && 'Escribe el teléfono completo (10 dígitos).';
  const valid = form.firstName.trim() && form.lastName.trim() && !docError && !phoneError;

  const mutation = useMutation({
    mutationFn: () =>
      updateHotelGuest(session!.tenantId, session!.accessToken, guest!.id, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        documentType: form.documentType,
        documentNumber: form.documentNumber.trim(),
        nationality: form.nationality.trim(),
        notes: form.notes.trim(),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hotel', 'guests'] }),
        queryClient.invalidateQueries({ queryKey: ['hotel', 'reservations'] }),
      ]);
      toast.success('Datos del huésped actualizados');
      onClose();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  if (!guest) return null;

  return (
    <ActionDialog
      open
      title={`Editar · ${fullName(guest)}`}
      eyebrow="Datos del huésped"
      icon={<Pencil className="h-5 w-5" />}
      confirmLabel="Guardar cambios"
      isPending={mutation.isPending}
      confirmDisabled={!valid}
      onClose={onClose}
      onConfirm={() => mutation.mutate()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-semibold text-slate-700">
          Nombre *
          <input className={fieldClass} value={form.firstName} maxLength={80} onChange={(e) => update('firstName', e.target.value)} />
        </label>
        <label className="block text-sm font-semibold text-slate-700">
          Apellido *
          <input className={fieldClass} value={form.lastName} maxLength={80} onChange={(e) => update('lastName', e.target.value)} />
        </label>
        <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">
          Teléfono / WhatsApp
          <input
            className={fieldClass}
            type="tel"
            inputMode="tel"
            value={form.phone}
            maxLength={20}
            placeholder="829-000-0000"
            onChange={(e) => update('phone', e.target.value)}
          />
          {phoneError ? <span className="mt-1 block text-xs text-rose-600">{phoneError}</span> : null}
        </label>
        <div className="sm:col-span-2">
          <span className="text-sm font-semibold text-slate-700">Documento</span>
          <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-2">
            <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1">
              {(['CEDULA', 'PASSPORT'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => update('documentType', type)}
                  className={cn(
                    'h-10 rounded-lg px-3 text-sm font-semibold',
                    form.documentType === type ? 'bg-white text-teal-deep shadow-sm' : 'text-slate-500',
                  )}
                >
                  {type === 'CEDULA' ? 'Cédula' : 'Pasaporte'}
                </button>
              ))}
            </div>
            <input
              className={cn(fieldClass, 'mt-0')}
              value={form.documentNumber}
              maxLength={20}
              inputMode={form.documentType === 'CEDULA' ? 'numeric' : 'text'}
              placeholder={form.documentType === 'CEDULA' ? '001-1234567-8' : 'Ej. AB1234567'}
              onChange={(e) => update('documentNumber', e.target.value)}
            />
          </div>
          {docError ? <span className="mt-1 block text-xs text-rose-600">{docError}</span> : null}
        </div>
        <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">
          Nacionalidad <span className="font-normal text-slate-400">(opcional)</span>
          <input className={fieldClass} value={form.nationality} maxLength={60} placeholder="Dominicana" onChange={(e) => update('nationality', e.target.value)} />
        </label>
        <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">
          Notas <span className="font-normal text-slate-400">(opcional)</span>
          <textarea
            className={cn(fieldClass, 'h-20 py-2')}
            value={form.notes}
            maxLength={500}
            placeholder="Preferencias, alergias, observaciones…"
            onChange={(e) => update('notes', e.target.value)}
          />
        </label>
      </div>
    </ActionDialog>
  );
}

function formFrom(guest: HotelGuest | null) {
  return {
    firstName: guest?.firstName ?? '',
    lastName: guest?.lastName ?? '',
    phone: guest?.phone ?? '',
    documentType: (guest?.documentType === 'PASSPORT' ? 'PASSPORT' : 'CEDULA') as 'CEDULA' | 'PASSPORT',
    documentNumber: guest?.documentNumber ?? '',
    nationality: guest?.nationality ?? '',
    notes: guest?.notes ?? '',
  };
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'teal',
  active,
  onClick,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  tone?: 'teal' | 'amber';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-between rounded-xl border bg-white p-4 text-left shadow-sm transition',
        active ? (tone === 'amber' ? 'border-amber-400 ring-2 ring-amber-100' : 'border-teal ring-2 ring-teal-light') : 'border-slate-200 hover:border-slate-300',
      )}
    >
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="mt-1 text-2xl font-extrabold text-slate-950">{value}</p>
      </div>
      <span
        className={cn(
          'grid h-11 w-11 place-items-center rounded-xl',
          tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-teal-light text-teal-deep',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
    </button>
  );
}

function Avatar({ guest, large = false }: { guest: HotelGuest; large?: boolean }) {
  const initials = `${guest.firstName.charAt(0)}${guest.lastName.charAt(0)}`.toUpperCase();
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-teal-light font-extrabold text-teal-deep',
        large ? 'h-14 w-14 text-lg' : 'h-11 w-11 text-sm',
      )}
    >
      {initials}
    </span>
  );
}

function SegmentBadge({ stays }: { stays: number }) {
  const segment = stays >= 3 ? 'VIP' : stays >= 2 ? 'Frecuente' : 'Nuevo';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold',
        segment === 'VIP'
          ? 'bg-amber-100 text-amber-800'
          : segment === 'Frecuente'
            ? 'bg-teal-light text-teal-deep'
            : 'bg-slate-100 text-slate-600',
      )}
    >
      {segment === 'VIP' ? <Crown className="h-3 w-3" /> : null}
      {segment}
    </span>
  );
}

function ContactItem({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: typeof Phone;
  label: string;
  value: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon className="h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className={cn('truncate text-sm font-bold', value ? 'text-slate-900' : 'text-amber-700')}>
            {value ?? 'No registrado'}
          </dd>
        </div>
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-extrabold text-slate-950">{value}</p>
    </div>
  );
}

function Missing({ text }: { text: string }) {
  return <span className="font-semibold text-amber-700">{text}</span>;
}

function Message({ text, error = false }: { text: string; error?: boolean }) {
  return <p className={cn('border-t p-8 text-center text-sm', error ? 'text-rose-600' : 'text-slate-500')}>{text}</p>;
}

function fullName(guest: HotelGuest) {
  return `${guest.firstName} ${guest.lastName}`.trim();
}

function validStays(guest: HotelGuest) {
  return (guest.reservations ?? []).filter((reservation) => !['CANCELLED', 'NO_SHOW'].includes(reservation.status)).length;
}

function isIncomplete(guest: HotelGuest) {
  return !guest.phone || !guest.documentNumber;
}

function documentText(guest: HotelGuest) {
  const number = guest.documentNumber ?? '';
  if (guest.documentType === 'PASSPORT') return `Pasaporte ${number}`;
  if (guest.documentType === 'CEDULA' && /^\d{11}$/.test(number))
    return `Cédula ${number.slice(0, 3)}-${number.slice(3, 10)}-${number.slice(10)}`;
  return number;
}

function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : phone;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Santo_Domingo' }).format(
    new Date(value),
  );
}

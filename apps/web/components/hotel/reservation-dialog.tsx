'use client';

import {
  CalendarDays,
  CalendarPlus,
  Check,
  Hotel,
  Search,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ActionDialog } from '@/components/ui/action-dialog';
import { FormPage } from '@/components/ui/form-page';
import type {
  CreateHotelReservationPayload,
  HotelChannel,
  HotelGuest,
  HotelReservation,
  HotelRoom,
  HotelRoomType,
  TaxIdentityLookup,
  UpdateHotelReservationPayload,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { hotelKey } from './reservations-calendar';
import { VISITOR_RATE } from './quick-reservation-form';
import { RoomPicker } from './room-picker';
import { formatTime, StayPicker } from './stay-picker';
import { TaxIdentityField, type TaxDocumentType } from './tax-identity-field';

type Props = {
  open: boolean;
  roomTypes: HotelRoomType[];
  rooms: HotelRoom[];
  reservations: HotelReservation[];
  channels: HotelChannel[];
  guests: HotelGuest[];
  isPending: boolean;
  onClose: () => void;
  onSubmit: (payload: CreateHotelReservationPayload) => void;
  /** Reservación a editar (antes del check-in). Sin ella el diálogo crea una nueva. */
  editing?: HotelReservation | null;
  onUpdate?: (reservationId: string, payload: UpdateHotelReservationPayload) => void;
  /** 'page': pantalla completa (crear/editar en tablet) en vez de popup. */
  variant?: 'dialog' | 'page';
};

const steps = [
  { title: 'Huésped', icon: UserRound },
  { title: 'Estadía', icon: CalendarDays },
  { title: 'Habitación', icon: Hotel },
  { title: 'Confirmar', icon: Check },
];

function dateTimeInput(daysFromToday: number, hour: number) {
  const value = new Date();
  value.setDate(value.getDate() + daysFromToday);
  value.setHours(hour, 0, 0, 0);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function initialForm(roomTypes: HotelRoomType[], channels: HotelChannel[]) {
  const roomType = roomTypes[0];
  const defaultChannel =
    channels.find(
      (channel) =>
        channel.active && (channel.type === 'WALK_IN' || channel.name.toLowerCase() === 'interno'),
    ) ?? channels.find((channel) => channel.active);
  return {
    guestId: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    documentType: 'CEDULA' as TaxDocumentType,
    documentNumber: '',
    checkIn: dateTimeInput(0, 15),
    checkOut: dateTimeInput(1, 11),
    roomTypeId: roomType?.id ?? '',
    roomId: '',
    channelId: defaultChannel?.id ?? '',
    adults: '2',
    children: '0',
    totalAmount: roomType ? String(roomType.baseRate) : '',
    specialRequests: '',
  };
}

/** Fecha ISO → valor de `datetime-local` en la hora del navegador. */
function toLocalInput(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function formFromReservation(reservation: HotelReservation): ReturnType<typeof initialForm> {
  return {
    guestId: reservation.guest.id,
    firstName: reservation.guest.firstName,
    lastName: reservation.guest.lastName,
    email: reservation.guest.email ?? '',
    phone: reservation.guest.phone ?? '',
    documentType: (reservation.guest.documentType as TaxDocumentType | null) ?? 'CEDULA',
    documentNumber: reservation.guest.documentNumber ?? '',
    checkIn: toLocalInput(reservation.checkIn),
    checkOut: toLocalInput(reservation.checkOut),
    roomTypeId: reservation.roomType.id,
    roomId: reservation.room?.id ?? '',
    channelId: reservation.channel?.id ?? '',
    adults: String(reservation.adults),
    children: String(reservation.children),
    totalAmount: String(Number(reservation.totalAmount)),
    specialRequests: reservation.specialRequests ?? '',
  };
}

/** Nombre del padrón DGII (MAYÚSCULAS) → nombre y apellidos para la ficha del huésped. */
function splitRegistryName(result: TaxIdentityLookup) {
  const title = (value: string) =>
    value
      .toLocaleLowerCase('es')
      .replace(/(^|\s)(\p{L})/gu, (match) => match.toLocaleUpperCase('es'));
  const full = title(result.name ?? '');
  if (result.documentType === 'RNC') return { firstName: full, lastName: '' };
  const words = full.split(/\s+/).filter(Boolean);
  const given = words.length >= 4 ? 2 : 1;
  return { firstName: words.slice(0, given).join(' '), lastName: words.slice(given).join(' ') };
}

const fieldClass =
  'mt-1.5 h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal focus:ring-4 focus:ring-teal/10';

export function ReservationDialog({
  open,
  roomTypes,
  rooms,
  reservations,
  channels,
  guests,
  isPending,
  onClose,
  onSubmit,
  editing,
  onUpdate,
  variant = 'dialog',
}: Props) {
  const isEditing = Boolean(editing);
  const [step, setStep] = useState(0);
  const [guestMode, setGuestMode] = useState<'NEW' | 'REGISTERED'>('NEW');
  const [guestSearch, setGuestSearch] = useState('');
  const [form, setForm] = useState(() => initialForm(roomTypes, channels));

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setGuestMode('NEW');
    setGuestSearch('');
    setForm(editing ? formFromReservation(editing) : initialForm(roomTypes, channels));
    // Solo al abrir: no se reinicia si las listas se refrescan mientras se edita.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const today = hotelKey(new Date());
  const selectedRoomType = roomTypes.find((item) => item.id === form.roomTypeId);
  const selectedRoom = rooms.find((item) => item.id === form.roomId);
  const selectedGuest = guests.find((item) => item.id === form.guestId);
  const filteredGuests = useMemo(() => {
    const query = guestSearch.trim().toLocaleLowerCase('es');
    if (!query) return guests.slice(0, 8);
    return guests
      .filter((guest) =>
        [guest.firstName, guest.lastName, guest.email, guest.phone, guest.documentNumber]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase('es')
          .includes(query),
      )
      .slice(0, 8);
  }, [guestSearch, guests]);
  const stepValid = [
    Boolean(
      form.firstName.trim() &&
      (form.lastName.trim() || form.documentType === 'RNC') &&
      (isEditing || guestMode === 'NEW' || form.guestId),
    ),
    Boolean(
      form.checkIn &&
      form.checkOut &&
      new Date(form.checkOut) > new Date(form.checkIn) &&
      Number(form.adults) >= 1 &&
      Number(form.children) >= 0,
    ),
    Boolean(form.roomTypeId),
    Boolean(form.channelId && Number(form.totalAmount) > 0),
  ];

  const update = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const setStay = (checkIn: string, checkOut: string) => {
    setForm((current) => {
      const datesChanged = current.checkIn.slice(0, 10) !== checkIn.slice(0, 10) || current.checkOut.slice(0, 10) !== checkOut.slice(0, 10);
      const next = { ...current, checkIn, checkOut, roomId: datesChanged ? '' : current.roomId };
      const nights = Math.max(1, nightsBetweenDates(next.checkIn, next.checkOut));
      const roomType = roomTypes.find((item) => item.id === next.roomTypeId);
      return {
        ...next,
        totalAmount: roomType ? String(Number(roomType.baseRate) * nights) : next.totalAmount,
      };
    });
  };

  const documentPayload = form.documentNumber.trim()
    ? { documentType: form.documentType, documentNumber: form.documentNumber.trim() }
    : {};

  const submit = () => {
    if (editing) {
      onUpdate?.(editing.id, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim(),
        ...documentPayload,
        checkIn: new Date(form.checkIn).toISOString(),
        checkOut: new Date(form.checkOut).toISOString(),
        roomTypeId: form.roomTypeId,
        roomId: form.roomId,
        channelId: form.channelId || undefined,
        adults: Number(form.adults),
        children: Number(form.children),
        totalAmount: Number(form.totalAmount),
        specialRequests: form.specialRequests.trim(),
      });
      return;
    }
    onSubmit({
      ...documentPayload,
      guestId: form.guestId || undefined,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      checkIn: new Date(form.checkIn).toISOString(),
      checkOut: new Date(form.checkOut).toISOString(),
      roomTypeId: form.roomTypeId,
      roomId: form.roomId || undefined,
      channelId: form.channelId,
      adults: Number(form.adults),
      children: Number(form.children),
      totalAmount: Number(form.totalAmount),
      specialRequests: form.specialRequests.trim() || undefined,
    });
  };

  const onRegistryName = (result: TaxIdentityLookup) =>
    setForm((current) => ({ ...current, ...splitRegistryName(result) }));

  const frame = {
    title: editing ? `Editar reservación ${editing.code}` : 'Nueva reservación',
    description: stepDescription(step),
    eyebrow: `Paso ${step + 1} de ${steps.length}`,
    confirmLabel:
      step === steps.length - 1 ? (editing ? 'Guardar cambios' : 'Crear reservación') : 'Continuar',
    cancelLabel: step === 0 ? 'Cancelar' : 'Anterior',
    onCancel: () => (step === 0 ? onClose() : setStep((current) => current - 1)),
    onConfirm: () => (step === steps.length - 1 ? submit() : setStep((current) => current + 1)),
  };
  const body = (
    <>
      <StepIndicator current={step} />

      {step === 0 ? (
        <div className="space-y-4">
          {isEditing ? null : (
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1.5">
            <GuestModeButton
              active={guestMode === 'NEW'}
              icon={UserPlus}
              label="Cliente nuevo"
              onClick={() => {
                setGuestMode('NEW');
                setGuestSearch('');
                setForm((current) => clearGuest(current));
              }}
            />
            <GuestModeButton
              active={guestMode === 'REGISTERED'}
              icon={Users}
              label="Cliente registrado"
              onClick={() => {
                setGuestMode('REGISTERED');
                setForm((current) => clearGuest(current));
              }}
            />
          </div>
          )}

          {guestMode === 'NEW' || isEditing ? (
            <>
              <div className="rounded-xl border border-teal/20 bg-teal-light/40 px-4 py-3 text-sm text-teal-deep">
                {isEditing
                  ? 'Los cambios también actualizan la ficha del huésped.'
                  : 'Escribe la cédula o el RNC y completamos el nombre desde el padrón de la DGII.'}
              </div>
              <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                <TaxIdentityField
                  documentType={form.documentType}
                  documentNumber={form.documentNumber}
                  onChange={(value) => setForm((current) => ({ ...current, ...value }))}
                  onNameFound={onRegistryName}
                />
                <Field label="Nombre *">
                  <input
                    data-dialog-autofocus
                    className={fieldClass}
                    value={form.firstName}
                    onChange={(event) => update('firstName', event.target.value)}
                  />
                </Field>
                <Field label={form.documentType === 'RNC' ? 'Apellido' : 'Apellido *'}>
                  <input
                    className={fieldClass}
                    value={form.lastName}
                    onChange={(event) => update('lastName', event.target.value)}
                  />
                </Field>
                <Field label="Teléfono / WhatsApp">
                  <input
                    type="tel"
                    className={fieldClass}
                    value={form.phone}
                    onChange={(event) => update('phone', event.target.value)}
                  />
                </Field>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <label className="relative block">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  data-dialog-autofocus
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/10"
                  value={guestSearch}
                  onChange={(event) => setGuestSearch(event.target.value)}
                  placeholder="Buscar por nombre, teléfono o cédula..."
                />
              </label>
              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {filteredGuests.map((guest) => (
                  <button
                    type="button"
                    key={guest.id}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        guestId: guest.id,
                        firstName: guest.firstName,
                        lastName: guest.lastName,
                        email: guest.email ?? '',
                        phone: guest.phone ?? '',
                      }))
                    }
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition',
                      form.guestId === guest.id
                        ? 'border-teal bg-teal-light/60 ring-1 ring-teal/20'
                        : 'border-slate-200 bg-white hover:border-teal/40',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-slate-900">
                        {guest.firstName} {guest.lastName}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {guest.phone || guest.documentNumber || 'Sin información de contacto'}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[10px] font-semibold text-slate-500">
                      {guest._count?.reservations ?? 0}{' '}
                      {(guest._count?.reservations ?? 0) === 1 ? 'reserva' : 'reservas'}
                      {creditOf(guest) > 0 ? (
                        <span className="mt-0.5 block rounded-full bg-teal-light px-2 py-0.5 font-bold text-teal-deep">
                          Crédito RD${creditOf(guest).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
                {!filteredGuests.length ? (
                  <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center text-sm text-slate-500">
                    No encontramos clientes con esa búsqueda.
                  </div>
                ) : null}
              </div>
              {selectedGuest ? (
                <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                  Cliente seleccionado: {selectedGuest.firstName} {selectedGuest.lastName}
                  {creditOf(selectedGuest) > 0
                    ? ` · Tiene crédito a favor de RD$${creditOf(selectedGuest).toLocaleString('en-US', { minimumFractionDigits: 2 })}: podrás aplicarlo al cobrar.`
                    : ''}
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {step === 1 ? (
        <StayPicker
          checkIn={form.checkIn}
          checkOut={form.checkOut}
          adults={Number(form.adults)}
          childrenCount={Number(form.children)}
          today={today}
          allowPastDay={editing ? hotelKey(editing.checkIn) : undefined}
          onStayChange={setStay}
          onGuestsChange={(adults, children) =>
            setForm((current) => ({ ...current, adults: String(adults), children: String(children) }))
          }
        />
      ) : null}

      {step === 2 ? (
        <RoomPicker
          firstNight={form.checkIn.slice(0, 10)}
          endDay={form.checkOut.slice(0, 10)}
          today={today}
          roomTypes={roomTypes}
          rooms={rooms}
          reservations={reservations}
          editingId={editing?.id}
          roomTypeId={form.roomTypeId}
          roomId={form.roomId}
          adults={Number(form.adults)}
          onTypeChange={(typeId) => {
            const roomType = roomTypes.find((item) => item.id === typeId);
            const nights = Math.max(1, nightsBetweenDates(form.checkIn, form.checkOut));
            setForm((current) => ({
              ...current,
              roomTypeId: typeId,
              roomId: current.roomTypeId === typeId ? current.roomId : '',
              totalAmount: roomType ? String(Number(roomType.baseRate) * nights) : current.totalAmount,
            }));
          }}
          onRoomChange={(roomId) => update('roomId', roomId)}
        />
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-base sm:grid-cols-2 xl:grid-cols-4">
            <Summary label="Huésped" value={`${form.firstName} ${form.lastName}`} />
            <Summary
              label="Estadía"
              value={`${formatDateTimeInput(form.checkIn)} → ${formatDateTimeInput(form.checkOut)} · ${nightsBetweenDates(form.checkIn, form.checkOut)} noches`}
            />
            <Summary label="Tipo" value={selectedRoomType?.name ?? '—'} />
            <Summary
              label="Habitación"
              value={selectedRoom ? `Hab. ${selectedRoom.number}` : 'Asignar después'}
            />
          </div>
          <RateShortcuts
            nights={Math.max(1, nightsBetweenDates(form.checkIn, form.checkOut))}
            roomType={selectedRoomType}
            single={roomTypes.find((type) => /sencill/i.test(type.name))}
            total={Number(form.totalAmount)}
            onTotal={(value) => update('totalAmount', String(value))}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Canal de reservación *">
              <select
                data-dialog-autofocus
                className={fieldClass}
                value={form.channelId}
                onChange={(event) => update('channelId', event.target.value)}
              >
                <option value="">Seleccionar canal</option>
                {channels
                  .filter((channel) => channel.active)
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Monto total (RD$) *">
              <input
                type="number"
                min="1"
                step="0.01"
                className={fieldClass}
                value={form.totalAmount}
                onChange={(event) => update('totalAmount', event.target.value)}
              />
            </Field>
          </div>
          <Field label="Solicitudes especiales">
            <textarea
              className="mt-1.5 min-h-28 w-full rounded-xl border border-slate-300 p-4 text-base outline-none focus:border-teal"
              value={form.specialRequests}
              onChange={(event) => update('specialRequests', event.target.value)}
            />
          </Field>
        </div>
      ) : null}
    </>
  );

  if (variant === 'page') {
    if (!open) return null;
    return (
      <FormPage
        eyebrow={frame.eyebrow}
        title={frame.title}
        description={frame.description}
        icon={<CalendarPlus className="h-5 w-5" />}
        onBack={onClose}
        confirmLabel={frame.confirmLabel}
        cancelLabel={frame.cancelLabel}
        confirmDisabled={!stepValid[step]}
        isPending={isPending}
        onCancel={frame.onCancel}
        onConfirm={frame.onConfirm}
      >
        <div className="space-y-8">{body}</div>
      </FormPage>
    );
  }

  return (
    <ActionDialog
      open={open}
      title={frame.title}
      description={frame.description}
      eyebrow={frame.eyebrow}
      icon={<CalendarPlus className="h-5 w-5" />}
      confirmLabel={frame.confirmLabel}
      cancelLabel={frame.cancelLabel}
      size="lg"
      dismissible={false}
      isPending={isPending}
      confirmDisabled={!stepValid[step]}
      onClose={onClose}
      onCancel={frame.onCancel}
      onConfirm={frame.onConfirm}
    >
      {body}
    </ActionDialog>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Progreso de la reservación">
      {steps.map((item, index) => {
        const Icon = item.icon;
        return (
          <li key={item.title} className="min-w-0 text-center">
            <div
              className={cn(
                'mx-auto flex h-11 w-11 items-center justify-center rounded-full border-2 text-slate-400',
                index < current && 'border-teal bg-teal text-white',
                index === current && 'border-teal bg-teal-light text-teal-deep',
              )}
            >
              {index < current ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
            </div>
            <span
              className={cn(
                'mt-1.5 block truncate text-sm font-semibold text-slate-400',
                index === current && 'text-teal-deep',
              )}
            >
              {item.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
    </div>
  );
}

function GuestModeButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof UserPlus;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-14 items-center justify-center gap-2 rounded-lg px-3 text-base font-bold transition',
        active
          ? 'bg-white text-teal-deep shadow-sm ring-1 ring-teal/20'
          : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
      )}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

function clearGuest(form: ReturnType<typeof initialForm>) {
  return {
    ...form,
    guestId: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    documentType: 'CEDULA' as TaxDocumentType,
    documentNumber: '',
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-semibold text-slate-700">
      {label}
      {children}
    </label>
  );
}

function nightsBetweenDates(checkIn: string, checkOut: string) {
  if (!checkIn || !checkOut) return 0;
  const difference = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return difference > 0 ? Math.max(1, Math.ceil(difference / 86_400_000)) : 0;
}

function formatDateTimeInput(value: string) {
  if (!value) return '—';
  const day = new Intl.DateTimeFormat('es-DO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${value.slice(0, 10)}T12:00:00Z`),
  );
  return `${day} ${formatTime(value.slice(11, 16))}`;
}

function stepDescription(step: number) {
  return [
    'Selecciona un cliente registrado o crea uno nuevo.',
    'Indica las fechas y la cantidad de personas.',
    'Elige entre las habitaciones realmente disponibles.',
    'Revisa la información antes de crear la reservación.',
  ][step];
}

function creditOf(guest: HotelGuest) {
  return (guest.credits ?? []).reduce((sum, credit) => sum + Number(credit.remainingAmount), 0);
}

/** Atajos de tarifa (como en la reserva rápida): normal, Visitador (RD$2,100 fijo) o Precio Sencilla. */
function RateShortcuts({
  nights,
  roomType,
  single,
  total,
  onTotal,
}: {
  nights: number;
  roomType?: HotelRoomType;
  single?: HotelRoomType;
  total: number;
  onTotal: (value: number) => void;
}) {
  if (!roomType) return null;
  const options = [
    { key: 'normal', label: `Tarifa ${roomType.name}`, rate: Number(roomType.baseRate) },
    { key: 'visitor', label: 'Visitador', rate: VISITOR_RATE },
    ...(single && single.id !== roomType.id && Number(single.baseRate) < Number(roomType.baseRate)
      ? [{ key: 'single', label: 'Precio Sencilla', rate: Number(single.baseRate) }]
      : []),
  ];
  return (
    <div>
      <p className="text-sm font-semibold text-slate-700">Tarifa por noche</p>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const value = Math.round(option.rate * nights * 100) / 100;
          const active = Math.abs(total - value) < 0.01;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onTotal(value)}
              aria-pressed={active}
              className={cn(
                'rounded-xl border-2 px-4 py-3 text-left transition',
                active ? 'border-teal bg-teal-light text-teal-deep' : 'border-slate-200 bg-white text-slate-700',
              )}
            >
              <span className="block text-base font-extrabold">{option.label}</span>
              <span className="text-sm">
                RD${option.rate.toLocaleString('en-US', { minimumFractionDigits: 2 })} / noche · {nights}{' '}
                {nights === 1 ? 'noche' : 'noches'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

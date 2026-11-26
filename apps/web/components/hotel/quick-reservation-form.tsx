'use client';

import { ArrowLeft, BadgePercent, Check, Loader2, Minus, Plus, Search, Tags, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  CreateHotelReservationPayload,
  HotelChannel,
  HotelGuest,
  HotelReservation,
  HotelRoom,
  HotelRoomType,
  TaxIdentityLookup,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatMoney } from './hotel-flow';
import { addDays, formatDayLong, occupiesNight } from './reservations-calendar';
import { TaxIdentityField, type TaxDocumentType } from './tax-identity-field';

/** Tarifa fija "Visitador" por noche. */
export const VISITOR_RATE = 2100;
const MAX_NIGHTS = 30;
export const ARRIVAL_TIME = '3:00 PM';
/** Hora de salida por defecto. */
export const DEPARTURE_TIME = '11:00 AM';
const round = (value: number) => Math.round(value * 100) / 100;

type Props = {
  day: string;
  today: string;
  room: HotelRoom;
  roomType: HotelRoomType;
  roomTypes: HotelRoomType[];
  reservations: HotelReservation[];
  guests: HotelGuest[];
  channels: HotelChannel[];
  availableOn: (typeId: string, key: string) => number;
  onCreate: (payload: CreateHotelReservationPayload) => Promise<void>;
};

/**
 * Reserva rápida desde el calendario: la fecha y la habitación ya están elegidas, así que solo pide el
 * huésped (nuevo o registrado) y la confirmación con noches, personas y ajustes de tarifa.
 * Los ajustes de tarifa (Visitador RD$2,100 fijo / Precio Sencilla) solo cambian el monto por noche: la
 * factura sale normal con ese precio. Las horas son fijas: llegada 3:00 PM y salida 11:00 AM.
 */
export function QuickReservationForm(props: Props) {
  const { day, today, room, roomType, roomTypes, reservations } = props;
  const [step, setStep] = useState<'guest' | 'confirm'>('guest');
  const [mode, setMode] = useState<'NEW' | 'REGISTERED'>('NEW');
  const [search, setSearch] = useState('');
  const [guestId, setGuestId] = useState('');
  const [guest, setGuest] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    documentType: 'CEDULA' as TaxDocumentType,
    documentNumber: '',
  });
  const [nights, setNights] = useState(1);
  const [adults, setAdults] = useState(Math.min(2, roomType.capacityAdults));
  const [children, setChildren] = useState(0);
  const defaultChannel =
    props.channels.find((channel) => channel.active && (channel.type === 'WALK_IN' || /interno/i.test(channel.name))) ??
    props.channels.find((channel) => channel.active);
  const [channelId, setChannelId] = useState(defaultChannel?.id ?? '');
  const [notes, setNotes] = useState('');
  const [rateMode, setRateMode] = useState<'NORMAL' | 'VISITOR' | 'SINGLE'>('NORMAL');
  const [saving, setSaving] = useState(false);

  // Noches seguidas en que esta habitación (y el cupo del tipo) siguen libres desde el día elegido.
  const maxNights = useMemo(() => {
    let count = 0;
    for (let index = 0; index < MAX_NIGHTS; index += 1) {
      const night = addDays(day, index);
      const roomTaken = reservations.some((item) => item.room?.id === room.id && occupiesNight(item, night, today));
      if (roomTaken || props.availableOn(roomType.id, night) < 1) break;
      count += 1;
    }
    return Math.max(1, count);
  }, [day, props, reservations, room.id, roomType.id, today]);

  const single = roomTypes.find((type) => /sencill/i.test(type.name)) ?? roomTypes[0];
  const canUseSinglePrice = Boolean(single && single.id !== roomType.id && Number(single.baseRate) < Number(roomType.baseRate));
  const baseRate = Number(roomType.baseRate);
  // Dos ajustes excluyentes: Visitador (RD$2,100 fijo por noche) o Precio Sencilla (tarifa de la Sencilla).
  const nightlyRate = round(
    rateMode === 'VISITOR'
      ? VISITOR_RATE
      : rateMode === 'SINGLE' && canUseSinglePrice
        ? Number(single.baseRate)
        : baseRate,
  );
  const total = round(nightlyRate * nights);

  const filteredGuests = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    const list = query
      ? props.guests.filter((item) =>
          [item.firstName, item.lastName, item.phone, item.documentNumber]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase('es')
            .includes(query),
        )
      : props.guests;
    return list.slice(0, 8);
  }, [props.guests, search]);
  const selectedGuest = props.guests.find((item) => item.id === guestId);

  const guestValid =
    mode === 'REGISTERED'
      ? Boolean(selectedGuest)
      : Boolean(guest.firstName.trim() && (guest.lastName.trim() || guest.documentType === 'RNC'));

  const onRegistryName = (result: TaxIdentityLookup) => {
    const title = (value: string) =>
      value.toLocaleLowerCase('es').replace(/(^|\s)(\p{L})/gu, (match) => match.toLocaleUpperCase('es'));
    const full = title(result.name ?? '');
    if (result.documentType === 'RNC') return setGuest((current) => ({ ...current, firstName: full, lastName: '' }));
    const words = full.split(/\s+/).filter(Boolean);
    const given = words.length >= 4 ? 2 : 1;
    setGuest((current) => ({ ...current, firstName: words.slice(0, given).join(' '), lastName: words.slice(given).join(' ') }));
  };

  const submit = async () => {
    const who = mode === 'REGISTERED' && selectedGuest
      ? {
          guestId: selectedGuest.id,
          firstName: selectedGuest.firstName,
          lastName: selectedGuest.lastName,
          phone: selectedGuest.phone || undefined,
        }
      : {
          firstName: guest.firstName.trim(),
          lastName: guest.lastName.trim(),
          phone: guest.phone.trim() || undefined,
          ...(guest.documentNumber.trim()
            ? { documentType: guest.documentType, documentNumber: guest.documentNumber.trim() }
            : {}),
        };
    setSaving(true);
    try {
      await props.onCreate({
        ...who,
        roomTypeId: roomType.id,
        roomId: room.id,
        channelId,
        checkIn: `${day}T15:00:00-04:00`,
        checkOut: `${addDays(day, nights)}T11:00:00-04:00`,
        adults,
        children,
        totalAmount: total,
        specialRequests: notes.trim() || undefined,
      });
    } catch {
      // El error ya se muestra como aviso; el formulario queda abierto para corregir.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        <span className="font-bold text-slate-900">Hab. {room.number}</span>
        <span className="text-slate-500">·</span>
        <span>{roomType.name}</span>
        <span className="text-slate-500">·</span>
        <span>Llegada {formatDayLong(day)} · {ARRIVAL_TIME}</span>
        <span className="ml-auto flex gap-1.5">
          <StepDot active={step === 'guest'} done={step === 'confirm'} label="1. Huésped" />
          <StepDot active={step === 'confirm'} label="2. Confirmar" />
        </span>
      </div>

      {step === 'guest' ? (
        <>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1.5">
            {(
              [
                ['NEW', 'Cliente nuevo', UserPlus],
                ['REGISTERED', 'Cliente registrado', Users],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  'flex h-11 items-center justify-center gap-2 rounded-lg text-sm font-bold',
                  mode === value ? 'bg-white text-teal-deep shadow-sm ring-1 ring-teal/20' : 'text-slate-500',
                )}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>

          {mode === 'NEW' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TaxIdentityField
                documentType={guest.documentType}
                documentNumber={guest.documentNumber}
                onChange={(value) => setGuest((current) => ({ ...current, ...value }))}
                onNameFound={onRegistryName}
              />
              <Field label="Nombre *" value={guest.firstName} onChange={(firstName) => setGuest((c) => ({ ...c, firstName }))} />
              <Field
                label={guest.documentType === 'RNC' ? 'Apellido' : 'Apellido *'}
                value={guest.lastName}
                onChange={(lastName) => setGuest((c) => ({ ...c, lastName }))}
              />
              <Field label="Teléfono / WhatsApp" type="tel" value={guest.phone} onChange={(phone) => setGuest((c) => ({ ...c, phone }))} />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="relative block">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="h-11 w-full rounded-lg border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/10"
                  placeholder="Buscar por nombre, teléfono o cédula…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <div className="grid max-h-60 gap-2 overflow-y-auto sm:grid-cols-2">
                {filteredGuests.map((item) => {
                  const credit = (item.credits ?? []).reduce((sum, c) => sum + Number(c.remainingAmount), 0);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setGuestId(item.id)}
                      className={cn(
                        'rounded-xl border p-2.5 text-left',
                        guestId === item.id ? 'border-teal bg-teal-light/60 ring-1 ring-teal/30' : 'border-slate-200 hover:border-teal/40',
                      )}
                    >
                      <span className="block truncate text-sm font-bold">
                        {item.firstName} {item.lastName}
                      </span>
                      <span className="block truncate text-xs text-slate-500">{item.phone || item.documentNumber || 'Sin contacto'}</span>
                      {credit > 0 ? (
                        <span className="mt-1 inline-block rounded-full bg-teal-light px-2 py-0.5 text-[10px] font-bold text-teal-deep">
                          Crédito {formatMoney(credit)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {!filteredGuests.length ? <p className="p-4 text-center text-sm text-slate-500 sm:col-span-2">Sin resultados.</p> : null}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={!guestValid}
              onClick={() => setStep('confirm')}
              className="h-12 rounded-xl bg-teal px-6 text-sm font-bold text-white disabled:opacity-40"
            >
              Continuar
            </button>
          </div>
        </>
      ) : (
        <>
          <StayTimes arrival={day} departure={addDays(day, nights)} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Stepper
              label="Noches"
              value={nights}
              min={1}
              max={maxNights}
              onChange={setNights}
              hint={maxNights < MAX_NIGHTS ? `Máximo ${maxNights} ${maxNights === 1 ? 'noche' : 'noches'} libres seguidas` : undefined}
            />
            <Stepper label="Adultos" value={adults} min={1} max={roomType.capacityAdults} onChange={setAdults} />
            <Stepper label="Niños" value={children} min={0} max={roomType.capacityChildren} onChange={setChildren} />
          </div>

          <div>
            <p className="text-xs font-bold text-slate-700">Ajustes de tarifa</p>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              <Toggle
                active={rateMode === 'VISITOR'}
                onClick={() => setRateMode((mode) => (mode === 'VISITOR' ? 'NORMAL' : 'VISITOR'))}
                icon={BadgePercent}
                title="Visitador"
                detail={`Precio fijo de ${formatMoney(VISITOR_RATE)} / noche`}
              />
              {canUseSinglePrice ? (
                <Toggle
                  active={rateMode === 'SINGLE'}
                  onClick={() => setRateMode((mode) => (mode === 'SINGLE' ? 'NORMAL' : 'SINGLE'))}
                  icon={Tags}
                  title="Precio Sencilla"
                  detail={`Cobrar ${formatMoney(single.baseRate)} / noche en vez de ${formatMoney(roomType.baseRate)}`}
                />
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-slate-700">
              Canal
              <select
                className="mt-1 h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
              >
                {props.channels
                  .filter((channel) => channel.active)
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
              </select>
            </label>
            <Field label="Notas (opcional)" value={notes} onChange={setNotes} />
          </div>

          {/* Total y botón fijos al pie: siempre visibles aunque el formulario se desplace. */}
          <div className="sticky bottom-0 -mx-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 p-2 shadow-[0_-8px_20px_-14px_rgba(0,0,0,0.25)] backdrop-blur sm:gap-3 sm:p-3">
            <button
              type="button"
              onClick={() => setStep('guest')}
              aria-label="Anterior"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-sm font-bold sm:h-12 sm:w-auto sm:px-4"
            >
              <ArrowLeft className="h-4 w-4 sm:hidden" />
              <span className="hidden sm:inline">Anterior</span>
            </button>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate text-[11px] text-slate-500 sm:text-xs">
                {mode === 'REGISTERED' && selectedGuest
                  ? `${selectedGuest.firstName} ${selectedGuest.lastName}`
                  : `${guest.firstName} ${guest.lastName}`.trim()}{' '}
                · {formatMoney(nightlyRate)} / noche
                {nightlyRate !== baseRate ? <span className="ml-1 text-slate-400 line-through">{formatMoney(baseRate)}</span> : null}
              </p>
              <p className="whitespace-nowrap font-extrabold text-teal-deep">
                <span className="hidden sm:inline">Total · {nights} {nights === 1 ? 'noche' : 'noches'}: </span>
                <span className="text-base sm:text-xl">{formatMoney(total)}</span>
              </p>
            </div>
            <button
              type="button"
              disabled={saving || !channelId}
              onClick={submit}
              className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-teal px-4 text-sm font-bold text-white disabled:opacity-40 sm:h-12 sm:px-6"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              <span className="sm:hidden">Crear</span>
              <span className="hidden sm:inline">Crear reservación</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function StepDot({ active, done, label }: { active: boolean; done?: boolean; label: string }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-bold',
        active ? 'bg-teal text-white' : done ? 'bg-teal-light text-teal-deep' : 'bg-white text-slate-400',
      )}
    >
      {label}
    </span>
  );
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block text-xs font-semibold text-slate-700">
      {label}
      <input
        type={type}
        className="mt-1 h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/10"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-700">{label}</p>
      <div className="mt-1 flex h-12 items-center justify-between rounded-xl border border-slate-200 bg-white">
        <button type="button" disabled={value <= min} onClick={() => onChange(value - 1)} className="flex h-full w-12 items-center justify-center disabled:opacity-30" aria-label={`Menos ${label}`}>
          <Minus className="h-5 w-5" />
        </button>
        <span className="text-xl font-extrabold tabular-nums">{value}</span>
        <button type="button" disabled={value >= max} onClick={() => onChange(value + 1)} className="flex h-full w-12 items-center justify-center disabled:opacity-30" aria-label={`Más ${label}`}>
          <Plus className="h-5 w-5" />
        </button>
      </div>
      {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

function Toggle({
  active,
  disabled,
  onClick,
  icon: Icon,
  title,
  detail,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: typeof Tags;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-3 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'border-teal bg-teal-light text-teal-deep' : 'border-slate-200 bg-white text-slate-700',
      )}
    >
      <Icon className="h-6 w-6 shrink-0" />
      <span>
        <span className="block text-sm font-extrabold">
          {title} {active ? '· aplicado' : ''}
        </span>
        <span className="text-[11px] opacity-80">{detail}</span>
      </span>
    </button>
  );
}

/** Llegada y salida bien visibles (fecha y hora). */
export function StayTimes({ arrival, departure }: { arrival: string; departure: string }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-xl border-2 border-teal/40 bg-teal-light/50 px-3 py-2">
        <p className="text-[10px] font-extrabold uppercase tracking-wider text-teal-deep">Llegada</p>
        <p className="text-sm font-bold first-letter:uppercase text-slate-900">{formatDayLong(arrival)}</p>
        <p className="text-2xl font-extrabold tabular-nums text-teal-deep">{ARRIVAL_TIME}</p>
      </div>
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-3 py-2">
        <p className="text-[10px] font-extrabold uppercase tracking-wider text-amber-800">Salida</p>
        <p className="text-sm font-bold first-letter:uppercase text-slate-900">{formatDayLong(departure)}</p>
        <p className="text-2xl font-extrabold tabular-nums text-amber-700">{DEPARTURE_TIME}</p>
      </div>
    </div>
  );
}

'use client';

import Image from 'next/image';
import {
  CalendarDays,
  CheckCircle2,
  CreditCard,
  FileText,
  Info,
  Lock,
  MessageCircle,
  ServerCog,
  Users,
} from 'lucide-react';
import { roomContentFor } from '@/lib/content';
import { formatLong, money } from '@/lib/dates';
import { RoomPrice } from './room-detail-dialog';
import type { Quote, ReservationConfirmation, RoomType } from '@/lib/types';

type Props = {
  room: RoomType | null;
  image: string | null;
  checkIn: string;
  checkOut: string;
  guestsLabel: string;
  quote: Quote | null;
  canSubmit: boolean;
  blockedReason: string | null;
  error: string | null;
  confirmation: ReservationConfirmation | null;
  onCheckout: () => void;
  onReset: () => void;
};

export function SummaryCard(props: Props) {
  const { room, quote, confirmation } = props;
  const guests = props.guestsLabel;

  return (
    <div className="space-y-4 lg:sticky lg:top-24">
      <section className="card p-5" aria-live="polite">
        {confirmation ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-sea" aria-hidden />
            <h2 className="mt-3 font-serif text-2xl font-semibold">¡Solicitud enviada y pagada!</h2>
            <p className="mt-2 text-sm text-muted">
              Tu código de reserva es
            </p>
            <p className="mt-1 font-mono text-2xl font-bold tracking-wider text-sea-dark">{confirmation.code}</p>
            <dl className="mt-5 space-y-2 rounded-xl bg-sand p-4 text-left text-sm">
              <Row label="Habitación" value={confirmation.roomType} />
              <Row label="Llegada" value={formatLong(confirmation.checkIn)} />
              <Row label="Salida" value={formatLong(confirmation.checkOut)} />
              <Row label="Noches" value={String(confirmation.nights)} />
              <Row label="Total pagado" value={money(confirmation.paidAmount || confirmation.total)} strong />
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Estado del pago</dt>
                <dd className="rounded-full bg-sea-light px-2.5 py-0.5 text-xs font-bold text-sea-dark">Pagado</dd>
              </div>
            </dl>
            <p className="mt-4 text-[13px] leading-relaxed text-muted">
              Recibimos tu pago y tu solicitud ya está en manos del hotel. Te confirmaremos la reserva por
              WhatsApp en breve. Guarda tu código para cualquier consulta.
            </p>
            <button type="button" onClick={props.onReset} className="btn-outline mt-5 w-full">
              Hacer otra reserva
            </button>
          </div>
        ) : (
          <>
            <h2 className="flex items-center gap-2.5 font-serif text-xl font-semibold">
              <FileText className="h-5 w-5 text-sea" aria-hidden /> Resumen de tu reserva
            </h2>
            {room ? (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-line p-2">
                {props.image && (
                  <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded-lg">
                    <Image src={props.image} alt="" fill sizes="80px" className="object-cover" />
                  </div>
                )}
                <p className="flex-1 font-semibold">{room.name}</p>
                <div className="pr-1 text-right">
                  <RoomPrice room={room} priceUsd={roomContentFor(room.name).priceUsd} />
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">
                Selecciona una habitación para ver el total.
              </p>
            )}
            <dl className="mt-4 space-y-2.5 text-sm">
              <IconRow icon={CalendarDays} label="Check-in" value={props.checkIn ? formatLong(props.checkIn) : '—'} />
              <IconRow
                icon={CalendarDays}
                label="Check-out"
                value={props.checkOut ? formatLong(props.checkOut) : '—'}
                hint={quote ? `${quote.nights} ${quote.nights === 1 ? 'noche' : 'noches'}` : undefined}
              />
              <IconRow icon={Users} label="Huéspedes" value={guests} />
            </dl>
            {quote && room && (
              <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
                <Row label={`Subtotal (${quote.nights} ${quote.nights === 1 ? 'noche' : 'noches'})`} value={money(quote.subtotal)} />
                {quote.taxRate > 0 && <Row label={`Impuestos (${Math.round(quote.taxRate * 100)}%)`} value={money(quote.taxes)} />}
                <div className="!mt-3 flex items-center justify-between rounded-lg bg-sea-light px-3 py-2.5">
                  <dt className="font-bold">Total a pagar</dt>
                  <dd className="text-xl font-bold text-sea-dark">{money(quote.total)}</dd>
                </div>
              </dl>
            )}
            {props.error && (
              <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
                {props.error}
              </p>
            )}
            <button type="button" onClick={props.onCheckout} disabled={!props.canSubmit} className="btn-primary mt-4 w-full">
              <Lock className="h-4 w-4" aria-hidden /> Reservar y pagar
            </button>
            {props.blockedReason && (
              <p className="mt-2 text-center text-xs text-muted">{props.blockedReason}</p>
            )}
            <p className="mt-3 flex gap-2 text-xs leading-relaxed text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Pagas en línea con tarjeta y tu habitación queda apartada mientras el hotel confirma tu reserva.
            </p>
          </>
        )}
      </section>

      <ul className="card space-y-4 bg-white/70 p-5 text-sm">
        <Benefit icon={CreditCard} title="Pago seguro en línea" text="Paga con tu tarjeta en un solo paso." />
        <Benefit icon={ServerCog} title="Habitación apartada al pagar" text="Tu solicitud llega al instante al hotel para su confirmación." />
        <Benefit icon={MessageCircle} title="Detalles por WhatsApp" text="Te escribimos con todo lo necesario para tu llegada." />
      </ul>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={strong ? 'font-bold text-sea-dark' : 'font-medium'}>{value}</dd>
    </div>
  );
}

function IconRow({ icon: Icon, label, value, hint }: { icon: typeof Users; label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="flex items-center gap-2 text-muted">
        <Icon className="h-4 w-4" aria-hidden /> {label}
      </dt>
      <dd className="text-right">
        {value}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </dd>
    </div>
  );
}

function Benefit({ icon: Icon, title, text }: { icon: typeof Users; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-sea" aria-hidden />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="text-xs text-muted">{text}</span>
      </span>
    </li>
  );
}

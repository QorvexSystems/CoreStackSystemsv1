'use client';

import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ActionDialog } from '@/components/ui/action-dialog';
import type { HotelReservation } from '@/lib/api';
import { formatMoney, formatStayDateTime } from './hotel-flow';

const HOTEL_TIME_ZONE = 'America/Santo_Domingo';
const DAY_MS = 86_400_000;

function hotelDateKey(value: string | Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOTEL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Vista previa del check-out anticipado (misma regla que el servidor): noches pagadas y no usadas, con al
 * menos una noche usada. Devuelve null si el check-out es en la fecha acordada o después.
 */
export function earlyCheckoutPreview(reservation: HotelReservation, now = new Date()) {
  const arrival = hotelDateKey(reservation.checkIn);
  const departure = hotelDateKey(reservation.checkOut);
  const today = hotelDateKey(now);
  if (today >= departure) return null;
  const booked = Math.max(1, daysBetween(arrival, departure));
  const used = Math.min(booked, Math.max(1, daysBetween(arrival, today)));
  const nights = booked - used;
  const paid = Math.min(Number(reservation.paidAmount), Number(reservation.totalAmount));
  const amount = Math.round((paid / booked) * nights * 100) / 100;
  return { booked, used, nights, amount };
}

/** Confirmación de check-out antes de la fecha acordada, con opción de dejar crédito a favor del huésped. */
export function CheckoutConfirmDialog({
  reservation,
  isPending,
  onCancel,
  onConfirm,
}: {
  reservation: HotelReservation | null;
  isPending?: boolean;
  onCancel: () => void;
  onConfirm: (options: { grantCredit: boolean }) => void;
}) {
  const [grantCredit, setGrantCredit] = useState(true);
  useEffect(() => setGrantCredit(true), [reservation?.id]);
  if (!reservation) return null;
  const preview = earlyCheckoutPreview(reservation);
  const guest = `${reservation.guest.firstName} ${reservation.guest.lastName}`;

  return (
    <ActionDialog
      open
      tone="warning"
      eyebrow="Check-out anticipado"
      title="¿Seguro que quieres hacer el check-out?"
      description={`${guest} tiene la salida acordada para el ${formatStayDateTime(reservation.checkOut)}.`}
      icon={<AlertTriangle className="h-5 w-5" />}
      confirmLabel="Sí, hacer check-out"
      cancelLabel="Cancelar"
      isPending={isPending}
      onClose={onCancel}
      onCancel={onCancel}
      onConfirm={() => onConfirm({ grantCredit: Boolean(preview?.nights) && grantCredit })}
    >
      {preview && preview.nights > 0 ? (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-center">
            <Metric label="Noches pagadas" value={String(preview.booked)} />
            <Metric label="Noches usadas" value={String(preview.used)} />
            <Metric label="No usadas" value={String(preview.nights)} highlight />
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-teal/30 bg-teal-light/40 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-teal"
              checked={grantCredit}
              onChange={(event) => setGrantCredit(event.target.checked)}
            />
            <span>
              <span className="block font-bold text-teal-deep">
                Dejar crédito a favor: {preview.nights} {preview.nights === 1 ? 'noche' : 'noches'} ·{' '}
                {formatMoney(preview.amount)}
              </span>
              <span className="text-xs text-slate-600">
                Queda guardado en la ficha de {guest} y se puede aplicar como pago en su próxima reserva.
              </span>
            </span>
          </label>
        </div>
      ) : (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          La salida es antes de lo acordado, pero no hay noches completas sin usar que acreditar.
        </p>
      )}
    </ActionDialog>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 text-lg font-extrabold ${highlight ? 'text-amber-600' : 'text-slate-900'}`}>{value}</p>
    </div>
  );
}

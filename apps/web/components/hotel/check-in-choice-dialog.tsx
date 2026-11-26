'use client';

import { CircleDollarSign, Hourglass } from 'lucide-react';
import { ActionDialog } from '@/components/ui/action-dialog';
import type { HotelReservation } from '@/lib/api';
import { canCollectReservationPayment, formatMoney, reservationBalance } from './hotel-flow';

/**
 * Check-in con balance pendiente: recepción elige si el huésped paga ahora (se registra el cobro y luego
 * el check-in) o al final (check-in ya; el cobro se exige antes del check-out).
 */
export function CheckInChoiceDialog({
  reservation,
  isPending,
  onPayNow,
  onPayLater,
  onClose,
}: {
  reservation: HotelReservation | null;
  isPending?: boolean;
  onPayNow: (reservation: HotelReservation) => void;
  onPayLater: (reservation: HotelReservation) => void;
  onClose: () => void;
}) {
  if (!reservation) return null;
  const canCollect = canCollectReservationPayment(reservation);
  return (
    <ActionDialog
      open
      eyebrow={`Check-in · ${reservation.room ? `Hab. ${reservation.room.number}` : reservation.code}`}
      title="¿Registrar el pago ahora o al final?"
      description={`${reservation.guest.firstName} ${reservation.guest.lastName} tiene un balance de ${formatMoney(reservationBalance(reservation))}.`}
      icon={<CircleDollarSign className="h-5 w-5" />}
      confirmLabel="Cerrar"
      hideFooter
      onClose={onClose}
      onConfirm={onClose}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={!canCollect || isPending}
          onClick={() => onPayNow(reservation)}
          className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-teal bg-teal-light/50 p-4 text-center text-teal-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CircleDollarSign className="h-9 w-9" />
          <span className="text-lg font-extrabold">Cobrar ahora</span>
          <span className="text-sm">
            {canCollect ? 'Registra el pago y luego haz el check-in.' : 'El cobro se habilita el día de llegada.'}
          </span>
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => onPayLater(reservation)}
          className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-center text-amber-900 disabled:opacity-50"
        >
          <Hourglass className="h-9 w-9" />
          <span className="text-lg font-extrabold">Pagar al final</span>
          <span className="text-sm">Check-in ahora; el cobro se hace antes del check-out.</span>
        </button>
      </div>
    </ActionDialog>
  );
}

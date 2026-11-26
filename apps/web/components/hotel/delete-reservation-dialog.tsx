'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import { deleteHotelReservation, type HotelReservation } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { formatMoney, formatStayDate } from './hotel-flow';

/** Confirmación para eliminar una reservación antes del check-in (administrador y recepción). */
export function DeleteReservationDialog({
  reservation,
  onClose,
  onDeleted,
}: {
  reservation: HotelReservation | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const session = getSession();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => deleteHotelReservation(session!.tenantId, session!.accessToken, id),
    onSuccess: async () => {
      toast.success(`Reservación ${reservation?.code ?? ''} eliminada`);
      await queryClient.invalidateQueries({ queryKey: ['hotel'] });
      onDeleted?.();
      onClose();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  if (!reservation) return null;
  return (
    <ActionDialog
      open
      tone="danger"
      eyebrow="Eliminar reservación"
      title={`¿Eliminar la reservación ${reservation.code}?`}
      description="Se borra por completo y libera la habitación en el calendario. No se puede deshacer."
      icon={<Trash2 className="h-5 w-5" />}
      confirmLabel="Sí, eliminar"
      cancelLabel="No, volver"
      isPending={mutation.isPending}
      onClose={onClose}
      onCancel={onClose}
      onConfirm={() => mutation.mutate(reservation.id)}
    >
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-base">
        <p className="font-extrabold text-slate-900">
          {reservation.guest.firstName} {reservation.guest.lastName}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {reservation.room ? `Hab. ${reservation.room.number} · ` : ''}
          {reservation.roomType.name} · {formatStayDate(reservation.checkIn)} → {formatStayDate(reservation.checkOut)}
        </p>
        <p className="mt-1 text-sm text-slate-600">Total {formatMoney(reservation.totalAmount)}</p>
      </div>
    </ActionDialog>
  );
}

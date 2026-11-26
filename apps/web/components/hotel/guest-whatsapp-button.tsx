'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageCircle, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { updateHotelGuest, type HotelReservation } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { isAdminSession, isReceptionSession } from '@/lib/authorization';
import { whatsappUrl } from './whatsapp';

/**
 * Botón de WhatsApp del huésped de una reservación. Si no tiene teléfono, recepción puede escribirlo ahí
 * mismo: se guarda en la ficha del huésped y el botón queda listo para abrir el chat.
 */
export function GuestWhatsAppButton({ reservation }: { reservation: HotelReservation }) {
  const session = getSession();
  const queryClient = useQueryClient();
  const canEdit = isAdminSession(session) || isReceptionSession(session);
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState('');
  const digits = phone.replace(/\D/g, '');
  const mutation = useMutation({
    mutationFn: () =>
      updateHotelGuest(session!.tenantId, session!.accessToken, reservation.guest.id, { phone: phone.trim() }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hotel', 'reservations'] }),
        queryClient.invalidateQueries({ queryKey: ['hotel', 'guests'] }),
      ]);
      toast.success('Teléfono guardado en la ficha del huésped');
      setAdding(false);
      setPhone('');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const chat = whatsappUrl(
    reservation.guest.phone,
    `Hola ${reservation.guest.firstName}, le escribimos de Hotel Suite Ancla sobre su reservación ${reservation.code}.`,
  );
  if (chat)
    return (
      <a
        href={chat}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 rounded-xl bg-[#25D366] px-3 py-2.5 text-sm font-bold text-white active:opacity-90"
      >
        <MessageCircle className="h-4 w-4" /> Contactar por WhatsApp · {reservation.guest.phone}
      </a>
    );

  if (!canEdit)
    return (
      <p className="rounded-xl bg-slate-50 px-3 py-2 text-center text-xs text-slate-500">
        El huésped no tiene teléfono registrado para WhatsApp.
      </p>
    );

  if (!adding)
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#25D366] bg-white px-3 py-2.5 text-sm font-bold text-emerald-700 hover:bg-emerald-50"
      >
        <Plus className="h-4 w-4" /> Agregar WhatsApp del huésped
      </button>
    );

  return (
    <form
      className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (digits.length >= 10) mutation.mutate();
      }}
    >
      <label className="block px-1 text-xs font-semibold text-emerald-900">Teléfono / WhatsApp</label>
      <div className="mt-1 flex gap-2">
        <input
          autoFocus
          type="tel"
          inputMode="tel"
          maxLength={20}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="829-000-0000"
          className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-base outline-none focus:border-teal"
        />
        <button
          type="submit"
          disabled={digits.length < 10 || mutation.isPending}
          className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-[#25D366] px-3 text-sm font-bold text-white disabled:opacity-50"
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
          Guardar
        </button>
        <button
          type="button"
          onClick={() => setAdding(false)}
          className="h-11 rounded-lg px-2 text-sm font-semibold text-slate-500 hover:bg-white"
        >
          Cancelar
        </button>
      </div>
      {phone && digits.length < 10 ? (
        <p className="mt-1 px-1 text-xs text-rose-600">Escribe el teléfono completo (10 dígitos).</p>
      ) : null}
    </form>
  );
}

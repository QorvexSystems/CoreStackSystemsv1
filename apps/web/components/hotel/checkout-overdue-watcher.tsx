'use client';

import { useQuery } from '@tanstack/react-query';
import { AlarmClock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionDialog } from '@/components/ui/action-dialog';
import { getHotelReservations } from '@/lib/api';
import type { AuthSession } from '@/lib/auth-session';
import { checkoutAlert, formatStayDate } from './hotel-flow';

const SEEN_KEY = 'hotel-checkout-overdue-seen';
const WATCH_ROLES = ['ADMIN', 'SUPER_ADMIN', 'QORVEX_SUPER_ADMIN', 'RECEPTION'];

function readSeen(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function writeSeen(ids: string[]) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    // Sin almacenamiento: la alerta puede repetirse al recargar, no es grave.
  }
}

/**
 * Aviso emergente en cualquier pantalla del ERP: a las 12:00 PM (1 hora después de la salida de las
 * 11:00 AM) recuerda a recepción las habitaciones que siguen sin check-out. Cada reservación avisa una vez
 * por dispositivo; en Check-in / Check-out la tarjeta sigue en rojo hasta hacer el check-out.
 */
export function CheckoutOverdueWatcher({ session }: { session: AuthSession }) {
  const router = useRouter();
  const enabled = WATCH_ROLES.includes(session.role);
  const [now, setNow] = useState(() => new Date());
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const reservations = useQuery({
    queryKey: ['hotel', 'reservations', session.tenantId],
    queryFn: () => getHotelReservations(session.tenantId, session.accessToken),
    enabled,
    refetchInterval: 60_000,
  });
  const overdue = (reservations.data ?? []).filter((item) => checkoutAlert(item, now) === 'overdue');
  const overdueKey = overdue.map((item) => item.id).join(',');

  useEffect(() => {
    if (!overdueKey) return;
    const seen = readSeen();
    const fresh = overdueKey.split(',').filter((id) => !seen.includes(id));
    if (!fresh.length) return;
    setPending((current) => [...new Set([...current, ...fresh])]);
    // Notificación del sistema (si el navegador tiene permiso), además del aviso dentro del ERP.
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const rooms = overdue
          .filter((item) => fresh.includes(item.id))
          .map((item) => item.room?.number ?? item.code)
          .join(', ');
        new Notification('Check-out pendiente', {
          body: `Habitación ${rooms}: pasó 1 hora de la salida (11:00 AM) y aún no se ha hecho check-out.`,
          tag: `checkout-overdue-${fresh.join('-')}`,
        });
      }
    } catch {
      // Algunos navegadores (Android) solo permiten notificaciones desde el service worker.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overdueKey]);

  const shown = overdue.filter((item) => pending.includes(item.id));
  if (!enabled || !shown.length) return null;
  const acknowledge = () => {
    writeSeen([...readSeen(), ...pending]);
    setPending([]);
  };
  return (
    <ActionDialog
      open
      tone="danger"
      eyebrow="Salida 11:00 AM · pasó 1 hora"
      title={shown.length === 1 ? 'Check-out pendiente' : `${shown.length} check-outs pendientes`}
      description="Estas habitaciones aún no han hecho check-out."
      icon={<AlarmClock className="h-5 w-5" />}
      confirmLabel="Ir a Check-in / Check-out"
      cancelLabel="Entendido"
      onClose={acknowledge}
      onCancel={acknowledge}
      onConfirm={() => {
        acknowledge();
        router.push('/check-in-out');
      }}
    >
      <div className="space-y-2">
        {shown.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border-2 border-rose-300 bg-rose-50 p-3">
            <div>
              <p className="text-lg font-extrabold text-rose-800">
                {item.room ? `Habitación ${item.room.number}` : item.code}
              </p>
              <p className="text-sm text-slate-700">
                {item.guest.firstName} {item.guest.lastName}
              </p>
            </div>
            <p className="text-right text-xs font-semibold text-rose-700">
              Salida
              <br />
              {formatStayDate(item.checkOut)} · 11:00 AM
            </p>
          </div>
        ))}
      </div>
    </ActionDialog>
  );
}

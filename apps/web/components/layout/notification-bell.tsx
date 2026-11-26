'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  BellRing,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  Mail,
  Pencil,
  Phone,
  Smartphone,
  Users,
  XCircle,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { ChannelBadge } from '@/components/hotel/channel-logo';
import {
  formatMoney,
  formatStayDateTime,
  nightsBetween,
} from '@/components/hotel/hotel-flow';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  getHotelRequests,
  sendTestPush,
  updateHotelReservationStatus,
  type HotelReservation,
} from '@/lib/api';
import type { AuthSession } from '@/lib/auth-session';
import { disablePush, enablePush, getPushState, type PushState } from '@/lib/push-client';
import { cn } from '@/lib/utils';

/**
 * Campanita del ERP: solicitudes de reserva pendientes de aprobación (las que llegan desde la web) y
 * activación de las notificaciones push en este dispositivo.
 */
export function NotificationBell({ session }: { session: AuthSession }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<HotelReservation | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);

  const requests = useQuery({
    queryKey: ['hotel', 'requests', session.tenantId],
    queryFn: () => getHotelRequests(session.tenantId, session.accessToken),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const items = requests.data ?? [];

  // Aviso dentro del ERP cuando llega una solicitud nueva con la aplicación abierta.
  useEffect(() => {
    if (!requests.data) return;
    const ids = new Set(requests.data.map((item) => item.id));
    if (seen.current) {
      const fresh = requests.data.filter((item) => !seen.current!.has(item.id));
      for (const item of fresh)
        toast.info(`Nueva solicitud ${item.code} · ${item.guest.firstName} ${item.guest.lastName}`, {
          action: { label: 'Ver', onClick: () => setDetail(item) },
        });
    }
    seen.current = ids;
  }, [requests.data]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'CONFIRMED' | 'CANCELLED' }) =>
      updateHotelReservationStatus(session.tenantId, session.accessToken, id, status),
    onSuccess: async (reservation) => {
      setDetail(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hotel'] }),
      ]);
      toast.success(
        reservation.status === 'CONFIRMED'
          ? `Solicitud ${reservation.code} aprobada`
          : `Solicitud ${reservation.code} rechazada`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="relative rounded-lg p-2 text-slate-700 hover:bg-slate-50"
        aria-label={`Notificaciones${items.length ? `: ${items.length} solicitudes pendientes` : ''}`}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {items.length ? (
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {items.length > 9 ? '9+' : items.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-16 z-40 max-h-[80vh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-[24rem]">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <p className="text-sm font-extrabold text-slate-900">Solicitudes de reserva</p>
              <p className="text-[11px] text-slate-500">Llegan desde el sitio web y esperan tu aprobación.</p>
            </div>
            <span className="rounded-full bg-teal-light px-2 py-0.5 text-xs font-bold text-teal-deep">
              {items.length}
            </span>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setDetail(item);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50"
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-700">
                  <BellRing className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold text-slate-900">
                      {item.guest.firstName} {item.guest.lastName}
                    </span>
                    <span className="shrink-0 text-[10px] font-semibold text-slate-400">{item.code}</span>
                  </span>
                  <span className="block truncate text-xs text-slate-600">
                    {item.roomType.name} · {formatStayDateTime(item.checkIn)}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[11px]">
                    <span className="font-bold text-slate-800">{formatMoney(item.totalAmount)}</span>
                    <PaymentChip reservation={item} />
                  </span>
                </span>
              </button>
            ))}
            {!items.length ? (
              <p className="px-4 py-8 text-center text-xs text-slate-500">
                {requests.isLoading ? 'Cargando…' : 'No hay solicitudes pendientes.'}
              </p>
            ) : null}
          </div>
          <PushSettings session={session} />
        </div>
      ) : null}

      {/* Portal: la barra superior usa backdrop-blur, que atraparía el diálogo fijo dentro de ella. */}
      {detail && typeof document !== 'undefined' ? createPortal(
        <ActionDialog
          open
          eyebrow="Solicitud de reserva"
          title={`${detail.code} · ${detail.guest.firstName} ${detail.guest.lastName}`}
          description="Revisa la solicitud. Puedes aprobarla tal como llegó o modificarla antes."
          icon={<BellRing className="h-5 w-5" />}
          confirmLabel=""
          hideFooter
          size="md"
          onClose={() => setDetail(null)}
          onConfirm={() => undefined}
        >
          <div className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <Info icon={CalendarDays} label="Estadía">
                {formatStayDateTime(detail.checkIn)} → {formatStayDateTime(detail.checkOut)}
                <span className="block text-xs text-slate-500">
                  {nightsBetween(detail.checkIn, detail.checkOut)} noches · {detail.roomType.name}
                </span>
              </Info>
              <Info icon={Users} label="Huéspedes">
                {detail.adults} adultos{detail.children ? ` · ${detail.children} niños` : ''}
                {detail.arrivalTime ? (
                  <span className="block text-xs text-slate-500">Llegada estimada: {detail.arrivalTime}</span>
                ) : null}
              </Info>
              <Info icon={Mail} label="Correo">
                {detail.guest.email || '—'}
              </Info>
              <Info icon={Phone} label="Teléfono / WhatsApp">
                {detail.guest.phone || '—'}
              </Info>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              <span className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <CreditCard className="h-4 w-4" /> {formatMoney(detail.paidAmount)} pagado de{' '}
                {formatMoney(detail.totalAmount)}
              </span>
              <span className="flex items-center gap-2">
                <PaymentChip reservation={detail} />
                {detail.channel ? <ChannelBadge name={detail.channel.name} /> : null}
              </span>
            </div>
            {detail.specialRequests ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <span className="font-bold">Notas del huésped:</span> {detail.specialRequests}
              </p>
            ) : null}
            <div className="grid gap-2 pt-1 sm:grid-cols-3">
              <button
                type="button"
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ id: detail.id, status: 'CONFIRMED' })}
                className="flex items-center justify-center gap-2 rounded-lg bg-teal px-3 py-2.5 text-xs font-bold text-white disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" /> Aprobar
              </button>
              <button
                type="button"
                onClick={() => {
                  setDetail(null);
                  router.push(`/reservations/${detail.id}/edit`);
                }}
                className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-800 hover:border-teal"
              >
                <Pencil className="h-4 w-4" /> Modificar
              </button>
              <button
                type="button"
                disabled={statusMutation.isPending}
                onClick={() => {
                  if (window.confirm(`¿Rechazar la solicitud ${detail.code}? Quedará cancelada.`))
                    statusMutation.mutate({ id: detail.id, status: 'CANCELLED' });
                }}
                className="flex items-center justify-center gap-2 rounded-lg border border-rose-200 bg-white px-3 py-2.5 text-xs font-bold text-rose-700 disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" /> Rechazar
              </button>
            </div>
            {Number(detail.paidAmount) > 0 ? (
              <p className="text-[11px] text-slate-500">
                Si la rechazas, recuerda gestionar la devolución del pago con el huésped.
              </p>
            ) : null}
          </div>
        </ActionDialog>,
        document.body,
      ) : null}
    </div>
  );
}

function PaymentChip({ reservation }: { reservation: HotelReservation }) {
  const paid = reservation.paymentStatus === 'PAID';
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-bold',
        paid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
      )}
    >
      {paid ? 'Pagada' : reservation.paymentStatus === 'PARTIAL' ? 'Pago parcial' : 'Pago pendiente'}
    </span>
  );
}

function Info({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Mail;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <p className="mt-1 break-words font-semibold text-slate-900 [overflow-wrap:anywhere]">{children}</p>
    </div>
  );
}

/** Activar o desactivar los avisos push en este teléfono o computadora. */
function PushSettings({ session }: { session: AuthSession }) {
  const [state, setState] = useState<PushState>('checking');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    getPushState()
      .then(setState)
      .catch(() => setState('unsupported'));
  }, []);
  useEffect(refresh, [refresh]);

  const enable = async () => {
    setBusy(true);
    const result = await enablePush(session.tenantId, session.accessToken).catch((error: Error) => ({
      ok: false as const,
      reason: 'failed' as const,
      message: error.message,
    }));
    setBusy(false);
    refresh();
    if (result.ok) {
      toast.success('Notificaciones activadas en este dispositivo');
      return;
    }
    const messages = {
      'not-configured': 'Las notificaciones todavía no están configuradas en el servidor.',
      denied: 'Bloqueaste las notificaciones. Actívalas en la configuración del navegador.',
      dismissed: 'No se activaron las notificaciones.',
      unsupported: 'Este navegador no admite notificaciones push.',
      failed: `No se pudieron activar: ${'message' in result ? result.message : ''}`,
    } as const;
    toast.error(messages[result.reason]);
  };

  return (
    <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 text-xs">
      <p className="flex items-center gap-1.5 font-bold text-slate-800">
        <Smartphone className="h-4 w-4" /> Avisos en este dispositivo
      </p>
      {state === 'active' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-2 py-1 font-bold text-emerald-700">Activados</span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await sendTestPush(session.tenantId, session.accessToken).catch(() => null);
              setBusy(false);
              toast[result?.sent ? 'success' : 'error'](
                result?.sent ? 'Notificación de prueba enviada' : 'No se pudo enviar la prueba',
              );
            }}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-semibold"
          >
            Enviar prueba
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await disablePush(session.tenantId, session.accessToken);
              setBusy(false);
              refresh();
            }}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 font-semibold text-slate-500 hover:text-rose-700"
          >
            <BellOff className="h-3.5 w-3.5" /> Desactivar
          </button>
        </div>
      ) : state === 'inactive' ? (
        <button
          type="button"
          disabled={busy}
          onClick={enable}
          className="mt-2 w-full rounded-lg bg-teal px-3 py-2 font-bold text-white disabled:opacity-50"
        >
          Activar notificaciones
        </button>
      ) : state === 'ios-install' ? (
        <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-slate-600">
          <li>Abre el ERP en Safari.</li>
          <li>
            Toca <strong>Compartir</strong> → <strong>Añadir a pantalla de inicio</strong>.
          </li>
          <li>Abre el ERP desde ese ícono y vuelve aquí para activarlas (iOS 16.4 o superior).</li>
        </ol>
      ) : state === 'denied' ? (
        <p className="mt-1 text-slate-600">
          Están bloqueadas. Permítelas en la configuración del navegador para este sitio.
        </p>
      ) : state === 'unsupported' ? (
        <p className="mt-1 text-slate-600">Este navegador no admite notificaciones push.</p>
      ) : (
        <p className="mt-1 text-slate-500">Verificando…</p>
      )}
    </div>
  );
}

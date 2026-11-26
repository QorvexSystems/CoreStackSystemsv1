'use client';

import { useQuery } from '@tanstack/react-query';
import { BarChart3, BedDouble, CalendarDays, Download, Hotel, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getHotelChannels, getHotelReservations, getHotelRooms } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { ChannelLabel } from './channel-logo';
import { formatMoney, roomStatusLabels } from './hotel-flow';

export function HotelReportsView() {
  const session = getSession();
  const [month, setMonth] = useState(() => monthInputValue(new Date()));
  const reservationsQuery = useQuery({
    queryKey: ['hotel', 'reservations', session?.tenantId],
    queryFn: () => getHotelReservations(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const roomsQuery = useQuery({
    queryKey: ['hotel', 'rooms', session?.tenantId],
    queryFn: () => getHotelRooms(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const channelsQuery = useQuery({
    queryKey: ['hotel', 'channels', session?.tenantId],
    queryFn: () => getHotelChannels(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });

  const reservations = reservationsQuery.data ?? [];
  const rooms = roomsQuery.data ?? [];
  const channels = channelsQuery.data ?? [];
  const period = useMemo(() => monthRange(month), [month]);
  const periodReservations = useMemo(
    () =>
      reservations.filter(
        (reservation) =>
          !['CANCELLED', 'NO_SHOW'].includes(reservation.status) &&
          new Date(reservation.checkIn) < period.end &&
          new Date(reservation.checkOut) > period.start,
      ),
    [period, reservations],
  );
  const payments = periodReservations.flatMap((reservation) =>
    (reservation.payments ?? [])
      .filter((payment) => {
        const createdAt = new Date(payment.createdAt);
        return createdAt >= period.start && createdAt < period.end;
      })
      .map((payment) => ({ payment, reservation })),
  );
  const roomNights = periodReservations
    .filter((reservation) => Boolean(reservation.room))
    .reduce(
      (sum, reservation) =>
        sum + overlapNights(reservation.checkIn, reservation.checkOut, period.start, period.end),
      0,
    );
  const bookedNights = periodReservations.reduce(
    (sum, reservation) =>
      sum + overlapNights(reservation.checkIn, reservation.checkOut, period.start, period.end),
    0,
  );
  const availableRoomNights = rooms.length * period.days;
  const revenue = payments.reduce((sum, item) => sum + Number(item.payment.amount), 0);
  const occupancy = availableRoomNights ? (roomNights / availableRoomNights) * 100 : 0;
  const adr = roomNights ? revenue / roomNights : 0;
  const revPar = availableRoomNights ? revenue / availableRoomNights : 0;
  const arrivals = reservations.filter((reservation) =>
    withinPeriod(reservation.checkIn, period.start, period.end),
  ).length;
  const departures = reservations.filter((reservation) =>
    withinPeriod(reservation.checkOut, period.start, period.end),
  ).length;
  const averageStay = periodReservations.length ? bookedNights / periodReservations.length : 0;
  const channelProduction = channels
    .map((channel) => {
      const channelReservations = periodReservations.filter(
        (reservation) => reservation.channel?.id === channel.id,
      );
      return {
        id: channel.id,
        name: channel.name,
        reservations: channelReservations.length,
        amount: channelReservations.reduce(
          (sum, reservation) => sum + Number(reservation.totalAmount),
          0,
        ),
      };
    })
    .sort((first, second) => second.amount - first.amount);
  const maxChannelAmount = Math.max(1, ...channelProduction.map((item) => item.amount));
  const weeklyRevenue = Array.from({ length: Math.ceil(period.days / 7) }, (_, index) => {
    const firstDay = index * 7 + 1;
    const lastDay = Math.min(period.days, firstDay + 6);
    const amount = payments
      .filter(({ payment }) => {
        const day = new Date(payment.createdAt).getDate();
        return day >= firstDay && day <= lastDay;
      })
      .reduce((sum, item) => sum + Number(item.payment.amount), 0);
    return { label: `${firstDay}–${lastDay}`, amount };
  });
  const maxWeeklyRevenue = Math.max(1, ...weeklyRevenue.map((item) => item.amount));
  const loading = reservationsQuery.isLoading || roomsQuery.isLoading || channelsQuery.isLoading;
  const error = reservationsQuery.error || roomsQuery.error || channelsQuery.error;

  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold text-teal">Inteligencia operativa</p>
          <h1 className="mt-1 text-2xl font-extrabold text-slate-950">Reportes</h1>
          <p className="mt-1 text-sm text-slate-500">
            Ocupación, ingresos, estadías y rendimiento calculados con datos reales.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600">
            <CalendarDays className="h-4 w-4 text-teal" />
            Periodo
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              className="bg-transparent font-bold text-slate-950 outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => exportReservationsCsv(periodReservations, month)}
            disabled={!periodReservations.length}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-teal px-4 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            <Download className="h-4 w-4" /> Exportar CSV
          </button>
        </div>
      </header>

      {loading ? <ReportMessage text="Calculando reportes..." /> : null}
      {error ? <ReportMessage text={(error as Error).message} error /> : null}
      {!loading && !error ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ReportKpi
              label="Ocupación"
              value={`${occupancy.toFixed(1)}%`}
              detail={`${roomNights} noches asignadas de ${availableRoomNights}`}
              icon={Hotel}
            />
            <ReportKpi
              label="ADR"
              value={formatMoney(adr)}
              detail="Ingreso promedio por noche ocupada"
              icon={TrendingUp}
            />
            <ReportKpi
              label="RevPAR"
              value={formatMoney(revPar)}
              detail="Ingreso por habitación disponible"
              icon={BedDouble}
            />
            <ReportKpi
              label="Ingresos cobrados"
              value={formatMoney(revenue)}
              detail={`${payments.length} comprobantes emitidos`}
              icon={BarChart3}
            />
          </section>

          <section className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div>
                <h2 className="text-sm font-extrabold">Producción por canal</h2>
                <p className="text-xs text-slate-500">Reservaciones y monto contratado.</p>
              </div>
              <div className="mt-4 space-y-3">
                {channelProduction.map((item) => (
                  <div key={item.id}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <ChannelLabel name={item.name} />
                      <span className="text-right">
                        <strong className="block">{formatMoney(item.amount)}</strong>
                        <span className="text-[10px] text-slate-400">
                          {item.reservations} {item.reservations === 1 ? 'reserva' : 'reservas'}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-teal"
                        style={{ width: `${(item.amount / maxChannelAmount) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-extrabold">Ingresos por semana del mes</h2>
              <p className="text-xs text-slate-500">Pagos efectivamente registrados.</p>
              <div className="mt-4 space-y-3">
                {weeklyRevenue.map((item, index) => (
                  <div
                    key={item.label}
                    className="grid grid-cols-[4.5rem_1fr_7rem] items-center gap-3 text-xs"
                  >
                    <span className="text-slate-500">Semana {index + 1}</span>
                    <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-emerald-500"
                        style={{ width: `${(item.amount / maxWeeklyRevenue) * 100}%` }}
                      />
                    </div>
                    <strong className="text-right">{formatMoney(item.amount)}</strong>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="grid gap-3 lg:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-extrabold">Movimiento del periodo</h2>
              <div className="mt-3 grid grid-cols-3 divide-x divide-slate-200 rounded-xl bg-slate-50 p-4 text-center">
                <SmallMetric label="Llegadas" value={String(arrivals)} />
                <SmallMetric label="Salidas" value={String(departures)} />
                <SmallMetric label="Estadía promedio" value={`${averageStay.toFixed(1)} noches`} />
              </div>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-extrabold">Estado actual de habitaciones</h2>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(
                  rooms.reduce<Record<string, number>>((summary, room) => {
                    summary[room.status] = (summary[room.status] ?? 0) + 1;
                    return summary;
                  }, {}),
                ).map(([status, count]) => (
                  <div key={status} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <p className="text-[10px] text-slate-500">
                      {roomStatusLabels[status] ?? status}
                    </p>
                    <p className="mt-1 text-xl font-extrabold">{count}</p>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}

function ReportKpi({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Hotel;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-extrabold text-slate-950">{value}</p>
        </div>
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal-light text-teal-deep">
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">{detail}</p>
    </article>
  );
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-extrabold text-slate-950">{value}</p>
    </div>
  );
}

function ReportMessage({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <div
      className={`rounded-xl border bg-white p-8 text-center text-sm ${error ? 'text-rose-600' : 'text-slate-500'}`}
    >
      {text}
    </div>
  );
}

function monthInputValue(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(value: string) {
  const [year, month] = value.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start, end, days: new Date(year, month, 0).getDate() };
}

function overlapNights(checkIn: string, checkOut: string, start: Date, end: Date) {
  const overlapStart = Math.max(+new Date(checkIn), +start);
  const overlapEnd = Math.min(+new Date(checkOut), +end);
  return overlapEnd > overlapStart
    ? Math.max(1, Math.ceil((overlapEnd - overlapStart) / 86_400_000))
    : 0;
}

function withinPeriod(value: string, start: Date, end: Date) {
  const date = new Date(value);
  return date >= start && date < end;
}

function exportReservationsCsv(
  reservations: Awaited<ReturnType<typeof getHotelReservations>>,
  month: string,
) {
  const rows = [
    [
      'Reserva',
      'Huésped',
      'Habitación',
      'Tipo',
      'Canal',
      'Llegada',
      'Salida',
      'Total',
      'Pagado',
      'Estado',
    ],
    ...reservations.map((reservation) => [
      reservation.code,
      `${reservation.guest.firstName} ${reservation.guest.lastName}`,
      reservation.room?.number ?? '',
      reservation.roomType.name,
      reservation.channel?.name ?? '',
      reservation.checkIn,
      reservation.checkOut,
      reservation.totalAmount,
      reservation.paidAmount,
      reservation.status,
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `reporte-hotel-ancla-${month}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

'use client';

import { useQuery } from '@tanstack/react-query';
import {
  BedDouble,
  BellRing,
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  LogOut,
  RefreshCw,
  SprayCan,
} from 'lucide-react';
import Link from 'next/link';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getHotelDashboardOverview, type HotelDashboardOverview } from '@/lib/api';
import { getSession } from '@/lib/auth-session';

const money = (value: number) =>
  `RD$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
const percent = (value: number, total: number) => (total ? `${Math.round((value / total) * 100)}%` : '0%');
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const channelColors: [RegExp, string][] = [
  [/web/i, 'bg-teal'],
  [/whatsapp/i, 'bg-emerald-500'],
  [/booking/i, 'bg-blue-500'],
  [/expedia/i, 'bg-amber-400'],
  [/airbnb/i, 'bg-rose-400'],
  [/interno|walk/i, 'bg-slate-400'],
];
const channelColor = (name: string) => channelColors.find(([match]) => match.test(name))?.[1] ?? 'bg-violet-400';

export function DashboardView() {
  const session = getSession();
  const firstName = session?.user.name.split(' ')[0] || 'Ancla';
  const overview = useQuery({
    queryKey: ['hotel', 'dashboard', 'overview', session?.tenantId],
    queryFn: () => getHotelDashboardOverview(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
    refetchInterval: 60_000,
  });
  const data = overview.data;
  const updatedAt = overview.dataUpdatedAt ? new Date(overview.dataUpdatedAt) : new Date();

  return (
    <div className="space-y-3.5 pb-5">
      <section className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm lg:flex-row lg:items-center">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold text-teal">
            <span className="h-2 w-2 rounded-full bg-teal" /> Vista general
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-950 sm:text-[2rem]">
            {getGreeting()}, {firstName}.
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Aquí tienes lo más importante del hotel para tomar decisiones hoy.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DateCard updatedAt={updatedAt} />
          <button
            type="button"
            onClick={() => overview.refetch()}
            disabled={overview.isFetching}
            className="flex min-h-12 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <RefreshCw className={`h-4 w-4 ${overview.isFetching ? 'animate-spin' : ''}`} /> Actualizar
          </button>
        </div>
      </section>

      {overview.error ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          No se pudo cargar el panel: {(overview.error as Error).message}
        </p>
      ) : null}

      {!data ? (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white" />
          ))}
        </section>
      ) : (
        <Panel data={data} />
      )}
    </div>
  );
}

function Panel({ data }: { data: HotelDashboardOverview }) {
  const { rooms, priorities } = data;
  const thisMonth = data.performance[data.performance.length - 1];

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          title="Facturación del mes"
          value={money(data.revenue.month)}
          detail={`Hoy: ${money(data.revenue.today)}`}
          icon={CircleDollarSign}
        />
        <Metric
          title="Reservaciones para hoy"
          value={String(data.reservationsToday.total)}
          detail={`${plural(data.reservationsToday.arrivalsPending, 'check-in pendiente', 'check-ins pendientes')} · ${plural(data.reservationsToday.inHouse, 'huésped alojado', 'huéspedes alojados')}`}
          icon={CalendarDays}
        />
        <Metric
          title="Cobros pendientes"
          value={money(data.pendingPayments.amount)}
          detail={plural(data.pendingPayments.count, 'reserva con balance', 'reservas con balance')}
          icon={CircleDollarSign}
        />
        <Metric
          title="Disponibles esta noche"
          value={String(rooms.freeTonight)}
          detail={`de ${rooms.total} habitaciones`}
          icon={BedDouble}
        />
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1.85fr)_minmax(20rem,1fr)]">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.18em] text-teal">Rendimiento</p>
              <h2 className="mt-1 text-base font-bold text-slate-900">Ingresos y ocupación</h2>
              <p className="text-xs text-slate-500">
                Últimos seis meses. Cobros registrados en RD$ y porcentaje de ocupación.
              </p>
            </div>
            <div className="rounded-lg bg-teal-light px-4 py-2 text-right">
              <p className="text-[10px] text-teal-deep">Este mes · {thisMonth?.occupancy ?? 0}% ocupación</p>
              <p className="text-sm font-bold text-teal-deep">{money(data.revenue.month)}</p>
            </div>
          </div>
          <div className="mt-4 h-[15rem] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.performance} margin={{ left: 2, right: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e8edef" />
                <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis
                  yAxisId="revenue"
                  tickFormatter={(value) => `RD$${Math.round(Number(value) / 1000)}k`}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                  fontSize={10}
                />
                <YAxis
                  yAxisId="occupancy"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(value) => `${value}%`}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  fontSize={10}
                />
                <Tooltip
                  formatter={(value, name) =>
                    name === 'Ocupación' ? `${value}%` : money(Number(value))
                  }
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="revenue" dataKey="revenue" name="Ingresos" fill="#79d4c6" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false} />
                <Line
                  yAxisId="occupancy"
                  type="monotone"
                  dataKey="occupancy"
                  name="Ocupación"
                  stroke="#0c5f5c"
                  strokeWidth={2.5}
                  dot={{ fill: '#0c5f5c', r: 3.5 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-amber-500">Prioridades</p>
          <div className="mt-3 space-y-2">
            {priorities.webRequests ? (
              <Priority
                icon={BellRing}
                tone="sky"
                title={plural(priorities.webRequests, 'solicitud web por aprobar', 'solicitudes web por aprobar')}
                detail="Llegaron desde el sitio web y esperan tu revisión"
                href="/reservations"
              />
            ) : null}
            {priorities.arrivalsPending ? (
              <Priority
                icon={CalendarCheck2}
                tone="rose"
                title={`Check-in de hoy: ${plural(priorities.arrivalsPending, 'pendiente', 'pendientes')}`}
                detail={
                  priorities.arrivalsWithoutRoom
                    ? `${plural(priorities.arrivalsWithoutRoom, 'llegada sin habitación asignada', 'llegadas sin habitación asignada')}`
                    : 'Revisar llegadas y preparar habitaciones'
                }
                href="/check-in-out"
              />
            ) : null}
            {priorities.departuresPending ? (
              <Priority
                icon={LogOut}
                tone="amber"
                title={`Check-out de hoy: ${plural(priorities.departuresPending, 'pendiente', 'pendientes')}`}
                detail="Huéspedes con salida programada para hoy o vencida"
                href="/check-in-out"
              />
            ) : null}
            {priorities.paymentsPending ? (
              <Priority
                icon={CircleDollarSign}
                tone="amber"
                title={plural(priorities.paymentsPending, 'cobro requiere seguimiento', 'cobros requieren seguimiento')}
                detail={
                  priorities.topPayment
                    ? `Mayor balance: ${priorities.topPayment.code} · ${money(priorities.topPayment.balance)}`
                    : 'Reservas con balance pendiente'
                }
                href="/reservations"
              />
            ) : null}
            {priorities.roomsToClean.length ? (
              <Priority
                icon={SprayCan}
                tone="sky"
                title={plural(priorities.roomsToClean.length, 'habitación pendiente de limpieza', 'habitaciones pendientes de limpieza')}
                detail={`Habitaciones ${priorities.roomsToClean.join(', ')}`}
                href="/housekeeping"
              />
            ) : null}
            {!priorities.webRequests &&
            !priorities.arrivalsPending &&
            !priorities.departuresPending &&
            !priorities.paymentsPending &&
            !priorities.roomsToClean.length ? (
              <Priority
                icon={CheckCircle2}
                tone="emerald"
                title="Todo al día"
                detail="No hay llegadas, cobros ni limpiezas pendientes"
                href="/reservations"
              />
            ) : null}
          </div>
        </article>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-bold">Canales de reservación</h2>
          <p className="mb-3 text-xs text-slate-500">Reservas creadas este mes por canal.</p>
          <div className="space-y-2.5">
            {data.channels.map((channel) => (
              <div key={channel.name} className="grid grid-cols-[1fr_2rem_5.5rem_2.5rem] items-center gap-2 text-xs">
                <span className="truncate font-medium">{channel.name}</span>
                <span>{channel.total}</span>
                <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <span className={`block h-full rounded-full ${channelColor(channel.name)}`} style={{ width: `${channel.share}%` }} />
                </span>
                <span className="text-slate-500">{channel.share}%</span>
              </div>
            ))}
            {!data.channels.length ? <Empty text="Sin reservas este mes." /> : null}
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-bold">Estado de habitaciones</h2>
          <p className="mb-3 text-xs text-slate-500">Vista actual de las {rooms.total} habitaciones.</p>
          <RoomState label="Ocupadas" value={rooms.occupied} total={rooms.total} color="bg-teal-light text-teal-deep" />
          <RoomState label="Libres" value={rooms.available} total={rooms.total} color="bg-emerald-50 text-emerald-700" />
          <RoomState label="Reservadas" value={rooms.reserved} total={rooms.total} color="bg-sky-50 text-sky-700" />
          <RoomState label="Limpieza" value={rooms.cleaning} total={rooms.total} color="bg-orange-50 text-orange-700" />
          <RoomState label="Fuera de servicio" value={rooms.outOfService} total={rooms.total} color="bg-slate-100 text-slate-600" />
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex justify-between">
            <div>
              <h2 className="text-sm font-bold">Próximas llegadas</h2>
              <p className="text-xs text-slate-500">Check-ins pendientes de hoy.</p>
            </div>
            <Link href="/check-in-out" className="text-xs font-medium text-teal">
              Ver todas
            </Link>
          </div>
          {data.arrivals.map((arrival) => (
            <Arrival
              key={arrival.id}
              initials={initials(arrival.guest)}
              name={arrival.guest}
              detail={`${plural(arrival.adults, 'adulto', 'adultos')}${arrival.children ? `, ${plural(arrival.children, 'niño', 'niños')}` : ''} · ${arrival.roomType}`}
              time={arrival.arrivalTime ? formatArrival(arrival.arrivalTime) : formatTime(arrival.checkIn)}
              room={arrival.room ? `Hab. ${arrival.room}` : 'Sin asignar'}
            />
          ))}
          {!data.arrivals.length ? <Empty text="No hay llegadas pendientes hoy." /> : null}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex justify-between">
            <div>
              <h2 className="text-sm font-bold">Alertas de cobro</h2>
              <p className="text-xs text-slate-500">Reservas con balance pendiente.</p>
            </div>
            <Link href="/reservations" className="text-xs font-medium text-teal">
              Ver todas
            </Link>
          </div>
          {data.pendingPayments.top.map((item) => (
            <PaymentAlert key={item.id} name={item.guest} reservation={`Reserva ${item.code}`} total={money(item.balance)} />
          ))}
          {!data.pendingPayments.top.length ? <Empty text="No hay balances pendientes." /> : null}
        </article>
      </section>
    </>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    timeZone: 'America/Santo_Domingo',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

/** "18:00" → "6:00 p. m." (hora estimada que dejó el huésped). */
function formatArrival(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return value;
  const date = new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])));
  return new Intl.DateTimeFormat('es-DO', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(date);
}

function Empty({ text }: { text: string }) {
  return <p className="mt-4 rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">{text}</p>;
}

function Metric({ title, value, detail, icon: Icon }: { title: string; value: string; detail: string; icon: typeof BedDouble }) {
  return (
    <article className="flex min-h-[7rem] items-start justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-sm text-slate-500">{title}</p>
        <p className="mt-1 text-2xl font-extrabold tracking-tight text-slate-950">{value}</p>
        <p className="mt-1 text-xs text-slate-500">{detail}</p>
      </div>
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-teal-light text-teal-deep">
        <Icon className="h-5 w-5" />
      </span>
    </article>
  );
}

function DateCard({ updatedAt }: { updatedAt: Date }) {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 shadow-sm">
      <CalendarDays className="h-4 w-4 text-teal" />
      <div>
        <p className="text-xs font-semibold first-letter:uppercase">
          {new Intl.DateTimeFormat('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(updatedAt)}
        </p>
        <p className="text-[10px] text-slate-400">
          Actualizado {updatedAt.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </div>
  );
}

function Priority({ icon: Icon, tone, title, detail, href }: { icon: typeof BedDouble; tone: string; title: string; detail: string; href: string }) {
  const tones: Record<string, string> = {
    rose: 'bg-rose-50 text-rose-500',
    amber: 'bg-amber-50 text-amber-600',
    sky: 'bg-sky-50 text-sky-500',
    emerald: 'bg-emerald-50 text-emerald-600',
  };
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 transition hover:border-teal/40 hover:bg-slate-50">
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${tones[tone]}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-slate-800">{title}</span>
        <span className="block truncate text-[11px] text-slate-500">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 text-slate-400" />
    </Link>
  );
}

function RoomState({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  return (
    <div className="grid grid-cols-[1fr_2rem_3rem] items-center gap-2 py-1.5 text-xs">
      <span className="font-medium text-slate-700">{label}</span>
      <span className="font-bold">{value}</span>
      <span className={`rounded px-1.5 py-1 text-center font-semibold ${color}`}>{percent(value, total)}</span>
    </div>
  );
}

function Arrival({ initials, name, detail, time, room }: { initials: string; name: string; detail: string; time: string; room: string }) {
  return (
    <div className="mt-3 flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-[10px] font-bold text-stone-600">{initials}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-bold">{name}</span>
        <span className="block truncate text-[10px] text-slate-500">{detail}</span>
      </span>
      <span className="text-right">
        <span className="block text-[10px] font-semibold">{time}</span>
        <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[9px] text-stone-500">{room}</span>
      </span>
    </div>
  );
}

function PaymentAlert({ name, reservation, total }: { name: string; reservation: string; total: string }) {
  return (
    <div className="mt-4 flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-500">
        <CircleDollarSign className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-bold">{name}</span>
        <span className="block text-[10px] text-slate-500">{reservation}</span>
      </span>
      <span className="text-[11px] font-bold text-rose-500">{total}</span>
    </div>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
}

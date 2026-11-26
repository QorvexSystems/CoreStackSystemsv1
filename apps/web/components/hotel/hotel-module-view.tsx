'use client';

import { useQuery } from '@tanstack/react-query';
import {
  BedDouble,
  CalendarCheck2,
  CircleDollarSign,
  FileBarChart,
  Plus,
  RadioTower,
  Search,
  Users,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { toast } from 'sonner';
import {
  getHotelChannels,
  getHotelReservations,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { ChannelLogo } from './channel-logo';
import { formatMoney } from './hotel-flow';
import { GuestsView } from './guests-view';

type Module = 'check-in-out' | 'rooms' | 'guests' | 'channels' | 'reports';

const rooms = [
  ['101', 'Deluxe King', 'Ocupada', 'María González', 'bg-teal-light text-teal-deep'],
  ['102', 'Standard', 'Limpieza', 'Salida 11:00 a. m.', 'bg-amber-50 text-amber-700'],
  ['103', 'Standard', 'Disponible', 'Lista para asignar', 'bg-emerald-50 text-emerald-700'],
  ['104', 'Suite Junior', 'Ocupada', 'John Smith', 'bg-teal-light text-teal-deep'],
  ['201', 'Deluxe King', 'Disponible', 'Lista para asignar', 'bg-emerald-50 text-emerald-700'],
  ['202', 'Standard', 'Reservada', 'Llegada 3:00 p. m.', 'bg-sky-50 text-sky-700'],
  ['203', 'Suite Junior', 'Ocupada', 'Luis Herrera', 'bg-teal-light text-teal-deep'],
  ['204', 'Standard', 'Limpieza', 'Prioridad alta', 'bg-amber-50 text-amber-700'],
  ['205', 'Deluxe King', 'Reservada', 'Llegada 4:30 p. m.', 'bg-sky-50 text-sky-700'],
  ['301', 'Suite Junior', 'Disponible', 'Lista para asignar', 'bg-emerald-50 text-emerald-700'],
  ['302', 'Standard', 'Fuera de servicio', 'Mantenimiento A/C', 'bg-rose-50 text-rose-700'],
  ['303', 'Deluxe King', 'Reservada', 'Llegada 6:00 p. m.', 'bg-sky-50 text-sky-700'],
];

const content = {
  'check-in-out': {
    eyebrow: 'Operación de recepción',
    title: 'Check-in / Check-out',
    description:
      'Gestiona las llegadas y salidas del día, documentos, depósitos y entrega de llaves.',
    icon: CalendarCheck2,
  },
  rooms: {
    eyebrow: 'Inventario hotelero',
    title: 'Habitaciones',
    description: 'Disponibilidad, limpieza, mantenimiento y ocupación en una sola vista.',
    icon: BedDouble,
  },
  guests: {
    eyebrow: 'CRM hotelero',
    title: 'Huéspedes',
    description: 'Historial de estadías, preferencias, documentos y datos de contacto.',
    icon: Users,
  },
  channels: {
    eyebrow: 'Distribución',
    title: 'Canales',
    description: 'Reservaciones y montos reales por cada canal de venta.',
    icon: RadioTower,
  },
  reports: {
    eyebrow: 'Inteligencia operativa',
    title: 'Reportes',
    description: 'Ocupación, ADR, RevPAR, ingresos y rendimiento por canal.',
    icon: FileBarChart,
  },
} as const;

export function HotelModuleView({ module }: { module: Module }) {
  const meta = content[module];
  const Icon = meta.icon;
  const router = useRouter();
  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold text-teal">{meta.eyebrow}</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-950">
            {meta.title}
          </h1>
          <p className="mt-1 text-sm text-slate-500">{meta.description}</p>
        </div>
        {module === 'channels' ? null : (
        <button
          type="button"
          onClick={() =>
            module === 'guests'
              ? router.push('/reservations?new=1')
              : toast.success(`Nueva acción en ${meta.title}`)
          }
          className="flex items-center justify-center gap-2 rounded-lg bg-teal px-4 py-2.5 text-sm font-semibold text-white"
        >
          <Plus className="h-4 w-4" />
          {module === 'guests' ? 'Nueva reservación' : 'Nueva acción'}
        </button>
        )}
      </header>
      {module === 'rooms' ? (
        <Rooms />
      ) : module === 'check-in-out' ? (
        <CheckInOut />
      ) : module === 'guests' ? (
        <GuestsView />
      ) : module === 'channels' ? (
        <Channels />
      ) : (
        <Reports />
      )}
    </div>
  );
}

function Rooms() {
  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Ocupadas" value="12" detail="50% del inventario" />
        <Kpi label="Disponibles" value="8" detail="33% del inventario" />
        <Kpi label="En limpieza" value="3" detail="2 con prioridad alta" />
        <Kpi label="Fuera de servicio" value="1" detail="Mantenimiento activo" />
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">Mapa de habitaciones</h2>
            <p className="text-xs text-slate-500">Estado operativo actualizado.</p>
          </div>
          <SearchBox placeholder="Buscar habitación..." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rooms.map(([number, type, status, detail, tone]) => (
            <button
              type="button"
              key={number}
              onClick={() => toast.info(`Habitación ${number}: ${status}`)}
              className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-teal/40"
            >
              <div className="flex items-start justify-between">
                <span className="text-xl font-extrabold">{number}</span>
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${tone}`}>
                  {status}
                </span>
              </div>
              <p className="mt-3 text-xs font-semibold">{type}</p>
              <p className="mt-1 text-[11px] text-slate-500">{detail}</p>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
function CheckInOut() {
  const arrivals = [
    ['Laura Contreras', 'AN-10284', '3:00 p. m.', 'Hab. 101', 'Documentos pendientes'],
    ['Miguel Ramírez', 'AN-10291', '4:30 p. m.', 'Hab. 205', 'Lista para check-in'],
    ['Valentina Soto', 'AN-10294', '6:00 p. m.', 'Hab. 303', 'Pago pendiente'],
  ];
  return (
    <section className="grid gap-3 xl:grid-cols-2">
      <OperationList
        title="Llegadas de hoy"
        subtitle="14 reservaciones · 3 pendientes"
        rows={arrivals}
        action="Registrar check-in"
      />
      <OperationList
        title="Salidas de hoy"
        subtitle="9 habitaciones · 2 pendientes"
        rows={[
          ['Carlos Méndez', 'AN-10220', '11:00 a. m.', 'Hab. 102', 'Balance RD$0.00'],
          ['Ana Torres', 'AN-10224', '12:00 p. m.', 'Hab. 204', 'Balance RD$3,500.00'],
          ['David Chen', 'AN-10231', '1:00 p. m.', 'Hab. 305', 'Revisión de minibar'],
        ]}
        action="Registrar check-out"
      />
    </section>
  );
}
function OperationList({
  title,
  subtitle,
  rows,
  action,
}: {
  title: string;
  subtitle: string;
  rows: string[][];
  action: string;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold">{title}</h2>
      <p className="text-xs text-slate-500">{subtitle}</p>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div
            key={row[1]}
            className="flex flex-col gap-3 rounded-lg border border-slate-100 p-3 sm:flex-row sm:items-center"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-light text-xs font-bold text-teal-deep">
              {row[0]
                .split(' ')
                .map((p) => p[0])
                .join('')
                .slice(0, 2)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold">
                {row[0]} · {row[1]}
              </span>
              <span className="block text-[11px] text-slate-500">
                {row[2]} · {row[3]} · {row[4]}
              </span>
            </span>
            <button
              onClick={() => toast.success(`${action}: ${row[0]}`)}
              className="rounded-lg border border-teal px-3 py-2 text-[11px] font-semibold text-teal-deep"
            >
              {action}
            </button>
          </div>
        ))}
      </div>
    </article>
  );
}
/** Canales con datos reales: reservaciones y montos registrados en el sistema por cada canal. */
function Channels() {
  const session = getSession();
  const auth = session ? ([session.tenantId, session.accessToken] as const) : null;
  const channelsQuery = useQuery({
    queryKey: ['hotel', 'channels', session?.tenantId],
    queryFn: () => getHotelChannels(auth![0], auth![1]),
    enabled: Boolean(auth),
  });
  const reservationsQuery = useQuery({
    queryKey: ['hotel', 'reservations', session?.tenantId],
    queryFn: () => getHotelReservations(auth![0], auth![1]),
    enabled: Boolean(auth),
  });
  const currentMonth = monthOf(new Date());

  const rows = useMemo(() => {
    const reservations = reservationsQuery.data ?? [];
    return (channelsQuery.data ?? [])
      .map((channel) => {
        const own = reservations.filter((item) => item.channel?.id === channel.id);
        const valid = own.filter((item) => !['CANCELLED', 'NO_SHOW'].includes(item.status));
        const latest = [...own].sort((a, b) => +new Date(b.checkIn) - +new Date(a.checkIn))[0];
        return {
          channel,
          total: valid.length,
          thisMonth: valid.filter((item) => monthOf(item.checkIn) === currentMonth).length,
          revenue: valid.reduce((sum, item) => sum + Number(item.totalAmount), 0),
          paid: valid.reduce((sum, item) => sum + Number(item.paidAmount), 0),
          upcoming: valid.filter((item) => ['PENDING_REVIEW', 'CONFIRMED', 'ASSIGNED'].includes(item.status)).length,
          pending: own.filter((item) => item.status === 'PENDING_REVIEW').length,
          cancelled: own.length - valid.length,
          latest,
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [channelsQuery.data, reservationsQuery.data, currentMonth]);

  if (channelsQuery.isLoading || reservationsQuery.isLoading)
    return <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Cargando canales…</div>;
  const error = channelsQuery.error ?? reservationsQuery.error;
  if (error)
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{(error as Error).message}</div>;

  const totalReservations = rows.reduce((sum, row) => sum + row.total, 0);
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const connection = (type: string) =>
    type === 'DIRECT_WEB'
      ? { label: 'Conectado al sitio web', tone: 'bg-emerald-50 text-emerald-700' }
      : type === 'WALK_IN'
        ? { label: 'Recepción', tone: 'bg-slate-100 text-slate-700' }
        : { label: 'Registro manual', tone: 'bg-amber-50 text-amber-800' };

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Reservaciones (todas las fechas)" value={String(totalReservations)} detail="Sin canceladas ni no-show" />
        <Kpi label="Monto reservado" value={formatMoney(totalRevenue)} detail="Total de las reservaciones válidas" />
        <Kpi
          label="Canales activos"
          value={String(rows.filter((row) => row.channel.active).length)}
          detail={`${rows.filter((row) => row.total > 0).length} con reservaciones`}
        />
      </section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => {
          const share = totalReservations ? Math.round((row.total / totalReservations) * 100) : 0;
          const status = connection(row.channel.type);
          return (
            <article key={row.channel.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <ChannelLogo name={row.channel.name} size="lg" />
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${row.channel.active ? status.tone : 'bg-slate-100 text-slate-500'}`}
                >
                  {row.channel.active ? status.label : 'Inactivo'}
                </span>
              </div>
              <h2 className="mt-3 text-lg font-bold">{row.channel.name}</h2>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-slate-50 p-2.5">
                  <p className="text-[11px] text-slate-500">Reservaciones</p>
                  <p className="text-xl font-extrabold tabular-nums">{row.total}</p>
                </div>
                <div className="rounded-lg bg-slate-50 p-2.5">
                  <p className="text-[11px] text-slate-500">Monto</p>
                  <p className="truncate text-base font-extrabold tabular-nums">{formatMoney(row.revenue)}</p>
                </div>
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>Participación</span>
                  <span className="font-bold text-slate-700">{share}%</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-teal" style={{ width: `${share}%` }} />
                </div>
              </div>
              <dl className="mt-3 space-y-1 text-xs text-slate-600">
                <ChannelFact label="Llegadas este mes" value={String(row.thisMonth)} />
                <ChannelFact label="Próximas (sin check-in)" value={String(row.upcoming)} />
                <ChannelFact label="Cobrado" value={formatMoney(row.paid)} />
                {row.pending ? <ChannelFact label="Solicitudes pendientes" value={String(row.pending)} warn /> : null}
                {row.cancelled ? <ChannelFact label="Canceladas / no-show" value={String(row.cancelled)} /> : null}
                <ChannelFact
                  label="Última reservación"
                  value={row.latest ? `${row.latest.code} · ${row.latest.guest.firstName} ${row.latest.guest.lastName}` : '—'}
                />
              </dl>
            </article>
          );
        })}
      </section>
      <p className="text-xs text-slate-500">
        El sitio web envía sus reservaciones al sistema automáticamente. Booking.com, Expedia, Airbnb y WhatsApp aún no
        tienen conexión directa: sus reservaciones se registran en recepción eligiendo ese canal.
      </p>
    </>
  );
}

function ChannelFact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${warn ? 'text-amber-800' : ''}`}>
      <dt>{label}</dt>
      <dd className="truncate text-right font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

function monthOf(value: string | Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit' })
    .format(new Date(value))
    .slice(0, 7);
}
function Reports() {
  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Ocupación" value="77%" detail="+6% vs. mes anterior" />
        <Kpi label="ADR" value="RD$6,840" detail="Tarifa diaria promedio" />
        <Kpi label="RevPAR" value="RD$5,267" detail="Ingreso por habitación" />
        <Kpi label="Ingresos" value="RD$184,750" detail="Mes en curso" />
      </section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[
          'Informe de ocupación',
          'Producción por canal',
          'Ingresos y cobros',
          'Llegadas y salidas',
          'Estadía promedio',
          'Rendimiento de habitaciones',
        ].map((title) => (
          <button
            key={title}
            onClick={() => toast.success(`Preparando ${title}`)}
            className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-teal/40"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-light text-teal-deep">
              <FileBarChart className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-bold">{title}</span>
              <span className="text-xs text-slate-500">Ver y exportar reporte</span>
            </span>
          </button>
        ))}
      </section>
    </>
  );
}
function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
      <p className="mt-1 text-[11px] text-slate-500">{detail}</p>
    </article>
  );
}
function SearchBox({ placeholder }: { placeholder: string }) {
  return (
    <label className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        className="h-9 rounded-lg border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-teal"
        placeholder={placeholder}
      />
    </label>
  );
}

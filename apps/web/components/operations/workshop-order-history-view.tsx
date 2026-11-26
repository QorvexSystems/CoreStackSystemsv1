'use client';

import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Search, Wrench, X } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getWorkshopTickets, getWorkshopVehicles, getWorkshopVehicleHistory, type WorkshopTicket } from '@/lib/api';
import type { AuthSession } from '@/lib/auth-session';

const labels: Record<string, string> = {
  RECEIVED: 'Recibida',
  DIAGNOSIS: 'Diagnóstico',
  AWAITING_APPROVAL: 'Esperando aprobación',
  APPROVED: 'Aprobada',
  IN_PROGRESS: 'En reparación',
  READY_FOR_DELIVERY: 'Lista para entrega',
  DELIVERED: 'Entregada',
  CANCELLED: 'Cancelada',
};

export function WorkshopOrderHistoryView({ session }: { session: AuthSession }) {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<WorkshopTicket | null>(null);
  const tickets = useQuery({
    queryKey: ['workshop-tickets', session.tenantId],
    queryFn: () => getWorkshopTickets(session.tenantId, session.accessToken),
  });
  const vehiclesQuery = useQuery({
    queryKey: ['workshop-vehicles', session.tenantId],
    queryFn: () => getWorkshopVehicles(session.tenantId, session.accessToken),
  });
  const visibleVehicles = (vehiclesQuery.data ?? []).filter((vehicle) =>
    `${vehicle.customer.name} ${vehicle.customer.phone ?? ''} ${vehicle.licensePlate ?? ''} ${vehicle.make} ${vehicle.model}`.toLowerCase().includes(search.trim().toLowerCase()) ||
    filteredTicketMatches(vehicle.id),
  );
  function filteredTicketMatches(vehicleId: string) {
    return (tickets.data ?? []).some((ticket) => ticket.vehicle.id === vehicleId && ticket.ticketNumber.toLowerCase().includes(search.trim().toLowerCase()));
  }
  useEffect(() => {
    const ticketId = searchParams.get('ticket');
    if (!ticketId) return;
    const ticket = tickets.data?.find((item) => item.id === ticketId);
    if (ticket) setSelected(ticket);
  }, [searchParams, tickets.data]);
  const history = useQuery({
    queryKey: ['workshop-vehicle-history', session.tenantId, selected?.vehicle.id],
    queryFn: () =>
      getWorkshopVehicleHistory(session.tenantId, session.accessToken, selected!.vehicle.id),
    enabled: Boolean(selected),
  });
  useEffect(() => {
    if (!selected) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [selected?.id]);
  const customerTickets = selected
    ? (tickets.data ?? []).filter((ticket) => ticket.customer.id === selected.customer.id)
    : [];
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" aria-label="Volver a Agenda">
            <Link href="/workshop/agenda">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Historial</h1>
            <p className="text-sm text-muted-foreground">
              Consulta las órdenes y el historial del cliente y su vehículo.
            </p>
          </div>
        </div>
        <Button asChild>
          <Link href="/workshop/agenda">Volver a Agenda</Link>
        </Button>
      </div>
      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          className="h-11 pl-10"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar por OT, placa, vehículo, cliente o teléfono"
        />
      </div>
      <div className="space-y-4">
        {Array.from(new Map(visibleVehicles.map((vehicle) => [vehicle.customer.id, vehicle.customer])).values()).map((customer) => {
          const orders = (tickets.data ?? []).filter((ticket) => ticket.customer.id === customer.id);
          const vehicles = visibleVehicles.filter((vehicle) => vehicle.customer.id === customer.id);
          return (
            <section key={customer.id} className="rounded-2xl border bg-white p-4 sm:p-5">
              <h2 className="text-xl font-bold">{customer.name}</h2>
              <p className="text-sm text-muted-foreground">{customer.phone ?? 'Sin teléfono'} · {vehicles.length} vehículo(s) · {orders.length} orden(es)</p>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {vehicles.map((vehicle) => (
                  <div key={vehicle.id} className="rounded-xl border p-4">
                    <h3 className="font-bold">{vehicle.licensePlate ?? 'SIN PLACA'} · {vehicle.make} {vehicle.model} {vehicle.year ?? ''}</h3>
                    <div className="mt-3 space-y-2">
                      {orders.filter((ticket) => ticket.vehicle.id === vehicle.id).sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt)).map((ticket) => (
                        <button key={ticket.id} type="button" onClick={() => setSelected(ticket)} className="block w-full rounded-xl text-left outline-offset-2 hover:ring-1 hover:ring-slate-400">
                          <HistoryRow ticket={ticket} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {tickets.isLoading || vehiclesQuery.isLoading ? <p className="text-muted-foreground">Cargando historial…</p> : tickets.isError || vehiclesQuery.isError ? <p role="alert" className="text-destructive">No se pudo cargar el historial. Vuelve a intentarlo.</p> : !visibleVehicles.length ? (
        <div className="rounded-2xl border bg-white p-10 text-center text-muted-foreground">
          No hay clientes con vehículos que coincidan con la búsqueda.
        </div>
      ) : null}
      {selected ? createPortal(
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-slate-950/55 p-3"
          onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}
        >
          <section role="dialog" aria-modal="true" aria-label="Historial de la orden" className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <header className="flex items-start gap-3 border-b p-5">
              <Wrench className="mt-1 h-6 w-6" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-bold">{selected.ticketNumber}</h2>
                  <Badge variant="outline">{labels[selected.status] ?? selected.status}</Badge>
                </div>
                <p className="font-bold">
                  {selected.vehicle.licensePlate ?? 'SIN PLACA'} · {selected.vehicle.make}{' '}
                  {selected.vehicle.model}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selected.customer.name} · {selected.customer.phone ?? 'Sin teléfono'}
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Cerrar historial" onClick={() => setSelected(null)}>
                <X className="h-5 w-5" />
              </Button>
            </header>
            <div className="space-y-5 overflow-y-auto p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Info label="Motivo" value={selected.complaint} />
                <Info label="Diagnóstico" value={selected.diagnosis ?? 'Pendiente'} />
                <Info
                  label="Fecha de apertura"
                  value={new Date(selected.openedAt).toLocaleString('es-DO')}
                />
                <Info
                  label="Total actual"
                  value={`RD$ ${Number(selected.total).toLocaleString('es-DO', { minimumFractionDigits: 2 })}`}
                />
              </div>
              {selected.reception?.signatureUrl ? (
                <div>
                  <h3 className="mb-2 font-bold">Firma de recepción del cliente</h3>
                  <img src={selected.reception.signatureUrl} alt="Firma de recepción del cliente" className="h-36 w-full rounded-xl border bg-white object-contain" />
                  {selected.reception.signedAt ? <p className="mt-1 text-xs text-muted-foreground">Confirmada el {new Date(selected.reception.signedAt).toLocaleString('es-DO')}</p> : null}
                </div>
              ) : null}
              {selected.reception?.imageUrls.length ? (
                <div>
                  <h3 className="mb-2 font-bold">Evidencias de recepción</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {selected.reception.imageUrls.map((url) => (
                      <img
                        key={url}
                        src={url}
                        alt="Evidencia del vehículo"
                        className="h-40 w-full rounded-xl border object-cover"
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              <div>
                <h3 className="font-bold">Historial del vehículo</h3>
                <p className="text-sm text-muted-foreground">
                  {history.data?.tickets.length ?? 0} orden(es) ·{' '}
                  {history.data?.appointments.length ?? 0} cita(s)
                </p>
                <div className="mt-3 space-y-2">
                  {history.data?.tickets.map((item) => (
                    <HistoryRow key={item.id} ticket={item} />
                  ))}
                </div>
              </div>
              <div>
                <h3 className="font-bold">Historial del cliente</h3>
                <p className="text-sm text-muted-foreground">
                  {customerTickets.length} orden(es) asociadas a {selected.customer.name}.
                </p>
                <div className="mt-3 space-y-2">
                  {customerTickets.map((item) => (
                    <HistoryRow key={item.id} ticket={item} />
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}
function HistoryRow({ ticket }: { ticket: WorkshopTicket }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3">
      <span className="min-w-0">
        <strong>{ticket.ticketNumber}</strong>
        <span className="block truncate text-sm text-muted-foreground">
          {new Date(ticket.openedAt).toLocaleDateString('es-DO')} ·{' '}
          {ticket.vehicle.licensePlate ?? ticket.vehicle.model} · {ticket.complaint}
        </span>
      </span>
      <Badge variant="outline">{labels[ticket.status] ?? ticket.status}</Badge>
    </div>
  );
}

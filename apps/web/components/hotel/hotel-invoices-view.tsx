'use client';

import { useQuery } from '@tanstack/react-query';
import { Eye, FileText, Printer, ReceiptText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getHotelInvoices, type HotelInvoice } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { isAccountantSession, isAdminSession } from '@/lib/authorization';
import { formatMoney } from './hotel-flow';
import { ExpressInvoiceButton } from './express-invoice-dialog';
import { invoiceAsReceipt, PaymentReceiptDialog } from './payment-receipt-dialog';

const documentLabels = {
  SALE_NOTE: 'Nota de venta',
  E31: 'E31 · Crédito fiscal',
  E32: 'E32 · Consumo',
} as const;

const methodLabels = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Crédito a favor',
} as const;

/**
 * Facturación del hotel. Con `express` es el módulo Factura Express: solo las facturas sin reservación y el
 * botón para emitir una nueva. El listado lo ven administración y contabilidad; recepción solo emite.
 */
export function HotelInvoicesView({ express = false }: { express?: boolean }) {
  const session = getSession();
  const canList = isAdminSession(session) || isAccountantSession(session);
  const [query, setQuery] = useState('');
  const [docType, setDocType] = useState<'ALL' | 'E31' | 'E32' | 'SALE_NOTE'>('ALL');
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [selected, setSelected] = useState<HotelInvoice | null>(null);
  const invoicesQuery = useQuery({
    queryKey: ['hotel', 'invoices', session?.tenantId],
    queryFn: () => getHotelInvoices(session!.tenantId, session!.accessToken),
    enabled: Boolean(session) && canList,
  });
  const allInvoices = invoicesQuery.data ?? [];
  const invoices = express ? allInvoices.filter((invoice) => !invoice.reservation) : allInvoices;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('es');
    return invoices.filter((invoice) => {
      if (docType !== 'ALL' && invoice.billingDocumentType !== docType) return false;
      if (month !== 'ALL' && monthKey(invoice.createdAt) !== month) return false;
      if (!normalized) return true;
      const reservation = invoice.reservation;
      return [
        invoice.receiptNumber,
        reservation?.code,
        reservation?.guest.firstName,
        reservation?.guest.lastName,
        reservation?.room?.number,
        invoice.customerName,
        invoice.description,
        invoice.fiscalDocumentNumber,
        invoice.recordedBy?.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('es')
        .includes(normalized);
    });
  }, [docType, invoices, month, query]);
  // Meses con facturas (más el actual), del más reciente al más antiguo.
  const months = useMemo(() => {
    const keys = new Set([monthKey(new Date()), ...invoices.map((invoice) => monthKey(invoice.createdAt))]);
    return [...keys].sort().reverse();
  }, [invoices]);
  const total = filtered.reduce((sum, invoice) => sum + Number(invoice.amount), 0);
  const todayCount = invoices.filter(
    (invoice) => localDateKey(invoice.createdAt) === localDateKey(new Date()),
  ).length;
  const receiptReservation = selected ? invoiceAsReceipt(selected) : null;

  return (
    <div className="space-y-3 pb-5">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <p className="text-xs font-semibold text-teal">Hotel Ancla</p>
          <h1 className="mt-1 text-2xl font-extrabold text-slate-950">{express ? 'Factura Express' : 'Facturación'}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {express
              ? 'Factura rápida sin reservación: RNC o cédula, nombre, descripción y monto total.'
              : 'Comprobantes de las reservaciones y de Factura Express.'}
          </p>
        </div>
        {express ? <ExpressInvoiceButton /> : null}
      </header>

      {!canList ? (
        <section className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-slate-500">Usa el botón <b>Nueva factura express</b> para emitir una factura.</p>
          <p className="mt-1 text-xs text-slate-400">El listado de facturas lo revisa administración.</p>
        </section>
      ) : (
      <>

      <section className="grid gap-3 sm:grid-cols-3">
        <InvoiceStat label="Facturas emitidas" value={String(filtered.length)} icon={FileText} />
        <InvoiceStat label="Total facturado" value={formatMoney(total)} icon={ReceiptText} />
        <InvoiceStat label="Emitidas hoy" value={String(todayCount)} icon={Printer} />
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-extrabold">Listado de facturas</h2>
            <p className="text-xs text-slate-500">Notas de venta y comprobantes fiscales reales.</p>
          </div>
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
            <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1" role="tablist" aria-label="Tipo de comprobante">
              {(
                [
                  ['ALL', 'Todos'],
                  ['E31', 'E31 · Crédito fiscal'],
                  ['E32', 'E32 · Consumo'],
                  ['SALE_NOTE', 'Nota de venta'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={docType === value}
                  onClick={() => setDocType(value)}
                  className={`h-10 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-semibold ${
                    docType === value ? 'bg-white text-teal-deep shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <select
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                aria-label="Mes"
                className="h-12 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold first-letter:uppercase"
              >
                <option value="ALL">Todos los meses</option>
                {months.map((key) => (
                  <option key={key} value={key}>
                    {monthLabel(key)}
                  </option>
                ))}
              </select>
              <label className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-12 w-full rounded-xl border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-teal xl:w-64"
                  placeholder={express ? 'Factura, cliente, RNC o descripción…' : 'Factura, huésped, reserva o habitación…'}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[64rem] text-left text-xs">
            <thead className="bg-slate-50 text-[11px] text-slate-500">
              <tr>
                <th className="px-4 py-3">Factura</th>
                <th className="px-3 py-3">Cliente</th>
                <th className="px-3 py-3">{express ? 'Descripción' : 'Reservación'}</th>
                <th className="px-3 py-3">Fecha</th>
                <th className="px-3 py-3">Comprobante</th>
                <th className="px-3 py-3">Método</th>
                <th className="px-3 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((invoice) => (
                <tr key={invoice.id} className="border-t border-slate-100 hover:bg-slate-50/70">
                  <td className="px-4 py-3 font-extrabold text-slate-950">
                    {invoice.receiptNumber}
                  </td>
                  <td className="px-3 py-3">
                    <span className="block font-semibold">
                      {invoice.reservation
                        ? `${invoice.reservation.guest.firstName} ${invoice.reservation.guest.lastName}`
                        : invoice.customerName}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {invoice.reservation
                        ? invoice.reservation.guest.phone || invoice.reservation.guest.documentNumber || '—'
                        : `${invoice.fiscalDocumentType === 'RNC' ? 'RNC' : 'Cédula'} ${invoice.fiscalDocumentNumber ?? ''}`}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {invoice.reservation ? (
                      <>
                        <span className="block font-semibold">{invoice.reservation.code}</span>
                        <span className="text-[10px] text-slate-400">
                          {invoice.reservation.room
                            ? `Hab. ${invoice.reservation.room.number}`
                            : invoice.reservation.roomType.name}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold text-amber-800">
                          Factura Express
                        </span>
                        <span className="block max-w-[14rem] truncate text-[10px] text-slate-500">{invoice.description}</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-3">{formatDateTime(invoice.createdAt)}</td>
                  <td className="px-3 py-3">
                    <span className="rounded-full bg-sky-50 px-2 py-1 font-semibold text-sky-700">
                      {documentLabels[invoice.billingDocumentType]}
                    </span>
                  </td>
                  <td className="px-3 py-3">{methodLabels[invoice.method]}</td>
                  <td className="px-3 py-3 text-right font-extrabold">
                    {formatMoney(invoice.amount)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setSelected(invoice)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-teal px-3 py-2 text-[11px] font-bold text-teal-deep hover:bg-teal-light/50"
                    >
                      <Eye className="h-3.5 w-3.5" /> Ver factura
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {invoicesQuery.isLoading ? <InvoiceMessage text="Cargando facturas..." /> : null}
        {invoicesQuery.error ? (
          <InvoiceMessage text={(invoicesQuery.error as Error).message} error />
        ) : null}
        {!invoicesQuery.isLoading && !invoicesQuery.error && !filtered.length ? (
          <InvoiceMessage text="No hay facturas con esos criterios." />
        ) : null}
      </section>
      </>
      )}

      <PaymentReceiptDialog
        reservation={receiptReservation}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        autoPrint={false}
      />
    </div>
  );
}

function InvoiceStat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof FileText;
}) {
  return (
    <article className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-1 text-2xl font-extrabold text-slate-950">{value}</p>
      </div>
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-teal-light text-teal-deep">
        <Icon className="h-5 w-5" />
      </span>
    </article>
  );
}

function InvoiceMessage({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <p className={`border-t p-8 text-center text-sm ${error ? 'text-rose-600' : 'text-slate-500'}`}>
      {text}
    </p>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function localDateKey(value: string | Date) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Mes del comprobante en hora del hotel ("2026-11"). */
function monthKey(value: string | Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit' })
    .format(new Date(value))
    .slice(0, 7);
}

function monthLabel(key: string) {
  const text = new Intl.DateTimeFormat('es-DO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${key}-15T12:00:00Z`),
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

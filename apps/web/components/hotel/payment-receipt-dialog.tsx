'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, MessageCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import {
  getHotelFiscalSequenceValidity,
  lookupTaxIdentity,
  type HotelInvoice,
  type HotelReservation,
} from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { brand, platform } from '@/lib/brand';
import { nightsBetween, reservationBalance } from './hotel-flow';
import { shareInvoiceByWhatsApp } from './share-invoice';

const methodLabels: Record<string, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Crédito a favor',
};


const ITBIS_RATE = 0.18;
const TZ = 'America/Santo_Domingo';

const documentTitles = {
  // Sin comprobante fiscal: el ticket solo dice FACTURA.
  SALE_NOTE: { title: null, subtitle: null },
  E31: { title: 'FACTURA DE CRÉDITO FISCAL ELECTRÓNICA', subtitle: null },
  E32: { title: 'FACTURA DE CONSUMO ELECTRÓNICA', subtitle: null },
} as const;

/** "$4,600.00", como en los tickets fiscales. */
const amount = (value: number) =>
  `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
const round = (value: number) => Math.round(value * 100) / 100;
const shortDate = (value: string | Date) =>
  new Intl.DateTimeFormat('es-DO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value));
const timeOf = (value: string | Date) =>
  new Intl.DateTimeFormat('es-DO', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value));

/**
 * Las facturas de Pago Express no tienen reservación: se arma una "reservación" mínima con los datos del
 * cobro para reutilizar el mismo ticket (cliente, descripción y total con ITBIS incluido).
 */
export function invoiceAsReceipt(invoice: HotelInvoice): HotelReservation {
  if (invoice.reservation) return { ...invoice.reservation, payments: [invoice] };
  return {
    id: invoice.id,
    code: invoice.receiptNumber,
    status: 'CHECKED_OUT',
    paymentStatus: 'PAID',
    checkIn: invoice.createdAt,
    checkOut: invoice.createdAt,
    adults: 1,
    children: 0,
    totalAmount: invoice.amount,
    paidAmount: invoice.amount,
    guest: {
      id: '',
      firstName: invoice.customerName ?? 'Cliente',
      lastName: '',
      phone: invoice.customerPhone ?? null,
    },
    roomType: { id: '', name: '' },
    tenant: invoice.tenant,
    payments: [invoice],
  };
}

export function PaymentReceiptDialog({
  reservation,
  open,
  onClose,
  autoPrint = true,
}: {
  reservation: HotelReservation | null;
  open: boolean;
  onClose: () => void;
  autoPrint?: boolean;
}) {
  const payment = reservation?.payments?.[0];
  const lastPrintedReceipt = useRef<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const session = getSession();
  const isFiscal = payment?.billingDocumentType === 'E31' || payment?.billingDocumentType === 'E32';

  // Vencimiento de la secuencia del e-NCF (se imprime bajo el número, como exige el formato e-CF).
  const sequences = useQuery({
    queryKey: ['hotel', 'fiscal-sequences', 'validity', session?.tenantId],
    queryFn: () => getHotelFiscalSequenceValidity(session!.tenantId, session!.accessToken),
    enabled: Boolean(session && open && isFiscal),
    staleTime: 10 * 60_000,
  });
  // Razón social del cliente en facturas de crédito fiscal (padrón DGII).
  const fiscalType = payment?.fiscalDocumentType === 'RNC' || payment?.fiscalDocumentType === 'CEDULA' ? payment.fiscalDocumentType : null;
  const customerLookup = useQuery({
    queryKey: ['tax-identity', session?.tenantId, fiscalType, payment?.fiscalDocumentNumber],
    queryFn: () => lookupTaxIdentity(session!.tenantId, session!.accessToken, fiscalType!, payment!.fiscalDocumentNumber!),
    enabled: Boolean(session && open && fiscalType && payment?.fiscalDocumentNumber),
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    if (!autoPrint || !open || !payment || lastPrintedReceipt.current === payment.receiptNumber)
      return;
    // Espera los datos fiscales (vencimiento y razón social) antes de imprimir.
    if (isFiscal && (sequences.isLoading || customerLookup.isLoading)) return;
    const stopPrinting = printHotelInvoice(300);
    const printedReceipt = payment.receiptNumber;
    const markAsPrinted = window.setTimeout(() => {
      lastPrintedReceipt.current = payment.receiptNumber;
    }, 300);

    return () => {
      window.clearTimeout(markAsPrinted);
      stopPrinting();
      if (lastPrintedReceipt.current !== printedReceipt) lastPrintedReceipt.current = null;
    };
  }, [autoPrint, open, payment, isFiscal, sequences.isLoading, customerLookup.isLoading]);

  if (!reservation || !payment) return null;

  const tenant = reservation.tenant;
  const hotelName = (tenant?.commercialName || tenant?.name || brand.name).toUpperCase();
  const guestName = `${reservation.guest.firstName} ${reservation.guest.lastName}`.trim();
  const customerName =
    customerLookup.data?.outcome === 'FOUND' && customerLookup.data.name ? customerLookup.data.name : guestName;
  const express = Boolean(payment.description && !reservation.roomType.id);
  const nights = express ? 1 : nightsBetween(reservation.checkIn, reservation.checkOut);
  const doc = documentTitles[payment.billingDocumentType];

  // Los precios incluyen ITBIS: se desglosa como en los comprobantes fiscales (precio = base + 18 %).
  const total = round(Number(reservation.totalAmount));
  const base = round(total / (1 + ITBIS_RATE));
  const itbis = round(total - base);
  const unitBase = round(base / nights);
  const paid = round(Number(reservation.paidAmount));
  const pending = round(reservationBalance(reservation));
  const payWith = round(Number(payment.cashReceived ?? payment.amount));
  const change = round(Number(payment.changeAmount ?? 0));
  const sequenceNumber = Number(payment.receiptNumber.replace(/\D/g, '').slice(-10));
  const sequence = isFiscal
    ? sequences.data?.find(
        (item) =>
          payment.receiptNumber.startsWith(item.prefix) &&
          sequenceNumber >= item.startNumber &&
          sequenceNumber <= item.endNumber,
      )
    : undefined;

  return (
    <ActionDialog
      open={open}
      title={`Factura ${payment.receiptNumber}`}
      description="El pago fue registrado correctamente."
      eyebrow="Factura emitida"
      icon={<CheckCircle2 className="h-5 w-5" />}
      tone="success"
      confirmLabel="Cerrar factura"
      cancelLabel="Imprimir"
      size="md"
      onClose={onClose}
      onCancel={() => printHotelInvoice()}
      onConfirm={onClose}
    >
      <div className="mx-auto mb-3 flex w-full max-w-[22rem] gap-2">
        <button
          type="button"
          disabled={sharing}
          onClick={async () => {
            setSharing(true);
            try {
              const result = await shareInvoiceByWhatsApp({
                receiptNumber: payment.receiptNumber,
                guestName: reservation.guest.firstName,
                phone: reservation.guest.phone,
              });
              if (result === 'downloaded')
                toast.success('PDF descargado. Se abrió WhatsApp: adjunta el archivo en el chat.');
              if (result === 'shared') toast.success('Factura compartida');
            } catch (error) {
              toast.error((error as Error).message || 'No se pudo generar el PDF.');
            } finally {
              setSharing(false);
            }
          }}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[#25D366] text-sm font-extrabold text-white active:opacity-90 disabled:opacity-60"
        >
          {sharing ? <Loader2 className="h-5 w-5 animate-spin" /> : <MessageCircle className="h-5 w-5" />}
          Compartir factura por WhatsApp
        </button>
      </div>
      <article className="hotel-payment-invoice mx-auto w-full max-w-[22rem] rounded-lg border border-slate-200 bg-white px-4 py-4 font-mono text-[12px] leading-snug text-black">
        {/* Emisor */}
        <header className="text-center">
          <img src={brand.logoPath} alt={hotelName} className="mx-auto h-14 w-auto object-contain" />
          <p className="invoice-title mt-1 text-[14px] font-extrabold">{hotelName}</p>
          {tenant?.legalName && tenant.legalName.toUpperCase() !== hotelName ? (
            <p className="font-bold">{tenant.legalName}</p>
          ) : null}
          <p className="font-bold">RECEPCIÓN</p>
          <p>{tenant?.address || 'Calle Los Maestros #1, Barahona 81000'}</p>
          {tenant?.phone ? <p className="font-bold">Tel: {tenant.phone}</p> : null}
          <p className="font-bold">RNC: {tenant?.rnc || 'No configurado'}</p>
        </header>

        {/* Comprobante */}
        <section className="mt-3 text-center">
          <p className="invoice-title text-[14px] font-extrabold">FACTURA</p>
          {doc.title ? <p className="font-bold">{doc.title}</p> : null}
          {isFiscal ? <p className="font-bold">{payment.receiptNumber}</p> : null}
          {isFiscal && sequence?.validUntil ? <p>Vence: {shortDate(sequence.validUntil)}</p> : null}
          {doc.subtitle ? <p className="italic">{doc.subtitle}</p> : null}
        </section>

        {/* Datos de la venta */}
        <section className="mt-3 space-y-0.5">
          <ReceiptLine label="NÚMERO" value={(isFiscal || payment.billingDocumentType === 'SALE_NOTE') && !express ? reservation.code : payment.receiptNumber} />
          <p>
            <span className="font-bold">CLIENTE:</span>
          </p>
          <p className="pl-2 font-bold uppercase">{customerName}</p>
          {payment.fiscalDocumentNumber ? (
            <ReceiptLine label={payment.fiscalDocumentType === 'CEDULA' ? 'CÉDULA' : 'RNC'} value={payment.fiscalDocumentNumber} />
          ) : null}
          <div className="flex justify-between gap-2">
            <ReceiptLine label="FECHA" value={shortDate(payment.createdAt)} />
            <ReceiptLine label="HORA" value={timeOf(payment.createdAt)} />
          </div>
          <div className="flex justify-between gap-2">
            <ReceiptLine label="CAJERO" value={(payment.recordedBy?.name || 'Recepción').split(' ')[0]} />
            <ReceiptLine label="CONDICIÓN" value="CONTADO" />
          </div>
          {express ? null : (
            <ReceiptLine label="RESERVA" value={`${reservation.code} · ${reservation.channel?.name || 'Interno'}`} />
          )}
        </section>

        {/* Detalle */}
        <section className="mt-2 border-y-2 border-dashed border-black py-1">
          <div className="grid grid-cols-[1fr_5rem_5.5rem] font-extrabold">
            <span>DESCRIPCIÓN</span>
            <span className="text-right">ITBIS</span>
            <span className="text-right">TOTAL</span>
          </div>
        </section>
        <section className="mt-1">
          {express ? (
            <p className="font-extrabold uppercase">{payment.description}</p>
          ) : (
            <>
              <p className="font-extrabold">HOSPEDAJE</p>
              <p className="text-[11px]">
                {reservation.roomType.name}
                {reservation.room ? ` · Hab. ${reservation.room.number}` : ''} · {shortDate(reservation.checkIn)} al{' '}
                {shortDate(reservation.checkOut)}
              </p>
            </>
          )}
          <div className="grid grid-cols-[1fr_5rem_5.5rem]">
            <span>
              {nights.toFixed(2)} x {amount(unitBase)}
            </span>
            <span className="text-right">{amount(itbis)}</span>
            <span className="text-right">{amount(total)}</span>
          </div>
        </section>

        {/* Totales */}
        <section className="mt-2 space-y-0.5 border-t-2 border-dashed border-black pt-1.5">
          <ReceiptTotal label="Sub Total" value={amount(base)} />
          <ReceiptTotal label="Descuento" value={amount(0)} />
          <ReceiptTotal label="ITBIS 18%" value={amount(itbis)} />
          <ReceiptTotal label="10% Ley" value={amount(0)} />
          <ReceiptTotal label="Total Pagado" value={amount(paid)} strong />
          <ReceiptTotal label="Monto Pendiente" value={amount(pending)} />
        </section>
        <section className="mt-1.5 space-y-0.5 border-t-2 border-dashed border-black pt-1.5">
          <ReceiptTotal label={`Pago con (${methodLabels[payment.method]})`} value={amount(payWith)} />
          {express ? null : <ReceiptTotal label="Devuelta" value={amount(change)} strong />}
          {payment.reference ? <ReceiptTotal label="Referencia" value={payment.reference} /> : null}
        </section>

        <footer className="mt-4 text-center">
          <p className="font-bold">¡Gracias por su preferencia!</p>
          <p className="mt-1 text-[10px]">{platform.name}</p>
        </footer>
      </article>
    </ActionDialog>
  );
}

function ReceiptLine({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="font-bold">{label}:</span> {value}
    </p>
  );
}

function ReceiptTotal({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-end gap-3${strong ? ' invoice-total font-extrabold' : ''}`}>
      <span className="text-right">{label}:</span>
      <span className="min-w-[6.5rem] text-right tabular-nums">{value}</span>
    </div>
  );
}

const PAGE_STYLE_ID = 'hotel-receipt-page';
const PRINT_ROOT_ID = 'thermal-print-root';

/**
 * Imprime el ticket en impresora térmica de 80 mm. Se imprime una copia aislada del ticket (sin el resto de
 * la aplicación, que haría que el navegador reduzca la escala); se mide su alto real y la página se define a
 * esa medida (80 mm × alto), así la impresora no avanza papel en blanco.
 */
function printHotelInvoice(delay = 50) {
  let fallbackTimer: number | undefined;
  const clearPrintMode = () => {
    document.body.classList.remove('hotel-invoice-printing');
    document.getElementById(PAGE_STYLE_ID)?.remove();
    document.getElementById(PRINT_ROOT_ID)?.remove();
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
  };
  const printTimer = window.setTimeout(() => {
    const source = document.querySelector<HTMLElement>('.hotel-payment-invoice');
    if (!source) return;
    document.getElementById(PRINT_ROOT_ID)?.remove();
    const root = document.createElement('div');
    root.id = PRINT_ROOT_ID;
    root.appendChild(source.cloneNode(true));
    document.body.appendChild(root);
    document.body.classList.add('hotel-invoice-printing');
    const ticket = root.firstElementChild as HTMLElement;
    const heightMm = Math.ceil((ticket.getBoundingClientRect().height * 25.4) / 96) + 4;
    let style = document.getElementById(PAGE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = PAGE_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `@page { size: 80mm ${heightMm}mm; margin: 0; }`;
    window.print();
    fallbackTimer = window.setTimeout(clearPrintMode, 1_000);
  }, delay);
  window.addEventListener('afterprint', clearPrintMode, { once: true });

  return () => {
    window.clearTimeout(printTimer);
    window.removeEventListener('afterprint', clearPrintMode);
    clearPrintMode();
  };
}

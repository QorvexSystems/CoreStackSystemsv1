'use client';
import { DocumentPdfDownloadButton } from './document-pdf-download-button';
import { DocumentWhatsappButton } from './document-whatsapp-button';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Mail, Printer } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getInvoice } from '@/lib/api';
import { CompanyDocumentDetails } from './company-document-details';
import { brand, platform } from '@/lib/brand';
import { translatePaymentMethod, translateStatus } from '@/lib/display-labels';
import { formatCurrency } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { formatQuantity } from './pos/pos-utils';
import { SessionRequired, useCurrentSession } from './session-required';
import { DocumentEmailDialog } from './document-email-dialog';

export function InvoiceDetail({
  invoiceId,
  printMode = false,
  autoPrint = false,
}: {
  invoiceId: string;
  printMode?: boolean;
  autoPrint?: boolean;
}) {
  const session = useCurrentSession();
  const invoiceQuery = useQuery({
    queryKey: ['invoice', invoiceId, session?.tenantId, printMode ? 'receipt' : 'detail'],
    queryFn: () =>
      getInvoice(session?.tenantId ?? '', session?.accessToken ?? '', invoiceId, printMode),
    enabled: Boolean(session),
  });
  const invoice = invoiceQuery.data;
  const autoPrintTriggeredRef = useRef(false);
  const [emailOpen, setEmailOpen] = useState(false);

  useEffect(() => {
    if (printMode && autoPrint && invoice && !autoPrintTriggeredRef.current) {
      autoPrintTriggeredRef.current = true;
      void (async () => {
        const imagesReady = Promise.all(
          Array.from(document.images).map((image) =>
            image.complete
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  image.addEventListener('load', () => resolve(), { once: true });
                  image.addEventListener('error', () => resolve(), { once: true });
                }),
          ),
        );
        await Promise.race([
          Promise.all([document.fonts?.ready ?? Promise.resolve(), imagesReady]),
          new Promise<void>((resolve) => window.setTimeout(resolve, 1200)),
        ]);
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
        );
        window.focus();
        window.print();
      })();
    }
  }, [autoPrint, invoice, printMode]);

  if (!session) {
    return <SessionRequired session={session} />;
  }

  if (!invoice) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Factura</CardTitle>
          <CardDescription role={invoiceQuery.isError ? 'alert' : undefined}>
            {invoiceQuery.isError ? invoiceQuery.error.message : 'Cargando datos desde PostgreSQL.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (printMode) {
    return (
      <main className="invoice-letter-page mx-auto w-full max-w-[8.5in] bg-white p-5 text-zinc-950 sm:p-8 print:max-w-none print:p-0">
        <style>{`@page { size: Letter portrait; margin: 12.7mm; }
          @media print {
            html, body { background: white !important; }
            .invoice-letter-page { width: 100%; margin: 0; }
            .invoice-document { font-size: 10pt; line-height: 1.4; }
            .invoice-document thead { display: table-header-group; }
            .invoice-document tr, .invoice-summary, .invoice-document header, .invoice-document footer { break-inside: avoid; }
            .invoice-table-wrap { overflow: visible !important; }
            .invoice-document table { width: 100%; table-layout: fixed; }
            .invoice-company-header { flex-direction: row !important; align-items: flex-start !important; }
            .invoice-company-header > div:last-child { text-align: right; }
            .invoice-meta { grid-template-columns: repeat(2,minmax(0,1fr)) !important; }
          }
        `}</style>
        <div className="mb-3 print:hidden">
          <DocumentPdfDownloadButton kind="invoice" id={invoice.id} number={invoice.invoiceNumber} />
          <DocumentWhatsappButton
            kind="invoice"
            documentId={invoice.id}
            documentNumber={invoice.invoiceNumber}
            customer={invoice.customer ?? { name: 'Consumidor final' }}
          />
        </div>
        <Receipt invoice={invoice} copyLabel="ORIGINAL: CLIENTE" />
        <div className="mt-4 grid gap-2 print:hidden sm:grid-cols-2">
          <Button asChild variant="outline">
            <Link href="/pos">
              <ArrowLeft className="h-4 w-4" />
              Volver a Caja
            </Link>
          </Button>
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Reimprimir factura
          </Button>
        </div>
      </main>
    );
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Factura"
        description="Detalle persistido con items, pago, cajero y estado fiscal."
      />
      {!['DRAFT', 'CANCELLED', 'VOID', 'VOIDED'].includes(invoice.status) ? (
        <div className="flex justify-end">
          <Button onClick={() => setEmailOpen(true)}>
            <Mail className="h-4 w-4" />
            Enviar factura por email
          </Button>
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{invoice.invoiceNumber}</CardTitle>
          <CardDescription>
            {invoice.customer?.name ?? 'Consumidor final'} - {translateStatus(invoice.status)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Receipt invoice={invoice} copyLabel="VISTA PREVIA" />
        </CardContent>
      </Card>
      <DocumentWhatsappButton
        kind="invoice"
        documentId={invoice.id}
        documentNumber={invoice.invoiceNumber}
        customer={invoice.customer ?? { name: 'Consumidor final' }}
      />
      <DocumentEmailDialog
        open={emailOpen}
        session={session}
        kind="invoices"
        documentId={invoice.id}
        documentNumber={invoice.invoiceNumber}
        customerName={invoice.customer?.name ?? 'Consumidor final'}
        defaultEmail={invoice.customer?.email}
        onClose={() => setEmailOpen(false)}
      />
    </div>
  );
}

function Receipt({
  invoice,
  copyLabel,
}: {
  invoice: NonNullable<Awaited<ReturnType<typeof getInvoice>>>;
  copyLabel: string;
}) {
  const amountReceived =
    Number(invoice.amountReceived) > 0
      ? Number(invoice.amountReceived)
      : Number(invoice.paidAmount);
  const changeAmount = Number(invoice.changeAmount ?? 0);
  const completedPayments =
    invoice.payments?.filter((payment) => payment.status === 'COMPLETED') ?? [];
  const paymentMethods = new Set(completedPayments.map((payment) => payment.method));
  const subtotalBase = Number(invoice.subtotal);
  const fiscalNumber = invoice.ncf ?? invoice.eNcf ?? '-';
  const issuePoint = invoice.cashSession?.cashRegister;
  const documentTitle = getInvoiceDocumentTitle(invoice.documentType);
  const taxBuckets = invoice.items.reduce((buckets, item) => {
    const rate = Number(item.taxRate);
    const bucket = buckets.get(rate) ?? { base: 0, tax: 0 };
    bucket.base += Number(item.subtotal);
    bucket.tax += Number(item.taxTotal);
    buckets.set(rate, bucket);
    return buckets;
  }, new Map<number, { base: number; tax: number }>());
  const taxableBase = [...taxBuckets.entries()]
    .filter(([rate]) => rate > 0)
    .reduce((sum, [, bucket]) => sum + bucket.base, 0);
  const exemptBase = [...taxBuckets.entries()]
    .filter(([rate]) => rate === 0)
    .reduce((sum, [, bucket]) => sum + bucket.base, 0);

  return (
    <section className="invoice-document space-y-5 text-[12px] leading-relaxed">
      <header className="invoice-company-header flex flex-col justify-between gap-5 border-b border-zinc-300 pb-5 sm:flex-row">
        <div className="flex items-start gap-4">
          <div className="relative h-20 w-20 shrink-0">
            <Image src={brand.logoPath} alt={brand.name} fill className="object-contain" />
          </div>
          <div>
            <p className="text-lg font-bold">{brand.name}</p>
            <CompanyDocumentDetails />
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <h2 className="text-sm font-bold uppercase">{documentTitle}</h2>
          <p className="mt-1 text-lg font-semibold">{invoice.invoiceNumber}</p>
          <p className="text-xs text-zinc-500">
            {formatInvoiceDateTime(invoice.issuedAt ?? invoice.createdAt)}
          </p>
        </div>
      </header>

      <div className="invoice-meta grid gap-x-8 gap-y-2 rounded-md border border-zinc-200 p-4 sm:grid-cols-2">
        <ReceiptRow
          label={
            invoice.documentType === 'SALE_NOTE' ? 'Secuencia' : invoice.eNcf ? 'e-NCF' : 'NCF'
          }
          value={fiscalNumber}
          valueClassName="font-semibold"
        />
        <ReceiptRow
          label={invoice.documentType === 'SALE_NOTE' ? 'Factura' : 'Factura interna'}
          value={invoice.invoiceNumber}
        />
        <ReceiptRow
          label="Fecha de emisión"
          value={formatInvoiceDateTime(invoice.issuedAt ?? invoice.createdAt)}
        />
        <ReceiptRow label="Cajero" value={invoice.issuedBy?.name ?? '-'} />
        <ReceiptRow label="Cliente" value={invoice.customer?.name ?? 'Consumidor final'} />
        <ReceiptRow label="RNC/Cédula cliente" value={invoice.customer?.documentNumber ?? '—'} />
        <ReceiptRow label="Teléfono" value={invoice.customer?.phone ?? '—'} />
        <ReceiptRow label="Punto de emisión" value={issuePoint?.name ?? 'Caja no asignada'} />
      </div>

      <div className="invoice-table-wrap overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-left text-[11px]">
          <colgroup>
            <col style={{ width: '43%' }} />
            <col style={{ width: '9%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr className="border-y border-zinc-300 bg-zinc-50 text-[10px] uppercase tracking-wide text-zinc-600">
              <th className="py-3 pr-2">Descripción</th>
              <th className="px-1 py-3 text-right">Cant.</th>
              <th className="px-1 py-3 text-right">Precio</th>
              <th className="px-1 py-3 text-right">ITBIS</th>
              <th className="py-3 pl-1 text-right">Importe</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.id} className="border-b border-zinc-200 align-top">
                <td className="break-words py-3 pr-2">
                  <p className="font-medium">{item.description}</p>
                  {item.sku || item.barcode ? (
                    <p className="mt-1 break-all text-[10px] text-zinc-500">
                      {[item.sku, item.barcode].filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                </td>
                <td className="px-1 py-3 text-right tabular-nums">
                  {formatQuantity(item.quantity)}
                </td>
                <td className="px-1 py-3 text-right tabular-nums">
                  {formatCurrency(Number(item.unitPrice))}
                </td>
                <td className="px-1 py-3 text-right tabular-nums">
                  {formatCurrency(Number(item.taxTotal))}
                </td>
                <td className="py-3 pl-1 text-right font-medium tabular-nums">
                  {formatCurrency(Number(item.total))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="invoice-summary ml-auto w-full max-w-sm space-y-4">
        <div className="space-y-1.5 border-y border-zinc-300 py-3">
          <ReceiptRow label="Subtotal sin ITBIS" value={formatCurrency(subtotalBase)} />
          {taxableBase > 0 ? (
            <ReceiptRow label="Base gravada" value={formatCurrency(taxableBase)} />
          ) : null}
          {exemptBase > 0 ? (
            <ReceiptRow label="Monto exento" value={formatCurrency(exemptBase)} />
          ) : null}
          {[...taxBuckets.entries()]
            .filter(([, bucket]) => bucket.tax > 0)
            .sort(([left], [right]) => right - left)
            .map(([rate, bucket]) => (
              <ReceiptRow
                key={rate}
                label={`ITBIS ${formatTaxRate(rate)}`}
                value={formatCurrency(bucket.tax)}
              />
            ))}
          <ReceiptRow label="Total factura" value={formatCurrency(Number(invoice.total))} strong />
        </div>

        <div className="space-y-0.5">
          <ReceiptRow label="Pagado" value={formatCurrency(Number(invoice.paidAmount))} />
          <ReceiptRow
            label="Método"
            value={
              paymentMethods.size > 1
                ? 'Pago combinado'
                : translatePaymentMethod(invoice.paymentMethod ?? completedPayments[0]?.method)
            }
          />
          {completedPayments.length > 1
            ? completedPayments.map((payment) => (
                <ReceiptRow
                  key={payment.id}
                  label={translatePaymentMethod(payment.method)}
                  value={formatCurrency(Number(payment.amount))}
                />
              ))
            : null}
          {completedPayments
            .filter((payment) => payment.method === 'TRANSFER' && payment.reference)
            .map((payment) => (
              <ReceiptRow
                key={`bank-${payment.id}`}
                label="Banco de transferencia"
                value={payment.reference!}
              />
            ))}
          <ReceiptRow label="Recibido" value={formatCurrency(amountReceived)} />
          <ReceiptRow label="Devuelta" value={formatCurrency(changeAmount)} strong />
          <ReceiptRow label="Balance" value={formatCurrency(Number(invoice.balance))} />
        </div>
      </div>
      <footer className="border-t border-zinc-200 pt-4 text-center">
        <p className="font-bold">{copyLabel}</p>
        <p className="text-[11px] text-zinc-500">Powered by {platform.name}</p>
      </footer>
    </section>
  );
}

function formatTaxRate(rate: number) {
  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

function ReceiptRow({
  label,
  value,
  strong = false,
  valueClassName,
}: {
  label: string;
  value: string;
  strong?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={strong ? 'flex justify-between gap-3 font-bold' : 'flex justify-between gap-3'}>
      <span>{label}</span>
      <span className={`text-right ${valueClassName ?? ''}`}>{value}</span>
    </div>
  );
}

function getInvoiceDocumentTitle(documentType: string) {
  if (documentType === 'SALE_NOTE') return 'Nota de venta';
  if (documentType === 'FISCAL_CREDIT_01') return 'Factura de crédito fiscal';
  if (documentType === 'FISCAL_CREDIT_ELECTRONIC_31')
    return 'Factura de crédito fiscal electrónica';
  if (documentType === 'CONSUMER_ELECTRONIC_32') return 'Factura de consumo electrónica';
  return 'Factura de consumo';
}

function formatInvoiceDateTime(value: string) {
  return new Intl.DateTimeFormat('es-DO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'America/Santo_Domingo',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

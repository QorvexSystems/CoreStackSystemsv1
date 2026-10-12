'use client';

import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getInvoice } from '@/lib/api';
import { brand, platform } from '@/lib/brand';
import { formatBusinessRnc } from '@/lib/dominican-documents';
import { translatePaymentMethod, translateProductUnit, translateStatus } from '@/lib/display-labels';
import { formatCurrency } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { formatQuantity, getCommonProductUnit } from './pos/pos-utils';
import { SessionRequired, useCurrentSession } from './session-required';

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
    queryKey: ['invoice', invoiceId, session?.tenantId],
    queryFn: () => getInvoice(session?.tenantId ?? '', session?.accessToken ?? '', invoiceId),
    enabled: Boolean(session),
  });
  const invoice = invoiceQuery.data;
  const autoPrintTriggeredRef = useRef(false);

  useEffect(() => {
    if (printMode && autoPrint && invoice && !autoPrintTriggeredRef.current) {
      autoPrintTriggeredRef.current = true;
      window.setTimeout(() => window.print(), 500);
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
          <CardDescription>Cargando datos desde PostgreSQL.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (printMode) {
    return (
      <>
        <style jsx global>{`
          @page {
            size: 80mm auto;
            margin: 0;
          }

          @media print {
            html,
            body {
              width: 80mm;
              margin: 0;
              padding: 0;
              background: white;
            }
          }
        `}</style>
        <main className="mx-auto w-[80mm] max-w-full bg-white p-3 text-zinc-950 print:w-[80mm] print:p-0">
          <Receipt invoice={invoice} copyLabel="ORIGINAL: CLIENTE" />
          <div className="mt-4 print:hidden">
            <Button className="w-full" onClick={() => window.print()}>
              <Printer className="h-4 w-4" />
              Reimprimir factura
            </Button>
          </div>
        </main>
      </>
    );
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Factura"
        description="Detalle persistido con items, pago, cajero y estado fiscal."
      />
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
  const storeCreditApplied = (invoice.payments ?? [])
    .filter((payment) => payment.method === 'CREDIT' && payment.status === 'COMPLETED')
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  const amountReceived =
    storeCreditApplied > 0
      ? Number(invoice.amountReceived)
      : Number(invoice.amountReceived) > 0
        ? Number(invoice.amountReceived)
        : Number(invoice.paidAmount);
  const paymentMethods = Array.from(
    new Set(
      (invoice.payments ?? [])
        .filter((payment) => payment.status === 'COMPLETED')
        .map((payment) => translatePaymentMethod(payment.method)),
    ),
  );
  const paymentMethodLabel = paymentMethods.length
    ? paymentMethods.join(' + ')
    : translatePaymentMethod(invoice.paymentMethod);
  const changeAmount = Number(invoice.changeAmount ?? 0);
  const paidAmount = Number(invoice.paidAmount);
  const balance = Number(invoice.balance);
  const subtotalAfterDiscount = Number(invoice.subtotal);
  const discountTotal = Number(invoice.discountTotal ?? 0);
  const hasDiscount = discountTotal > 0.005;
  const grossSubtotal = subtotalAfterDiscount + discountTotal;
  const fiscalNumber = invoice.ncf ?? invoice.eNcf ?? '-';
  const issuePoint = invoice.cashSession?.cashRegister;
  const companyName = brand.name;
  const legalName = invoice.tenant?.legalName ?? invoice.tenant?.name ?? companyName;
  const normalizedLegalName = normalizeCompanyName(legalName);
  const normalizedCompanyName = normalizeCompanyName(companyName);
  const showCompanyName =
    normalizedLegalName !== normalizedCompanyName &&
    !normalizedLegalName.includes(normalizedCompanyName);
  const documentTitle = getInvoiceDocumentTitle(invoice.documentType);
  const businessContact = [invoice.tenant?.phone, invoice.tenant?.email]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
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
    <section className="space-y-3 text-[12px] leading-[1.28]">
      <header className="flex flex-col items-center text-center">
        <div className="relative h-16 w-24">
          <Image src={brand.logoPath} alt={brand.name} fill className="object-contain" />
        </div>
        <p className="mt-1 font-semibold uppercase">{legalName}</p>
        {showCompanyName ? <p>{companyName}</p> : null}
        <p>
          RNC/Cédula{' '}
          {invoice.tenant?.rnc ? formatBusinessRnc(invoice.tenant.rnc) : 'No configurado'}
        </p>
        {invoice.tenant?.address ? <p>{invoice.tenant.address}</p> : null}
        {businessContact ? <p>{businessContact}</p> : null}
        <p className="mt-2 font-semibold">
          Punto de emisión: {issuePoint?.name ?? 'Caja no asignada'}
          {issuePoint?.location ? ` · ${issuePoint.location}` : ''}
        </p>
      </header>

      <div className="border-y border-dashed border-zinc-400 py-2">
        <h2 className="mb-1 text-center text-sm font-bold uppercase">{documentTitle}</h2>
        <ReceiptRow
          label={invoice.eNcf ? 'e-NCF' : 'NCF'}
          value={fiscalNumber}
          valueClassName="font-semibold"
        />
        <ReceiptRow label="Factura interna" value={invoice.invoiceNumber} />
        <ReceiptRow
          label="Fecha de emisión"
          value={formatInvoiceDateTime(invoice.issuedAt ?? invoice.createdAt)}
        />
        <ReceiptRow label="Cajero" value={invoice.issuedBy?.name ?? '-'} />
        <ReceiptRow label="Cliente" value={invoice.customer?.name ?? 'Consumidor final'} />
      </div>

      <div className="space-y-2">
        {invoice.items.map((item) => (
          <div
            key={item.id}
            className="border-b border-dashed border-zinc-300 pb-2 last:border-b-0"
          >
            <div className="flex justify-between gap-3">
              <span className="font-medium">{item.description}</span>
              <span className="shrink-0 font-medium">{formatCurrency(Number(item.total))}</span>
            </div>
            {(item.sku && !item.sku.startsWith('__COMMON__:')) || item.barcode ? (
              <p className="text-[11px] text-zinc-600">
                {[
                  item.sku?.startsWith('__COMMON__:') ? null : item.sku,
                  item.barcode,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ) : null}
            <p className="text-[11px] text-zinc-600">
              {formatQuantity(item.quantity)} {translateProductUnit(getCommonProductUnit(item.sku))}
              {' × '}
              {formatCurrency(
                Number(item.quantity) > 0
                  ? Number(item.total) / Number(item.quantity)
                  : Number(item.total),
              )}
              {Number(item.taxTotal) > 0
                ? ` · ITBIS incluido ${formatCurrency(Number(item.taxTotal))}`
                : ''}
            </p>
            {Number(item.discountTotal) > 0 ? (
              <p className="text-[11px] font-medium text-emerald-700">
                Descuento: {formatCurrency(Number(item.discountTotal))}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="space-y-0.5 border-y border-dashed border-zinc-400 py-2">
        <ReceiptRow
          label={hasDiscount ? 'Subtotal bruto' : 'Subtotal'}
          value={formatCurrency(grossSubtotal)}
        />
        {hasDiscount ? (
          <>
            <ReceiptRow label="Descuento" value={`-${formatCurrency(discountTotal)}`} />
            <ReceiptRow
              label="Subtotal después de descuento"
              value={formatCurrency(subtotalAfterDiscount)}
            />
          </>
        ) : null}
        {taxableBase > 0 && exemptBase > 0 ? (
          <>
            <ReceiptRow label="Base gravada" value={formatCurrency(taxableBase)} />
            <ReceiptRow label="Monto exento" value={formatCurrency(exemptBase)} />
          </>
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
        <ReceiptRow label="Método" value={paymentMethodLabel} />
        <ReceiptRow label="Pagado" value={formatCurrency(paidAmount)} />
        {storeCreditApplied > 0 ? (
          <ReceiptRow label="Crédito aplicado" value={formatCurrency(storeCreditApplied)} />
        ) : null}
        {amountReceived > paidAmount + 0.005 || changeAmount > 0.005 ? (
          <ReceiptRow label="Recibido" value={formatCurrency(amountReceived)} />
        ) : null}
        {changeAmount > 0.005 ? (
          <ReceiptRow label="Devuelta" value={formatCurrency(changeAmount)} strong />
        ) : null}
        {balance > 0.005 ? (
          <ReceiptRow label="Balance" value={formatCurrency(balance)} />
        ) : null}
      </div>

      <footer className="pt-2 text-center">
        <p className="font-bold">{copyLabel}</p>
        <p className="text-[11px] text-zinc-500">Powered by {platform.name}</p>
      </footer>
    </section>
  );
}

function normalizeCompanyName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
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
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Printer } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getInvoice,
  getInvoiceFiscalProgress,
  type Invoice,
  type InvoicePrintRegistration,
  registerInvoicePrint,
} from '@/lib/api';
import type { AuthSession } from '@/lib/auth-session';
import { isAdminSession } from '@/lib/authorization';
import {
  translateDocumentType,
  translatePaymentMethod,
  translateProductUnit,
  translateStatus,
} from '@/lib/display-labels';
import { getInvoiceCustomerName } from '@/lib/invoice-customer';
import { electronicInvoiceRefreshInterval, isElectronicInvoiceDelayed } from '@/lib/electronic-invoice-progress';
import { formatCurrency, formatDateOnly, formatDateTime } from '@/lib/utils';
import { ModuleHeader } from './module-header';
import { formatQuantity } from './pos/pos-utils';
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
  const queryClient = useQueryClient();
  const invoiceQuery = useQuery({
    queryKey: ['invoice', invoiceId, session?.tenantId],
    queryFn: async () => {
      const tenantId = session?.tenantId ?? '';
      const token = session?.accessToken ?? '';
      const cached = queryClient.getQueryData<Invoice>(['invoice', invoiceId, tenantId]);
      if (cached && electronicInvoiceRefreshInterval(cached)) {
        const progress = await getInvoiceFiscalProgress(tenantId, token, invoiceId);
        if (progress.id !== invoiceId || progress.tenantId !== tenantId ||
            progress.documentType !== cached.documentType) throw new Error('Estado fiscal no disponible.');
        // Acceptance requires one final full refresh (including print count).
        // Receipt authorization still happens server-side, never from cache.
        if (progress.fiscalStatus !== 'ACCEPTED') return { ...cached, ...progress };
      }
      return getInvoice(tenantId, token, invoiceId);
    },
    enabled: Boolean(session),
    refetchInterval: query =>
      query.state.data
        ? electronicInvoiceRefreshInterval(query.state.data)
        : autoPrint ? 5_000 : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
  });
  const invoice = invoiceQuery.data;
  const autoPrintTriggeredRef = useRef(false);
  const autoPrintRetryCountRef = useRef(0);
  const autoPrintRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const printRequestInFlightRef = useRef(false);
  const [printRegistration, setPrintRegistration] = useState<InvoicePrintRegistration | null>(null);
  const [lastRegisteredPrintNumber, setLastRegisteredPrintNumber] = useState<number | null>(null);
  const [isRegisteringPrint, setIsRegisteringPrint] = useState(false);
  const [autoPrintRetryToken, setAutoPrintRetryToken] = useState(0);
  const [isAutoPrintRetryScheduled, setIsAutoPrintRetryScheduled] = useState(false);
  const effectivePrintCount = Math.max(
    invoice?.receiptPrintCount ?? 0,
    lastRegisteredPrintNumber ?? 0,
  );
  const printBlockReason = invoice ? getInvoicePrintBlockReason(invoice) : null;
  const printPermissionReason =
    session && invoice && !printBlockReason
      ? getInvoicePrintPermissionReason(invoice, session, effectivePrintCount)
      : null;
  const canRequestPrint = Boolean(
    session && invoice && !printBlockReason && !printPermissionReason,
  );

  useEffect(() => {
    autoPrintTriggeredRef.current = false;
    autoPrintRetryCountRef.current = 0;
    if (autoPrintRetryTimerRef.current) {
      clearTimeout(autoPrintRetryTimerRef.current);
      autoPrintRetryTimerRef.current = null;
    }
    setIsAutoPrintRetryScheduled(false);
    setLastRegisteredPrintNumber(null);
  }, [invoiceId]);

  useEffect(() => () => {
    if (autoPrintRetryTimerRef.current) clearTimeout(autoPrintRetryTimerRef.current);
  }, []);

  useEffect(() => {
    const preventUnregisteredKeyboardPrint = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'p' &&
        (!printMode || !printRegistration)
      ) {
        event.preventDefault();
        toast.warning(
          'La vista previa no se imprime con Ctrl+P. Usa la acción de impresión autorizada de RIVNU.',
        );
      }
    };

    window.addEventListener('keydown', preventUnregisteredKeyboardPrint);
    return () => window.removeEventListener('keydown', preventUnregisteredKeyboardPrint);
  }, [printMode, printRegistration]);

  const registerAndPrint = useCallback(async (automatic = false) => {
    if (!session || !invoice || printRequestInFlightRef.current) {
      return;
    }

    if (!canRequestPrint) {
      toast.error(
        printBlockReason ??
          printPermissionReason ??
          'Esta factura no está disponible para impresión.',
      );
      return;
    }

    printRequestInFlightRef.current = true;
    setIsRegisteringPrint(true);

    try {
      const registration = await registerInvoicePrint(
        session.tenantId,
        session.accessToken,
        invoiceId,
      );

      flushSync(() => {
        setPrintRegistration(registration);
        setLastRegisteredPrintNumber(registration.printNumber);
        setIsAutoPrintRetryScheduled(false);
      });
      window.setTimeout(() => {
        try {
          window.print();
        } finally {
          printRequestInFlightRef.current = false;
          setIsRegisteringPrint(false);
        }
      }, 0);
    } catch (error) {
      printRequestInFlightRef.current = false;
      setIsRegisteringPrint(false);
      if (
        automatic &&
        isElectronicInvoice(invoice) &&
        isPendingElectronicRepresentation(error)
      ) {
        autoPrintRetryCountRef.current += 1;
        setIsAutoPrintRetryScheduled(true);
        autoPrintRetryTimerRef.current = setTimeout(() => {
          autoPrintRetryTimerRef.current = null;
          autoPrintTriggeredRef.current = false;
          setIsAutoPrintRetryScheduled(false);
          setAutoPrintRetryToken((current) => current + 1);
        }, autoPrintRetryCountRef.current <= 12 ? 5_000 : 15_000);
        return;
      }
      setIsAutoPrintRetryScheduled(false);
      toast.error(
        error instanceof Error ? error.message : 'No se pudo registrar la impresión de la factura.',
      );
    }
  }, [canRequestPrint, invoice, invoiceId, printBlockReason, printPermissionReason, session]);

  useEffect(() => {
    if (
      printMode &&
      autoPrint &&
      invoice &&
      canRequestPrint &&
      !autoPrintTriggeredRef.current
    ) {
      autoPrintTriggeredRef.current = true;
      void registerAndPrint(true);
    }
  }, [autoPrint, autoPrintRetryToken, canRequestPrint, invoice, printMode, registerAndPrint]);

  if (!session) {
    return <SessionRequired session={session} />;
  }

  if (!invoice) {
    return (
      <Card className={printMode ? 'mx-auto mt-16 w-full max-w-sm' : undefined}>
        <CardHeader>
          <CardTitle>Factura</CardTitle>
          <CardDescription>
            {invoiceQuery.isError
              ? 'No se pudo consultar la factura. El cobro ya quedó registrado; vuelve a intentar la consulta.'
              : 'Cargando la factura para imprimir.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          {invoiceQuery.isError ? (
            <Button onClick={() => void invoiceQuery.refetch()}>Reintentar consulta</Button>
          ) : (
            <LoaderCircle className="h-6 w-6 animate-spin text-primary" aria-label="Cargando factura" />
          )}
        </CardContent>
      </Card>
    );
  }

  if (printMode) {
    const customerDestination = 'CLIENTE';
    const canRenderLocalReceipt = !isElectronicInvoice(invoice);

    return (
      <main className={`mx-auto max-w-sm bg-white p-4 text-zinc-950 print:max-w-none print:p-0 ${
        !printRegistration && isElectronicInvoice(invoice)
          ? 'flex min-h-[70vh] flex-col justify-center print:block print:min-h-0'
          : ''
      }`}>
        <div className={printRegistration ? undefined : 'print:hidden'}>
          {printRegistration?.representation ? (
            <ElectronicPrintedReceipt
              model={printRegistration.representation}
              invoice={invoice}
            />
          ) : canRenderLocalReceipt ? (
            <Receipt invoice={invoice} destination={customerDestination} />
          ) : null}
        </div>
        {!printRegistration ? (
          <div className="hidden p-8 text-center font-bold print:block">
            IMPRESIÓN BLOQUEADA.{' '}
            {printBlockReason ??
              printPermissionReason ??
              'USE EL BOTÓN DE IMPRESIÓN AUTORIZADA DE RIVNU.'}
          </div>
        ) : null}
        <div className="mt-4 print:hidden">
          {printRegistration ? (
            <div className="space-y-3">
              <p role="status" className="rounded-md border border-green-200 bg-green-50 p-3 text-center text-sm text-green-950">
                Factura lista. Si el navegador no abrió la impresión, usa este botón.
              </p>
              <Button className="w-full" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />
                Abrir impresión
              </Button>
            </div>
          ) : canRequestPrint && !isRegisteringPrint && !isAutoPrintRetryScheduled ? (
            <Button
              className="w-full"
              onClick={() => void registerAndPrint()}
            >
              <Printer className="h-4 w-4" />
              {effectivePrintCount > 0 ? 'Reimprimir factura' : 'Imprimir factura'}
            </Button>
          ) : (isElectronicInvoice(invoice) && !isTerminalElectronicInvoice(invoice)) || isRegisteringPrint || isAutoPrintRetryScheduled ? (
            <div role="status" className="flex flex-col items-center gap-3 rounded-md border border-sky-200 bg-sky-50 p-5 text-center text-sm text-sky-950">
              <LoaderCircle className="h-8 w-8 animate-spin text-blue-600" aria-hidden="true" />
              <p className="font-semibold">Venta cobrada. Preparando la factura.</p>
              <p>
                {isRegisteringPrint || isAutoPrintRetryScheduled
                  ? 'La factura está aceptada. Esperando su representación para abrir la impresión.'
                  : 'Esperando la aceptación del e-CF. La impresión se abrirá automáticamente cuando esté disponible.'}
              </p>
              {invoice.eNcf ? <p className="font-medium">{invoice.eNcf}</p> : null}
            </div>
          ) : (
            <div className="rounded-md border-2 border-danger p-3 text-center text-sm font-semibold text-danger">
              {printBlockReason ?? printPermissionReason}
            </div>
          )}
          <Button asChild variant="outline" className="mt-3 w-full">
            <Link href="/pos">Volver a caja</Link>
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
      {isElectronicInvoice(invoice) ? (
        <Card>
          <CardHeader>
            <CardTitle>Estado del e-CF</CardTitle>
            <CardDescription>
              La venta y el pago ya están guardados. RIVNU actualiza aquí la numeración, firma y
              respuesta de DGII.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Tipo</dt>
                <dd className="font-semibold">
                  {invoice.documentType === 'FISCAL_CREDIT_ELECTRONIC_31' ? 'E31' : 'E32'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">e-NCF</dt>
                <dd className="font-semibold">
                  {invoice.eNcf ??
                    (isTerminalElectronicInvoice(invoice)
                      ? 'No asignado'
                      : 'Reservando numeración…')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Proceso fiscal</dt>
                <dd className="font-semibold">{electronicFiscalStatusLabel(invoice)}</dd>
              </div>
            </dl>
            {invoice.fiscalStatus === 'REJECTED' || invoice.fiscalStatus === 'FAILED' ? (
              <p className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">
                El e-CF requiere revisión. La venta y el pago permanecen registrados. No repitas el
                cobro ni crees otra factura para esta venta; solicita revisión administrativa.
              </p>
            ) : invoice.fiscalStatus === 'ACCEPTED' ? (
              <div className="mt-4 flex flex-col gap-3 rounded-md border border-success/30 bg-success/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-semibold text-success">
                  Comprobante aceptado por DGII.
                </p>
                <Button asChild size="sm">
                  <Link href={`/invoices/${invoice.id}/print?autoPrint=1`}>
                    <Printer className="h-4 w-4" />
                    Ver e imprimir factura
                  </Link>
                </Button>
              </div>
            ) : isElectronicInvoiceDelayed(invoice) ? (
              <p role="alert" className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                El proceso fiscal está tardando más de lo esperado. La venta y el pago ya están
                registrados. No vuelvas a cobrar ni a facturar esta venta. Esta pantalla seguirá
                consultando el estado; solicita revisión administrativa si la demora continúa.
              </p>
            ) : (
              <p className="mt-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950">
                Procesamiento automático en curso. Puedes salir de esta pantalla; RIVNU continuará
                trabajando.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
      {!isElectronicInvoice(invoice) ? (
        <Card>
          <CardHeader>
            <CardTitle>{invoice.invoiceNumber}</CardTitle>
            <CardDescription>
              {getInvoiceCustomerName(invoice)} - {translateStatus(invoice.status)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="print:hidden">
              <Receipt invoice={invoice} destination="VISTA PREVIA" />
              <p className="mt-4 text-center text-xs text-muted-foreground">
                Vista previa solamente. Para imprimir, usa la acción autorizada del listado de
                facturas.
              </p>
            </div>
            <div className="hidden p-8 text-center font-bold print:block">
              IMPRESIÓN BLOQUEADA. LA VISTA PREVIA NO ES UN COMPROBANTE IMPRIMIBLE. USE LA ACCIÓN
              AUTORIZADA DE RIVNU.
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function isElectronicInvoice(invoice: Invoice) {
  return (
    invoice.documentType === 'FISCAL_CREDIT_ELECTRONIC_31' ||
    invoice.documentType === 'CONSUMER_ELECTRONIC_32'
  );
}

function isPendingElectronicRepresentation(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('La representación impresa estará disponible cuando DGII acepte') ||
    error.message.includes('La representación impresa verificada todavía no está disponible')
  );
}

function isTerminalElectronicInvoice(invoice: Invoice) {
  return (
    invoice.fiscalStatus === 'ACCEPTED' ||
    invoice.fiscalStatus === 'REJECTED' ||
    invoice.fiscalStatus === 'FAILED' ||
    invoice.fiscalStatus === 'CANCELLED'
  );
}

function electronicFiscalStatusLabel(invoice: Invoice) {
  switch (invoice.fiscalStatus) {
    case 'PENDING_SEQUENCE':
      return 'Reservando e-NCF';
    case 'PENDING_SIGNATURE':
      return 'Preparando y firmando';
    case 'SIGNED':
      return 'Firmado';
    case 'SENT':
      return 'Enviado a DGII';
    case 'ACCEPTED':
      return 'Aceptado';
    case 'REJECTED':
      return 'Rechazado';
    case 'FAILED':
      return 'Requiere revisión';
    default:
      return invoice.electronicDocument?.status ?? 'Procesando';
  }
}

function Receipt({
  invoice,
  destination,
}: {
  invoice: NonNullable<Awaited<ReturnType<typeof getInvoice>>>;
  destination: string;
}) {
  const amountReceived =
    Number(invoice.amountReceived) > 0
      ? Number(invoice.amountReceived)
      : Number(invoice.paidAmount);
  const changeAmount = Number(invoice.changeAmount ?? 0);
  const issuer = invoice.fiscalIssuerSnapshot ?? {
    rnc: invoice.tenant?.rnc ?? '',
    legalName: invoice.tenant?.legalName ?? invoice.tenant?.name ?? '',
    commercialName: invoice.tenant?.commercialName ?? invoice.tenant?.name ?? '',
    address: invoice.tenant?.address ?? '',
    phone: invoice.tenant?.phone ?? '',
    email: invoice.tenant?.email ?? '',
    logoUrl: invoice.tenant?.branding?.logoUrl ?? null,
    pointOfSale: invoice.cashSession?.cashRegister.name ?? 'Punto de venta',
    pointOfSaleLocation: invoice.cashSession?.cashRegister.location ?? null,
  };
  const customer = invoice.fiscalCustomerSnapshot;
  const discountTotal = Number(invoice.discountTotal);
  const netBeforeTaxes = Number(invoice.subtotal);
  const grossBeforeDiscounts = netBeforeTaxes + discountTotal;
  const exemptAmount = invoice.items
    .filter((item) => item.taxCategory === 'EXEMPT')
    .reduce((sum, item) => sum + Number(item.subtotal), 0);
  const taxableAmount = Math.max(netBeforeTaxes - exemptAmount, 0);
  const taxesByRate = Array.from(
    invoice.items.reduce((rates, item) => {
      const rate = Number(item.taxRate);
      if (rate <= 0) {
        return rates;
      }
      rates.set(rate, (rates.get(rate) ?? 0) + Number(item.taxTotal));
      return rates;
    }, new Map<number, number>()),
  );
  const documentWatermark = getHistoricalDocumentWatermark(invoice);
  const isLocalSale = invoice.documentType === 'LOCAL_SALE_NOTE';

  return (
    <section className="space-y-3 text-sm">
      {documentWatermark ? (
        <div className="border-2 border-danger px-3 py-2 text-center font-bold text-danger">
          {documentWatermark}
        </div>
      ) : null}
      <div className="flex flex-col items-center text-center">
        {issuer.logoUrl ? (
          <img
            src={issuer.logoUrl}
            alt={issuer.commercialName || issuer.legalName}
            className="h-20 w-32 object-contain"
          />
        ) : null}
        <p className={issuer.logoUrl ? 'mt-2 font-semibold' : 'font-semibold'}>
          {issuer.legalName}
        </p>
        {issuer.commercialName && issuer.commercialName !== issuer.legalName ? (
          <p className="text-xs">{issuer.commercialName}</p>
        ) : null}
        <p className="text-xs">RNC/Cédula {issuer.rnc}</p>
        {issuer.address ? <p className="text-xs">{issuer.address}</p> : null}
        {issuer.phone || issuer.email ? (
          <p className="text-xs">{[issuer.phone, issuer.email].filter(Boolean).join(' · ')}</p>
        ) : null}
        <p className="mt-1 text-xs font-medium">
          Punto de emisión: {issuer.pointOfSale}
          {issuer.pointOfSaleLocation ? ` · ${issuer.pointOfSaleLocation}` : ''}
        </p>
      </div>

      <div className="border-y border-dashed border-zinc-400 py-2">
        <div className="text-center font-bold">
          {isLocalSale ? 'FACTURA' : printedFiscalDocumentTitle(invoice.documentType)}
        </div>
        {!isLocalSale ? (
          <div className="flex justify-between">
            <span>NCF</span>
            <span className="font-semibold">{invoice.ncf ?? '-'}</span>
          </div>
        ) : null}
        {invoice.documentType === 'FISCAL_CREDIT_01' ? (
          <div className="flex justify-between">
            <span>FECHA DE VENCIMIENTO</span>
            <span>{formatDateOnly(invoice.fiscalValidUntil)}</span>
          </div>
        ) : null}
        <div className="flex justify-between">
          <span>{isLocalSale ? 'Referencia' : 'Factura interna'}</span>
          <span>{invoice.invoiceNumber}</span>
        </div>
        <div className="flex justify-between">
          <span>Fecha de emisión</span>
          <span>{formatDateTime(invoice.issuedAt ?? invoice.createdAt)}</span>
        </div>
        <div className="flex justify-between">
          <span>Cajero</span>
          <span>{invoice.issuedBy?.name ?? '-'}</span>
        </div>
        {customer ? (
          <>
            <div className="flex justify-between gap-3">
              <span>Cliente</span>
              <span className="text-right">{customer.name}</span>
            </div>
            <div className="flex justify-between">
              <span>{translateDocumentType(customer.documentType)}</span>
              <span>{customer.documentNumber}</span>
            </div>
          </>
        ) : (
          <div className="flex justify-between">
            <span>Cliente</span>
            <span>Consumidor final</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {invoice.items.map((item) => (
          <div key={item.id} className="border-b border-dotted border-zinc-300 pb-2 last:border-0">
            <div className="flex justify-between gap-3">
              <span>
                {item.taxCategory === 'EXEMPT' ? <strong>E </strong> : null}
                {item.description}
              </span>
              <span>{formatCurrency(Number(item.total))}</span>
            </div>
            <p className="text-xs text-zinc-600">
              {[item.sku, item.barcode].filter(Boolean).join(' · ') || 'Sin código'}
            </p>
            <p className="text-xs text-zinc-600">
              {formatQuantity(item.quantity)} {translateProductUnit(item.unit)} ×{' '}
              {formatCurrency(Number(item.unitPrice))} · Base{' '}
              {formatCurrency(Number(item.subtotal))} · ITBIS{' '}
              {formatCurrency(Number(item.taxTotal))}
            </p>
            {Number(item.discountTotal) > 0 ? (
              <p className="text-xs text-zinc-600">
                Descuento: {formatCurrency(Number(item.discountTotal))}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="border-t border-dashed border-zinc-400 pt-2">
        <div className="flex justify-between">
          <span>Subtotal bruto</span>
          <span>{formatCurrency(grossBeforeDiscounts)}</span>
        </div>
        {discountTotal > 0 ? (
          <div className="flex justify-between">
            <span>Descuentos</span>
            <span>-{formatCurrency(discountTotal)}</span>
          </div>
        ) : null}
        <div className="flex justify-between">
          <span>Subtotal sin ITBIS</span>
          <span>{formatCurrency(netBeforeTaxes)}</span>
        </div>
        <div className="flex justify-between">
          <span>Base gravada</span>
          <span>{formatCurrency(taxableAmount)}</span>
        </div>
        {exemptAmount > 0 ? (
          <div className="flex justify-between">
            <span>Monto exento</span>
            <span>{formatCurrency(exemptAmount)}</span>
          </div>
        ) : null}
        {taxesByRate.map(([rate, amount]) => (
          <div key={rate} className="flex justify-between">
            <span>ITBIS {Math.round(rate * 100)}%</span>
            <span>{formatCurrency(amount)}</span>
          </div>
        ))}
        {!taxesByRate.length ? (
          <div className="flex justify-between">
            <span>ITBIS</span>
            <span>{formatCurrency(Number(invoice.taxTotal))}</span>
          </div>
        ) : null}
        <div className="flex justify-between font-semibold">
          <span>Total factura</span>
          <span>{formatCurrency(Number(invoice.total))}</span>
        </div>
      </div>

      <div className="border-t border-dashed border-zinc-400 pt-2">
        <div className="flex justify-between">
          <span>Pagado</span>
          <span>{formatCurrency(Number(invoice.paidAmount))}</span>
        </div>
        <div className="flex justify-between">
          <span>Metodo</span>
          <span>{translatePaymentMethod(invoice.paymentMethod)}</span>
        </div>
        <div className="flex justify-between">
          <span>Recibido</span>
          <span>{formatCurrency(amountReceived)}</span>
        </div>
        <div className="flex justify-between font-semibold">
          <span>Devuelta</span>
          <span>{formatCurrency(changeAmount)}</span>
        </div>
        <div className="flex justify-between">
          <span>Balance</span>
          <span>{formatCurrency(Number(invoice.balance))}</span>
        </div>
      </div>

      <div className="pt-2 text-center text-xs">
        <p className="font-bold">{destination}</p>
        <p className="text-zinc-500">Powered by CoreStack</p>
      </div>
    </section>
  );
}

function ElectronicPrintedReceipt({
  model,
  invoice,
}: {
  model: NonNullable<InvoicePrintRegistration['representation']>;
  invoice: Invoice;
}) {
  const issuer = invoice.fiscalIssuerSnapshot ?? {
    rnc: model.issuerRnc,
    legalName: model.issuer,
    commercialName: invoice.tenant?.commercialName ?? invoice.tenant?.name ?? '',
    address: invoice.tenant?.address ?? '',
    phone: invoice.tenant?.phone ?? '',
    email: invoice.tenant?.email ?? '',
    logoUrl: invoice.tenant?.branding?.logoUrl ?? null,
    pointOfSale: '',
    pointOfSaleLocation: null,
  };
  const customer = invoice.fiscalCustomerSnapshot;
  const amountReceived =
    Number(invoice.amountReceived) > 0
      ? Number(invoice.amountReceived)
      : Number(invoice.paidAmount);
  const totalTax = printedField(model, 'Total ITBIS') ?? invoice.taxTotal;
  const taxableAmount = printedField(model, 'Monto gravado') ?? invoice.subtotal;

  return (
    <article className="mx-auto w-full max-w-[80mm] space-y-3 font-mono text-[11px] leading-tight text-zinc-950">
      <header className="text-center">
        {issuer.logoUrl ? (
          <img
            src={issuer.logoUrl}
            alt={issuer.commercialName || issuer.legalName}
            className="mx-auto mb-1 h-16 w-28 object-contain"
          />
        ) : null}
        {issuer.commercialName ? (
          <p className="text-base font-black uppercase">{issuer.commercialName}</p>
        ) : null}
        <p className="font-bold uppercase">{issuer.legalName || model.issuer}</p>
        <p>RNC: {model.issuerRnc}</p>
        {issuer.address ? <p>{issuer.address}</p> : null}
        {issuer.phone ? <p>Tel.: {issuer.phone}</p> : null}
        {issuer.email ? <p>{issuer.email}</p> : null}
      </header>

      <section className="break-inside-avoid border-y border-dashed border-zinc-700 py-2">
        <h1 className="text-center text-sm font-black uppercase">{model.title}</h1>
        <div className="mt-2 flex justify-between gap-3">
          <span>e-NCF Número:</span>
          <strong>{model.encf}</strong>
        </div>
        {invoice.fiscalValidUntil ? (
          <div className="flex justify-between gap-3">
            <span>e-NCF válido hasta:</span>
            <strong>{formatReceiptDate(invoice.fiscalValidUntil)}</strong>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <span>Fecha de emisión:</span>
          <strong>{model.issuedOn}</strong>
        </div>
        {customer ? (
          <>
            <div className="mt-1 flex justify-between gap-3">
              <span>Cliente:</span>
              <strong className="text-right">{customer.name}</strong>
            </div>
            <div className="flex justify-between gap-3">
              <span>{translateDocumentType(customer.documentType)}:</span>
              <strong>{customer.documentNumber}</strong>
            </div>
          </>
        ) : (
          <p className="mt-1">Consumidor final</p>
        )}
      </section>

      <section>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-dashed border-zinc-700 pb-1 font-bold uppercase">
          <span>Descripción</span>
          <span>ITBIS</span>
          <span>Valor</span>
        </div>
        <div className="divide-y divide-dotted divide-zinc-400">
          {model.lines.map((line, row) => {
            const item = invoice.items[row];
            const description = printedLineField(line, 'Descripción') ?? item?.description ?? 'Artículo';
            const quantity = printedLineField(line, 'Cantidad') ?? item?.quantity ?? '0';
            const unitPrice = printedLineField(line, 'Precio unitario') ?? item?.unitPrice ?? '0';
            const lineTotal = printedLineField(line, 'Monto de línea según XML') ?? item?.subtotal ?? '0';
            return (
              <div className="break-inside-avoid py-2" key={`${row}-${description}`}>
                <p className="font-bold">{description}</p>
                <div className="grid grid-cols-[1fr_auto_auto] gap-2">
                  <span>{formatPlainQuantity(quantity)} × {formatReceiptCurrency(unitPrice)}</span>
                  <span>{formatReceiptCurrency(item?.taxTotal ?? '0')}</span>
                  <span>{formatReceiptCurrency(lineTotal)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="break-inside-avoid border-y border-dashed border-zinc-700 py-2">
        <ReceiptValue label="Subtotal sin ITBIS" value={invoice.subtotal} />
        <ReceiptValue label="Base gravada" value={taxableAmount} />
        <ReceiptValue label="ITBIS" value={totalTax} />
        <div className="mt-1 flex justify-between text-sm font-black">
          <span>TOTAL A PAGAR</span>
          <span>{formatReceiptCurrency(model.total)}</span>
        </div>
      </section>

      <section className="break-inside-avoid border-b border-dashed border-zinc-700 pb-2">
        <ReceiptValue
          label={translatePaymentMethod(invoice.paymentMethod)}
          value={amountReceived}
        />
        {Number(invoice.changeAmount) > 0 ? (
          <ReceiptValue label="Devuelta" value={invoice.changeAmount} />
        ) : null}
      </section>

      <footer className="break-inside-avoid text-center">
        <QRCodeSVG
          className="mx-auto block"
          value={model.qrUrl}
          minVersion={model.qrVersion}
          boostLevel={false}
          size={180}
          level="L"
          marginSize={2}
        />
        <p className="mt-2 text-left">
          Código de seguridad: <strong>{model.securityCode}</strong>
        </p>
        <p className="text-left">Fecha de firma digital: {formatReceiptDateTime(model.signedAt)}</p>
        <p className="mt-2 border-y border-dashed border-zinc-700 py-2">
          Para consultar la validez de esta factura electrónica, escanee el código QR.
        </p>
        <p className="mt-2 text-sm font-black">GRACIAS POR SU COMPRA</p>
      </footer>
    </article>
  );
}

function ReceiptValue({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <strong>{formatReceiptCurrency(value)}</strong>
    </div>
  );
}

function printedField(
  model: NonNullable<InvoicePrintRegistration['representation']>,
  label: string,
) {
  for (const section of model.sections) {
    const match = section.fields.find(
      (field) => field.label === label || field.label.endsWith(` / ${label}`),
    );
    if (match) return match.value;
  }
  return null;
}

function printedLineField(
  line: NonNullable<InvoicePrintRegistration['representation']>['lines'][number],
  label: string,
) {
  return line.find(
    (field) => field.label === label || field.label.endsWith(` / ${label}`),
  )?.value;
}

function formatReceiptCurrency(value: string | number) {
  return `RD$${Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPlainQuantity(value: string | number) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function formatReceiptDate(value: string) {
  const date = value.slice(0, 10);
  const parts = date.includes('-') ? date.split('-') : [];
  if (parts.length !== 3) return value;
  return parts[0].length === 4 ? `${parts[2]}-${parts[1]}-${parts[0]}` : date;
}

function formatReceiptDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-DO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/Santo_Domingo',
  }).format(date);
}

function printedFiscalDocumentTitle(documentType: string) {
  if (documentType === 'FISCAL_CREDIT_01') {
    return 'FACTURA DE CRÉDITO FISCAL';
  }

  if (documentType === 'CONSUMER_02') {
    return 'FACTURA DE CONSUMO';
  }

  return 'FACTURA';
}

const printableInvoiceStatuses = new Set(['ISSUED', 'PAID', 'PARTIALLY_PAID']);

function getInvoicePrintBlockReason(invoice: Invoice) {
  const electronicPrefix =
    invoice.documentType === 'FISCAL_CREDIT_ELECTRONIC_31'
      ? 'E31'
      : invoice.documentType === 'CONSUMER_ELECTRONIC_32'
        ? 'E32'
        : null;
  if (electronicPrefix) {
    if (
      invoice.fiscalStatus === 'ACCEPTED' &&
      invoice.eNcf &&
      new RegExp(`^${electronicPrefix}\\d{10}$`).test(invoice.eNcf) &&
      ['ACCEPTED', 'PAID', 'ISSUED'].includes(invoice.status)
    ) return null;
    return 'La representación impresa estará disponible cuando DGII acepte el e-CF.';
  }
  if (
    invoice.documentType === 'LOCAL_SALE_NOTE' &&
    invoice.ncf === null &&
    invoice.eNcf === null &&
    /^RIV-\d{10}$/.test(invoice.invoiceNumber) &&
    invoice.fiscalStatus === 'NOT_APPLICABLE' &&
    printableInvoiceStatuses.has(invoice.status)
  ) {
    return null;
  }
  const expectedNcfPrefix =
    invoice.documentType === 'CONSUMER_02'
      ? 'B02'
      : invoice.documentType === 'FISCAL_CREDIT_01'
        ? 'B01'
        : null;

  if (
    !expectedNcfPrefix ||
    !invoice.ncf ||
    !new RegExp(`^${expectedNcfPrefix}\\d{8}$`).test(invoice.ncf) ||
    invoice.fiscalStatus !== 'LOCAL_ISSUED' ||
    !printableInvoiceStatuses.has(invoice.status)
  ) {
    return (
      getHistoricalDocumentWatermark(invoice) ??
      'La factura todavía no tiene una representación imprimible válida.'
    );
  }

  return null;
}

function getInvoicePrintPermissionReason(
  invoice: Invoice,
  session: AuthSession,
  receiptPrintCount: number,
) {
  if (isAdminSession(session)) {
    return null;
  }

  if (receiptPrintCount === 0) {
    return session.role === 'CASHIER' && invoice.issuedBy?.id === session.user.id
      ? null
      : 'La primera impresión solo puede realizarla el cajero emisor o un administrador.';
  }

  return session.permissions.canReprintReceipt
    ? null
    : 'Necesitas permiso para reimprimir facturas.';
}

function getHistoricalDocumentWatermark(invoice: Invoice) {
  if (invoice.status === 'DRAFT') {
    return 'BORRADOR — SIN NCF — SIN VALOR FISCAL';
  }

  if (invoice.fiscalStatus === 'LEGACY_UNVERIFIED') {
    return 'DOCUMENTO LEGADO NO VERIFICADO — NO USAR COMO NCF VÁLIDO';
  }

  if (invoice.status === 'CANCELLED' || invoice.fiscalStatus === 'CANCELLED') {
    return 'FACTURA CANCELADA — SIN VALOR FISCAL';
  }

  if (invoice.status === 'VOID' || invoice.status === 'VOIDED') {
    return 'FACTURA ANULADA — SIN VALOR FISCAL';
  }

  if (invoice.status === 'CREDITED') {
    return 'FACTURA ACREDITADA — DOCUMENTO HISTÓRICO NO IMPRIMIBLE';
  }

  if (invoice.documentType === 'LOCAL_SALE_NOTE') {
    return invoice.ncf === null &&
      invoice.eNcf === null &&
      /^RIV-\d{10}$/.test(invoice.invoiceNumber) &&
      invoice.fiscalStatus === 'NOT_APPLICABLE' &&
      printableInvoiceStatuses.has(invoice.status)
      ? null
      : 'DOCUMENTO NO EMITIDO — SIN VALOR FISCAL';
  }

  const expectedNcfPrefix =
    invoice.documentType === 'CONSUMER_02'
      ? 'B02'
      : invoice.documentType === 'FISCAL_CREDIT_01'
        ? 'B01'
        : null;

  if (!expectedNcfPrefix) {
    return null;
  }

  if (
    !invoice.ncf ||
    !new RegExp(`^${expectedNcfPrefix}\\d{8}$`).test(invoice.ncf) ||
    invoice.fiscalStatus !== 'LOCAL_ISSUED'
  ) {
    return 'DOCUMENTO NO EMITIDO — SIN VALOR FISCAL';
  }

  if (!printableInvoiceStatuses.has(invoice.status)) {
    return 'DOCUMENTO HISTÓRICO NO IMPRIMIBLE — SIN VALOR FISCAL';
  }

  return null;
}

'use client';

import { Delete, ReceiptText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Customer, StoreCreditLookup } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import {
  appendCurrencyInput,
  backspaceCurrencyInput,
  formatCurrencyInput,
  formatCurrencyInputFromNumber,
  sanitizeCurrencyInput,
} from './currency-input';
import type { PosTotals } from './types';

type PosPaymentPanelProps = {
  customers: Customer[];
  customerId: string;
  documentType: string;
  electronicInvoiceRequested: boolean;
  isAllpa: boolean;
  requiresE32Recipient: boolean;
  fiscalDocumentType: 'RNC' | 'CEDULA';
  fiscalDocumentNumber: string;
  fiscalDocumentValid: boolean;
  fiscalCustomerName?: string | null;
  paymentMethod: string;
  salePaymentMode: 'CASH' | 'CREDIT';
  dueDate?: string | null;
  customerLocked?: boolean;
  amountReceived: string;
  storeCreditReference: string;
  storeCredit: StoreCreditLookup | null;
  isStoreCreditLoading: boolean;
  discountPercent?: number;
  totals: PosTotals;
  message: string | null;
  canCompleteSale: boolean;
  isCompleting: boolean;
  onCustomerChange: (value: string) => void;
  onDocumentTypeChange: (value: string) => void;
  onFiscalDocumentTypeChange: (value: 'RNC' | 'CEDULA') => void;
  onFiscalDocumentNumberChange: (value: string) => void;
  onPaymentMethodChange: (value: string) => void;
  onAmountReceivedChange: (value: string) => void;
  onStoreCreditReferenceChange: (value: string) => void;
  onLookupStoreCredit: () => void;
  onClearStoreCredit: () => void;
  onCompleteSale: () => void;
};

export function PosPaymentPanel({
  customers,
  customerId,
  documentType,
  electronicInvoiceRequested,
  isAllpa,
  requiresE32Recipient,
  fiscalDocumentType,
  fiscalDocumentNumber,
  fiscalDocumentValid,
  fiscalCustomerName,
  paymentMethod,
  salePaymentMode,
  dueDate,
  customerLocked = false,
  amountReceived,
  storeCreditReference,
  storeCredit,
  isStoreCreditLoading,
  discountPercent,
  totals,
  message,
  canCompleteSale,
  isCompleting,
  onCustomerChange,
  onDocumentTypeChange,
  onFiscalDocumentTypeChange,
  onFiscalDocumentNumberChange,
  onPaymentMethodChange,
  onAmountReceivedChange,
  onStoreCreditReferenceChange,
  onLookupStoreCredit,
  onClearStoreCredit,
  onCompleteSale,
}: PosPaymentPanelProps) {
  const cashInsufficient =
    paymentMethod === 'CASH' &&
    totals.requiredPayment > 0 &&
    totals.received < totals.requiredPayment;
  const cashPayment = paymentMethod === 'CASH';
  const creditSale = salePaymentMode === 'CREDIT';
  const requiresFiscalDocument = ['FISCAL_CREDIT_01', 'FISCAL_CREDIT_ELECTRONIC_31'].includes(
    documentType,
  );
  const requiresRnc = documentType === 'FISCAL_CREDIT_ELECTRONIC_31';
  const requiresRecipientDocument = requiresFiscalDocument || requiresE32Recipient;
  const fiscalLabel = requiresRnc ? 'E31' : requiresE32Recipient ? 'E32' : 'B01';

  function appendAmount(value: string) {
    onAmountReceivedChange(appendCurrencyInput(amountReceived, value));
  }

  const numberKeys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0'];

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="customer" className="text-xs font-semibold">
            Cliente
          </Label>
          <select
            id="customer"
            value={customerId}
            disabled={customerLocked}
            onChange={(event) => onCustomerChange(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-zinc-100"
          >
            <option value="">Consumidor final</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="documentType" className="text-xs font-semibold">
            Comprobante
          </Label>
          <select
            id="documentType"
            value={documentType}
            onChange={(event) => onDocumentTypeChange(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isAllpa ? (
              <>
                {paymentMethod !== 'CARD' && !electronicInvoiceRequested ? (
                  <option value="LOCAL_SALE_NOTE">Nota de venta (sin secuencia fiscal)</option>
                ) : null}
                <option value="CONSUMER_ELECTRONIC_32">Factura electrónica E32</option>
                <option value="FISCAL_CREDIT_ELECTRONIC_31">Crédito fiscal electrónico E31</option>
              </>
            ) : electronicInvoiceRequested ? (
              <>
                <option value="CONSUMER_ELECTRONIC_32">Factura de consumo E32</option>
                <option value="FISCAL_CREDIT_ELECTRONIC_31">Crédito fiscal E31</option>
              </>
            ) : (
              <>
                <option value="CONSUMER_02">Factura de consumo B02</option>
                <option value="FISCAL_CREDIT_01">Crédito fiscal B01</option>
              </>
            )}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="paymentMethod" className="text-xs font-semibold">
            Método de pago
          </Label>
          <select
            id="paymentMethod"
            value={paymentMethod}
            onChange={(event) => onPaymentMethodChange(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="CASH">Efectivo</option>
            <option value="CARD">Tarjeta</option>
            <option value="TRANSFER">Transferencia</option>
          </select>
        </div>
      </div>

      {requiresRecipientDocument ? (
        <div className="rounded-md border border-primary/25 bg-primary/[0.035] p-2.5">
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
            <div className="space-y-1">
              <Label htmlFor="fiscalDocumentType" className="text-xs">
                Documento {fiscalLabel}
              </Label>
              <select
                id="fiscalDocumentType"
                value={fiscalDocumentType}
                disabled={requiresRnc}
                onChange={(event) =>
                  onFiscalDocumentTypeChange(event.target.value as 'RNC' | 'CEDULA')
                }
                className="h-9 w-full rounded-md border border-input bg-white px-2 text-sm"
              >
                <option value="RNC">RNC</option>
                <option value="CEDULA">Cédula</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="fiscalDocumentNumber" className="text-xs">
                Número del cliente
              </Label>
              <Input
                id="fiscalDocumentNumber"
                inputMode="numeric"
                value={fiscalDocumentNumber}
                onChange={(event) => onFiscalDocumentNumberChange(event.target.value)}
                placeholder={fiscalDocumentType === 'RNC' ? '000-00000-0' : '000-0000000-0'}
                className="h-9"
              />
            </div>
          </div>
          {fiscalDocumentNumber ? (
            <p
              className={
                fiscalDocumentValid && fiscalCustomerName
                  ? 'mt-1.5 text-xs text-success'
                  : 'mt-1.5 text-xs text-danger'
              }
            >
              {fiscalDocumentValid
                ? fiscalCustomerName
                  ? `Documento válido · ${fiscalCustomerName}`
                  : 'Documento válido, pero el cliente no está registrado.'
                : `Verifica el ${fiscalDocumentType === 'RNC' ? 'RNC' : 'número de cédula'}.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {creditSale ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
          Crédito aprobado · Inicial <strong>{formatCurrency(totals.baseRequiredPayment)}</strong>
          {dueDate ? ` · Vence ${new Date(dueDate).toLocaleDateString('es-DO')}` : ''}
        </div>
      ) : null}

      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="storeCreditInvoice" className="text-xs font-semibold">
              Crédito por devolución
            </Label>
            <Input
              id="storeCreditInvoice"
              value={storeCreditReference}
              onChange={(event) => onStoreCreditReferenceChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onLookupStoreCredit();
                }
              }}
              placeholder="Ej. ALL-B0200000257"
              className="h-9 bg-white uppercase"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9"
              disabled={!storeCreditReference.trim() || isStoreCreditLoading}
              onClick={onLookupStoreCredit}
            >
              {isStoreCreditLoading ? 'Buscando...' : 'Buscar crédito'}
            </Button>
            {storeCredit ? (
              <Button type="button" variant="ghost" className="h-9" onClick={onClearStoreCredit}>
                Quitar
              </Button>
            ) : null}
          </div>
        </div>
        {storeCredit ? (
          <div className="mt-2 grid gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950 sm:grid-cols-3">
            <span>
              Disponible <strong>{formatCurrency(storeCredit.availableAmount)}</strong>
            </span>
            <span>
              Aplicado <strong>{formatCurrency(totals.storeCreditApplied)}</strong>
            </span>
            <span>
              Saldo posterior{' '}
              <strong>
                {formatCurrency(storeCredit.availableAmount - totals.storeCreditApplied)}
              </strong>
            </span>
            <span className="sm:col-span-3">
              Vence {new Date(storeCredit.expiresAt).toLocaleDateString('es-DO')}
            </span>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-slate-950 px-3 py-2.5 text-white shadow-sm">
          <p className="text-[11px] text-slate-300">Total a cobrar</p>
          <p className="mt-0.5 text-xl font-bold leading-none">
            {formatCurrency(totals.requiredPayment)}
          </p>
        </div>
        <div className="rounded-lg bg-zinc-100 px-3 py-2.5 text-zinc-900">
          <p className="text-[11px] text-zinc-500">Recibido</p>
          <p className="mt-0.5 text-xl font-bold leading-none">{formatCurrency(totals.received)}</p>
        </div>
        <div className="rounded-lg bg-zinc-100 px-3 py-2.5 text-zinc-900">
          <p className="text-[11px] text-zinc-500">Devuelta</p>
          <p className="mt-0.5 text-xl font-bold leading-none">{formatCurrency(totals.change)}</p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(13rem,0.8fr)]">
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="amountReceived" className="text-xs font-semibold">
              {cashPayment ? 'Monto entregado por el cliente' : 'Monto pagado'}
            </Label>
            <div className="relative">
              <Input
                id="amountReceived"
                type="text"
                inputMode="decimal"
                value={amountReceived}
                disabled={!cashPayment}
                onChange={(event) =>
                  onAmountReceivedChange(sanitizeCurrencyInput(event.target.value))
                }
                onBlur={(event) => onAmountReceivedChange(formatCurrencyInput(event.target.value))}
                onFocus={(event) => event.currentTarget.select()}
                placeholder={
                  totals.requiredPayment
                    ? formatCurrencyInputFromNumber(totals.requiredPayment)
                    : '0.00'
                }
                className="h-11 pr-12 text-lg font-semibold"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
                RD$
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs">
            {isAllpa && totals.discount > 0 ? (
              <div className="flex justify-between py-0.5">
                <span className="text-muted-foreground">Precio antes de descuento (con ITBIS)</span>
                <span className="font-medium">{formatCurrency(totals.total + totals.discount)}</span>
              </div>
            ) : null}
            {!isAllpa ? (
              <div className="flex justify-between py-0.5">
                <span className="text-muted-foreground">Subtotal bruto</span>
                <span className="font-medium">{formatCurrency(totals.subtotal + totals.discount)}</span>
              </div>
            ) : null}
            {totals.discount > 0 ? (
              <div className="flex justify-between py-0.5 text-emerald-700">
                <span>
                  {isAllpa ? 'Descuento sobre precio final' : 'Descuento sobre productos'}
                  {discountPercent && discountPercent > 0
                    ? ` (${formatDiscountPercent(discountPercent)})`
                    : ''}
                </span>
                <span className="font-medium">-{formatCurrency(totals.discount)}</span>
              </div>
            ) : null}
            <div className="flex justify-between py-0.5">
              <span className="text-muted-foreground">{isAllpa ? 'Subtotal sin ITBIS' : 'Subtotal después de descuento'}</span>
              <span className="font-medium">{formatCurrency(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span className="text-muted-foreground">ITBIS</span>
              <span className="font-medium">{formatCurrency(totals.tax)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t border-zinc-200 pt-1.5 text-sm font-bold">
              <span>Total</span>
              <span>{formatCurrency(totals.total)}</span>
            </div>
            {creditSale ? (
              <>
                <div className="mt-1 flex justify-between font-semibold text-sky-800">
                  <span>Inicial</span>
                  <span>{formatCurrency(totals.requiredPayment)}</span>
                </div>
                <div className="flex justify-between font-semibold text-amber-800">
                  <span>Saldo</span>
                  <span>{formatCurrency(totals.remainingBalance)}</span>
                </div>
              </>
            ) : null}
            {totals.storeCreditApplied > 0 ? (
              <div className="flex justify-between font-semibold text-emerald-700">
                <span>Crédito aplicado</span>
                <span>-{formatCurrency(totals.storeCreditApplied)}</span>
              </div>
            ) : null}
            <div className="flex justify-between font-bold text-slate-950">
              <span>A pagar ahora</span>
              <span>{formatCurrency(totals.requiredPayment)}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-1.5">
            {numberKeys.map((key) => (
              <Button
                key={key}
                type="button"
                variant="outline"
                className="h-10 text-sm font-semibold"
                disabled={!cashPayment}
                onClick={() => appendAmount(key)}
              >
                {key}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-10"
              disabled={!cashPayment}
              onClick={() => onAmountReceivedChange(backspaceCurrencyInput(amountReceived))}
              aria-label="Borrar último dígito"
            >
              <Delete className="h-4 w-4" />
            </Button>
          </div>

          <Button
            type="button"
            className="h-[3.25rem] min-h-[3.25rem] w-full bg-slate-900 font-bold text-white hover:bg-slate-800"
            disabled={!canCompleteSale || cashInsufficient || isCompleting}
            onClick={onCompleteSale}
          >
            <ReceiptText className="h-4 w-4" />
            {isCompleting ? 'Facturando...' : 'Facturar e imprimir'}
          </Button>
        </div>
      </div>

      {cashInsufficient ? (
        <p className="rounded-md bg-danger/10 px-3 py-1.5 text-xs text-danger">
          El efectivo recibido debe cubrir el monto requerido.
        </p>
      ) : null}

      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
      <p className="text-center text-[11px] text-muted-foreground">
        Al confirmar, se emite la factura y se abre el recibo para imprimir automáticamente.
      </p>
    </div>
  );
}

function formatDiscountPercent(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

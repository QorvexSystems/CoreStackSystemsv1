'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, CreditCard, Landmark, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@/components/ui/action-dialog';
import { createHotelExpressInvoice, type HotelInvoice, type TaxIdentityLookup } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { validateDominicanDocument } from '@/lib/dominican-documents';
import { cn } from '@/lib/utils';
import { formatMoney } from './hotel-flow';
import { invoiceAsReceipt, PaymentReceiptDialog } from './payment-receipt-dialog';
import { TaxIdentityField, type TaxDocumentType } from './tax-identity-field';

const ITBIS_RATE = 0.18;
const round = (value: number) => Math.round(value * 100) / 100;
const fieldClass =
  'mt-1 h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base outline-none focus:border-teal focus:ring-4 focus:ring-teal/10';

const methods = [
  { value: 'CASH', label: 'Efectivo', icon: Banknote },
  { value: 'CARD', label: 'Tarjeta', icon: CreditCard },
  { value: 'TRANSFER', label: 'Transferencia', icon: Landmark },
] as const;

const emptyForm = {
  documentType: 'RNC' as TaxDocumentType,
  documentNumber: '',
  customerName: '',
  customerPhone: '',
  description: '',
  amount: '',
  method: 'CASH' as (typeof methods)[number]['value'],
  billingDocumentType: 'E31' as 'E31' | 'E32',
  reference: '',
};

/**
 * Pago Express: factura rápida sin reservación. Solo pide RNC/cédula, nombre o razón social, descripción y
 * el monto total (que ya incluye el ITBIS: el comprobante lo desglosa).
 */
export function ExpressInvoiceButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState<HotelInvoice | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 text-sm font-extrabold text-white shadow-sm active:bg-amber-600',
          className,
        )}
      >
        <Zap className="h-5 w-5" /> Nueva factura express
      </button>
      {open ? (
        <ExpressInvoiceDialog
          onClose={() => setOpen(false)}
          onCreated={(invoice) => {
            setOpen(false);
            setReceipt(invoice);
          }}
        />
      ) : null}
      <PaymentReceiptDialog
        reservation={receipt ? invoiceAsReceipt(receipt) : null}
        open={Boolean(receipt)}
        onClose={() => setReceipt(null)}
      />
    </>
  );
}

function ExpressInvoiceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invoice: HotelInvoice) => void;
}) {
  const session = getSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const update = <K extends keyof typeof emptyForm>(key: K, value: (typeof emptyForm)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const total = round(Number(form.amount) || 0);
  const base = round(total / (1 + ITBIS_RATE));
  const itbis = round(total - base);
  const fiscalType = form.documentType === 'PASSPORT' ? null : form.documentType;
  const documentOk = Boolean(fiscalType && validateDominicanDocument(fiscalType, form.documentNumber));
  const valid =
    documentOk &&
    form.customerName.trim().length >= 2 &&
    form.description.trim().length >= 2 &&
    total > 0;

  const mutation = useMutation({
    mutationFn: () =>
      createHotelExpressInvoice(session!.tenantId, session!.accessToken, {
        documentType: fiscalType!,
        documentNumber: form.documentNumber,
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim() || undefined,
        description: form.description.trim(),
        amount: total,
        method: form.method,
        cashReceived: form.method === 'CASH' ? total : undefined,
        billingDocumentType: form.billingDocumentType,
        reference: form.reference.trim() || undefined,
      }),
    onSuccess: async (invoice) => {
      await queryClient.invalidateQueries({ queryKey: ['hotel', 'invoices'] });
      toast.success(`Factura ${invoice.receiptNumber} emitida`);
      onCreated(invoice);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const onRegistryName = (result: TaxIdentityLookup) => {
    if (result.name) update('customerName', result.name);
  };

  return (
    <ActionDialog
      open
      size="lg"
      eyebrow="Factura rápida"
      title="Factura Express"
      description="Factura sin reservación: el monto total ya incluye el ITBIS."
      icon={<Zap className="h-5 w-5" />}
      confirmLabel={`Cobrar ${formatMoney(total)}`}
      cancelLabel="Cancelar"
      confirmDisabled={!valid}
      isPending={mutation.isPending}
      onClose={onClose}
      onCancel={onClose}
      onConfirm={() => mutation.mutate()}
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <TaxIdentityField
            label="RNC / Cédula *"
            allowPassport={false}
            documentType={form.documentType}
            documentNumber={form.documentNumber}
            onChange={(value) => setForm((current) => ({ ...current, ...value }))}
            onNameFound={onRegistryName}
          />
          <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">
            Nombre o razón social *
            <input
              className={fieldClass}
              value={form.customerName}
              maxLength={160}
              onChange={(event) => update('customerName', event.target.value)}
            />
          </label>
          <label className="block text-sm font-semibold text-slate-700 sm:col-span-2">
            Descripción *
            <input
              className={fieldClass}
              value={form.description}
              maxLength={300}
              placeholder="Ej. Servicio de alojamiento, alquiler de salón, consumo…"
              onChange={(event) => update('description', event.target.value)}
            />
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Monto total (ITBIS incluido) *
            <input
              className={cn(fieldClass, 'text-xl font-extrabold tabular-nums')}
              inputMode="decimal"
              value={form.amount}
              placeholder="0.00"
              onChange={(event) => update('amount', event.target.value.replace(/[^\d.]/g, ''))}
            />
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Teléfono / WhatsApp <span className="font-normal text-slate-400">(opcional)</span>
            <input
              className={fieldClass}
              type="tel"
              value={form.customerPhone}
              onChange={(event) => update('customerPhone', event.target.value)}
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
          <Breakdown label="Subtotal" value={formatMoney(base)} />
          <Breakdown label="ITBIS 18 %" value={formatMoney(itbis)} />
          <Breakdown label="Total" value={formatMoney(total)} strong />
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-700">Comprobante</p>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {(
              [
                ['E31', 'E31 · Crédito fiscal'],
                ['E32', 'E32 · Consumo'],
              ] as const
            ).map(([value, label]) => (
              <Choice key={value} active={form.billingDocumentType === value} onClick={() => update('billingDocumentType', value)}>
                {label}
              </Choice>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-700">Método de pago</p>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {methods.map(({ value, label, icon: Icon }) => (
              <Choice key={value} active={form.method === value} onClick={() => update('method', value)}>
                <Icon className="h-5 w-5" /> {label}
              </Choice>
            ))}
          </div>
        </div>

        {form.method === 'CASH' ? null : (
          <label className="block text-sm font-semibold text-slate-700">
            Referencia <span className="font-normal text-slate-400">(opcional)</span>
            <input
              className={fieldClass}
              value={form.reference}
              maxLength={100}
              onChange={(event) => update('reference', event.target.value)}
            />
          </label>
        )}
      </div>
    </ActionDialog>
  );
}

function Breakdown({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={cn('mt-0.5 tabular-nums', strong ? 'text-xl font-extrabold text-teal-deep' : 'text-base font-bold text-slate-900')}>
        {value}
      </p>
    </div>
  );
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 px-3 text-sm font-bold transition',
        active ? 'border-teal bg-teal-light text-teal-deep' : 'border-slate-200 bg-white text-slate-600',
      )}
    >
      {children}
    </button>
  );
}

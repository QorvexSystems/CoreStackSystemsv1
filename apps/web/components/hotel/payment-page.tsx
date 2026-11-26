'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CircleDollarSign,
  CreditCard,
  FileText,
  Landmark,
  Loader2,
  WalletCards,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  applyAmountKey,
  applyDigitsKey,
  NumericKeypad,
  type KeypadKey,
} from '@/components/ui/numeric-keypad';
import { getHotelReservations, recordHotelPayment, type HotelReservation } from '@/lib/api';
import { getSession } from '@/lib/auth-session';
import { cn } from '@/lib/utils';
import {
  canCollectReservationPayment,
  formatMoney,
  formatStayDateTime,
  nightsBetween,
  reservationBalance,
} from './hotel-flow';
import { PaymentReceiptDialog } from './payment-receipt-dialog';
import { TaxLookupHint } from './tax-identity-field';

type Method = 'CASH' | 'CARD' | 'TRANSFER';
type BillingDocument = 'SALE_NOTE' | 'E31' | 'E32';
type Field = 'cash' | 'document';

const documentsByMethod: Record<Method, BillingDocument[]> = {
  CASH: ['SALE_NOTE', 'E31'],
  TRANSFER: ['SALE_NOTE', 'E31', 'E32'],
  CARD: ['E31', 'E32'],
};
const documentLabels: Record<BillingDocument, { title: string; detail: string }> = {
  SALE_NOTE: { title: 'Nota de venta', detail: 'Sin comprobante fiscal' },
  E31: { title: 'E31', detail: 'Crédito fiscal (RNC/cédula)' },
  E32: { title: 'E32', detail: 'Consumo electrónico' },
};
const methods: { value: Method; label: string; icon: typeof WalletCards }[] = [
  { value: 'CASH', label: 'Efectivo', icon: WalletCards },
  { value: 'CARD', label: 'Tarjeta', icon: CreditCard },
  { value: 'TRANSFER', label: 'Transferencia', icon: Landmark },
];

const grouped = (value: string) => {
  if (!value) return '';
  const [whole, decimals] = value.split('.');
  const formatted = Number(whole || '0').toLocaleString('en-US');
  return decimals === undefined ? formatted : `${formatted}.${decimals}`;
};

/** Pantalla de cobro para tablet: botones grandes y pad numérico (sin depender del teclado del sistema). */
export function HotelPaymentPage({ reservationId }: { reservationId: string }) {
  const session = getSession();
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = params.get('return') || '/reservations';
  const queryClient = useQueryClient();
  const reservations = useQuery({
    queryKey: ['hotel', 'reservations', session?.tenantId],
    queryFn: () => getHotelReservations(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const reservation = reservations.data?.find((item) => item.id === reservationId) ?? null;

  const [method, setMethod] = useState<Method>('CASH');
  const [document, setDocument] = useState<BillingDocument>('SALE_NOTE');
  const [fiscalType, setFiscalType] = useState<'CEDULA' | 'RNC'>('CEDULA');
  const [fiscalNumber, setFiscalNumber] = useState('');
  const [cash, setCash] = useState('');
  const [active, setActive] = useState<Field>('cash');
  const [receipt, setReceipt] = useState<HotelReservation | null>(null);
  const padRef = useRef<HTMLElement>(null);
  // En celular el pad queda debajo: al elegir un campo, se baja hasta él.
  const focusField = (field: Field) => {
    setActive(field);
    if (window.innerWidth < 768) padRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const balance = reservation ? reservationBalance(reservation) : 0;
  const requiresFiscal = document === 'E31';
  const expectedLength = fiscalType === 'RNC' ? 9 : 11;
  const cashAmount = Number(cash || 0);
  const change = Math.max(0, Math.round((cashAmount - balance) * 100) / 100);

  // El campo activo del pad sigue al método y comprobante elegidos.
  useEffect(() => {
    if (active === 'cash' && method !== 'CASH' && requiresFiscal) setActive('document');
    if (active === 'document' && !requiresFiscal) setActive('cash');
  }, [active, method, requiresFiscal]);
  const padTarget: Field | null =
    active === 'document' && requiresFiscal ? 'document' : method === 'CASH' ? 'cash' : requiresFiscal ? 'document' : null;

  const problems = [
    balance <= 0 ? 'La reservación no tiene balance pendiente.' : null,
    method === 'CASH' && cashAmount < balance ? `El efectivo recibido debe cubrir ${formatMoney(balance)}.` : null,
    requiresFiscal && fiscalNumber.length !== expectedLength
      ? `Digita la ${fiscalType === 'RNC' ? 'RNC (9 dígitos)' : 'cédula (11 dígitos)'} para la factura E31.`
      : null,
  ].filter(Boolean) as string[];

  const pay = useMutation({
    mutationFn: () =>
      recordHotelPayment(session!.tenantId, session!.accessToken, reservationId, {
        amount: balance,
        cashReceived: method === 'CASH' ? cashAmount : undefined,
        method,
        billingDocumentType: document,
        fiscalDocumentType: requiresFiscal ? fiscalType : undefined,
        fiscalDocumentNumber: requiresFiscal ? fiscalNumber : undefined,
      }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['hotel'] });
      toast.success('Cobro registrado correctamente');
      setReceipt(updated);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const pressKey = (key: KeypadKey) => {
    if (padTarget === 'cash') setCash((value) => applyAmountKey(value, key));
    if (padTarget === 'document') setFiscalNumber((value) => applyDigitsKey(value, key, expectedLength));
  };
  /** Atajos de efectivo: "Exacto" fija el balance; los demás suman al monto recibido. */
  const addCash = (amount: number) =>
    setCash((value) => String(Math.round((Number(value || 0) + amount) * 100) / 100));

  // Teclado físico (tablet con teclado o computadora): números, punto y borrar sobre el campo activo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'SELECT') return;
      const map: Record<string, KeypadKey> = { Backspace: 'back', Delete: 'clear', '.': '.', ',': '.' };
      const key = /^\d$/.test(event.key) ? (event.key as KeypadKey) : map[event.key];
      if (!key) return;
      event.preventDefault();
      pressKey(key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });


  const back = () => router.push(returnTo);

  if (!session) return <Message text="Inicia sesión nuevamente." />;
  if (reservations.isLoading) return <Message text="Cargando reservación…" />;
  if (!reservation) return <Message text="No encontramos esta reservación." action={back} />;

  const nights = nightsBetween(reservation.checkIn, reservation.checkOut);
  const blockedByDate = !canCollectReservationPayment(reservation);

  return (
    <div className="space-y-3 pb-4">
      <header className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
        <button
          type="button"
          onClick={back}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-700 active:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" /> Volver
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-teal">Ejecutar pago</p>
          <h1 className="truncate text-base font-extrabold">
            {reservation.code} · {reservation.guest.firstName} {reservation.guest.lastName}
          </h1>
          <p className="truncate text-[11px] text-slate-500">
            {reservation.roomType.name}
            {reservation.room ? ` · Hab. ${reservation.room.number}` : ''} · {nights} {nights === 1 ? 'noche' : 'noches'} ·{' '}
            {formatStayDateTime(reservation.checkIn)} → {formatStayDateTime(reservation.checkOut)}
          </p>
        </div>
        <div className="rounded-xl bg-rose-50 px-3 py-1.5 text-right">
          <p className="text-[10px] font-semibold text-rose-700">A pagar</p>
          <p className="text-lg font-extrabold tabular-nums text-rose-700">{formatMoney(balance)}</p>
        </div>
      </header>

      {blockedByDate ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          El cobro se habilita el día de llegada ({formatStayDateTime(reservation.checkIn)}). No se aceptan pagos por
          adelantado.
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)] xl:grid-cols-[minmax(0,1fr)_minmax(19rem,22rem)]">
        {/* ---- Opciones ---- */}
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div>
            <p className="text-xs font-bold text-slate-800">Método de pago</p>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {methods.map(({ value, label, icon: Icon }) => (
                <BigOption
                  key={value}
                  active={method === value}
                  onClick={() => {
                    setMethod(value);
                    if (!documentsByMethod[value].includes(document)) setDocument(documentsByMethod[value][0]);
                    setActive(value === 'CASH' ? 'cash' : 'document');
                  }}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-xs font-bold">{label}</span>
                </BigOption>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-800">Comprobante</p>
            <div className={cn('mt-1.5 grid gap-2', documentsByMethod[method].length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
              {documentsByMethod[method].map((value) => (
                <BigOption
                  key={value}
                  active={document === value}
                  onClick={() => {
                    setDocument(value);
                    if (value === 'E31') setActive('document');
                  }}
                >
                  <FileText className="h-4 w-4" />
                  <span className="text-xs font-bold">{documentLabels[value].title}</span>
                  <span className="text-[10px] leading-tight opacity-80">{documentLabels[value].detail}</span>
                </BigOption>
              ))}
            </div>
          </div>

          {method === 'CASH' ? (
            <FieldBox
              label="Efectivo recibido"
              active={active === 'cash'}
              onSelect={() => focusField('cash')}
              value={cash ? `RD$ ${grouped(cash)}` : ''}
              placeholder="Toca y digita con el pad"
              footer={
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-slate-500">Devuelta</span>
                  <span className="text-lg font-extrabold tabular-nums text-emerald-700">{formatMoney(change)}</span>
                </div>
              }
            />
          ) : null}

          {requiresFiscal ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {(['CEDULA', 'RNC'] as const).map((value) => (
                  <BigOption
                    key={value}
                    compact
                    active={fiscalType === value}
                    onClick={() => {
                      setFiscalType(value);
                      setFiscalNumber('');
                      setActive('document');
                    }}
                  >
                    <span className="text-sm font-bold">{value === 'CEDULA' ? 'Cédula' : 'RNC'}</span>
                  </BigOption>
                ))}
              </div>
              <FieldBox
                label={`${fiscalType === 'RNC' ? 'RNC' : 'Cédula'} del cliente (${expectedLength} dígitos)`}
                active={active === 'document'}
                onSelect={() => focusField('document')}
                value={fiscalNumber}
                placeholder="Toca y digita con el pad"
              />
              <TaxLookupHint documentType={fiscalType} documentNumber={fiscalNumber} />
            </div>
          ) : null}

        </section>

        {/* ---- Pad ---- */}
        <section
          ref={padRef}
          className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm md:sticky md:top-20 md:self-start"
        >
          <div className="rounded-xl bg-slate-900 px-3 py-2 text-right text-white">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {padTarget === 'cash' ? 'Efectivo recibido' : padTarget === 'document' ? (fiscalType === 'RNC' ? 'RNC' : 'Cédula') : 'Monto a cobrar'}
            </p>
            <p className="truncate text-2xl font-extrabold tabular-nums">
              {padTarget === 'cash' ? (cash ? `RD$ ${grouped(cash)}` : 'RD$ 0') : padTarget === 'document' ? fiscalNumber || '—' : formatMoney(balance)}
            </p>
          </div>
          {padTarget === 'cash' ? (
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => setCash(String(balance))}
                className="h-[clamp(2.25rem,5.2vh,2.75rem)] rounded-xl border border-teal/40 bg-teal-light text-sm font-extrabold text-teal-deep active:bg-teal-light/70"
              >
                Exacto
              </button>
              {[100, 200, 500, 1000, 2000].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => addCash(amount)}
                  className="h-[clamp(2.25rem,5.2vh,2.75rem)] rounded-xl border border-emerald-200 bg-emerald-50 text-sm font-extrabold text-emerald-800 active:bg-emerald-100"
                >
                  +{amount.toLocaleString('en-US')}
                </button>
              ))}
            </div>
          ) : null}
          {padTarget ? (
            <NumericKeypad allowDecimal={padTarget === 'cash'} onKey={pressKey} />
          ) : (
            <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">
              No hace falta digitar nada: confirma el cobro con {method === 'CARD' ? 'tarjeta' : 'transferencia'}.
            </p>
          )}
          {problems.length ? <p className="text-center text-xs font-semibold text-amber-700">{problems[0]}</p> : null}
          <button
            type="button"
            disabled={Boolean(problems.length) || blockedByDate || pay.isPending}
            onClick={() => pay.mutate()}
            className="flex h-[clamp(2.75rem,6.5vh,3.5rem)] w-full items-center justify-center gap-2 rounded-2xl bg-teal text-base font-extrabold text-white shadow-md active:bg-teal-dark disabled:opacity-40"
          >
            {pay.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <CircleDollarSign className="h-5 w-5" />}
            Pagar {formatMoney(balance)}
          </button>
        </section>
      </div>

      <PaymentReceiptDialog reservation={receipt} open={Boolean(receipt)} onClose={back} />
    </div>
  );
}

function BigOption({
  active,
  compact,
  onClick,
  children,
}: {
  active: boolean;
  compact?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-2 text-center transition active:scale-[0.98]',
        compact ? 'h-10' : 'min-h-[3.75rem] py-2',
        active ? 'border-teal bg-teal-light text-teal-deep' : 'border-slate-200 bg-white text-slate-600',
      )}
    >
      {children}
    </button>
  );
}

/** Campo que se llena con el pad: tocarlo lo vuelve el destino de las teclas. No abre el teclado del sistema. */
function FieldBox({
  label,
  active,
  onSelect,
  value,
  placeholder,
  footer,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  value: string;
  placeholder: string;
  footer?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border-2 px-3 py-2 transition', active ? 'border-teal bg-teal-light/30' : 'border-slate-200 bg-white')}>
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <span className="text-xs font-bold text-slate-800">{label}</span>
        <span className={cn('block truncate text-xl font-extrabold tabular-nums', value ? 'text-slate-900' : 'text-slate-300')}>
          {value || placeholder}
        </span>
      </button>
      {footer ? <div className="mt-1.5 border-t border-slate-200 pt-1.5">{footer}</div> : null}
    </div>
  );
}

function Message({ text, action }: { text: string; action?: () => void }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
      {text}
      {action ? (
        <button type="button" onClick={action} className="mx-auto mt-4 flex items-center gap-2 font-bold text-teal-deep">
          <ArrowLeft className="h-4 w-4" /> Volver
        </button>
      ) : null}
    </div>
  );
}

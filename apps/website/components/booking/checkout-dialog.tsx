'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Clock,
  CreditCard,
  FileText,
  IdCard,
  Loader2,
  Lock,
  Phone,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { formatLong, money } from '@/lib/dates';
import type { Quote, RoomType } from '@/lib/types';

export type GuestDetails = {
  firstName: string;
  lastName: string;
  documentType: 'CEDULA' | 'PASSPORT';
  documentNumber: string;
  phone: string;
  notes: string;
};

export type CardSummary = { last4?: string; brand?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  room: RoomType;
  checkIn: string;
  checkOut: string;
  guestsLabel: string;
  quote: Quote;
  guest: GuestDetails;
  onGuestChange: (guest: GuestDetails) => void;
  /** Envía la reserva pagada al ERP. Devuelve un mensaje de error o null si todo salió bien. */
  onPay: (card: CardSummary) => Promise<string | null>;
};

function cardBrand(number: string) {
  if (/^4/.test(number)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(number)) return 'Mastercard';
  if (/^3[47]/.test(number)) return 'Amex';
  return '';
}

/**
 * Checkout en dos pasos: datos del huésped y pasarela de pago. La pasarela es una SIMULACIÓN para
 * demostración: no valida la tarjeta ni cobra nada; al "pagar" la reserva llega al ERP ya pagada.
 */
export function CheckoutDialog(props: Props) {
  const { open, onClose, room, quote, guest } = props;
  const [step, setStep] = useState<'details' | 'payment' | 'processing'>('details');
  const [card, setCard] = useState({ number: '', name: '', expiry: '', cvc: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('details');
    setError(null);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && step !== 'processing' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, step, onClose]);

  if (!open) return null;

  const digits = card.number.replace(/\D/g, '');
  const brand = cardBrand(digits);
  const update = (field: keyof GuestDetails) => (event: { target: { value: string } }) =>
    props.onGuestChange({ ...guest, [field]: event.target.value });

  const continueToPayment = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setStep('payment');
  };

  const pay = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setStep('processing');
    // Tiempo de "autorización" de la pasarela simulada.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const failure = await props.onPay({
      last4: digits.length >= 4 ? digits.slice(-4) : undefined,
      brand: brand || undefined,
    });
    if (failure) {
      setError(failure);
      setStep('payment');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-title"
        className="flex max-h-[100dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[92vh] sm:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          {step === 'payment' && (
            <button type="button" onClick={() => setStep('details')} className="rounded-md p-1 text-muted hover:bg-sand" aria-label="Volver a tus datos">
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-sea">
              Paso {step === 'details' ? 1 : 2} de 2
            </p>
            <h2 id="checkout-title" className="font-serif text-xl font-semibold">
              {step === 'details' ? 'Tus datos' : 'Forma de pago'}
            </h2>
          </div>
          {step !== 'processing' && (
            <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-sand" aria-label="Cerrar">
              <X className="h-5 w-5" />
            </button>
          )}
        </header>

        <div className="flex items-center justify-between gap-3 bg-sand px-5 py-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-semibold">{room.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden />
              {formatLong(props.checkIn)} → {formatLong(props.checkOut)} · {props.guestsLabel}
            </p>
          </div>
          <p className="shrink-0 text-right">
            <span className="block text-xs text-muted">Total</span>
            <span className="font-bold text-sea-dark">{money(quote.total)}</span>
          </p>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          {step === 'details' && (
            <form id="checkout-details" onSubmit={continueToPayment} className="space-y-4">
              <p className="text-[13px] text-muted">Cuéntanos quién se hospeda para preparar tu llegada.</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre" icon={User} value={guest.firstName} onChange={update('firstName')} placeholder="Ej. Juan" autoComplete="given-name" required maxLength={80} />
                <Field label="Apellido" icon={User} value={guest.lastName} onChange={update('lastName')} placeholder="Ej. Pérez" autoComplete="family-name" required maxLength={80} />
              </div>
              <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
                <label className="block min-w-0">
                  <span className="field-label">Documento</span>
                  <span className="field">
                    <IdCard className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <select value={guest.documentType} onChange={update('documentType')}>
                      <option value="CEDULA">Cédula</option>
                      <option value="PASSPORT">Pasaporte</option>
                    </select>
                  </span>
                </label>
                <Field
                  label={guest.documentType === 'CEDULA' ? 'Número de cédula' : 'Número de pasaporte'}
                  icon={IdCard}
                  value={guest.documentNumber}
                  onChange={update('documentNumber')}
                  placeholder={guest.documentType === 'CEDULA' ? '001-1234567-8' : 'Ej. AB1234567'}
                  inputMode={guest.documentType === 'CEDULA' ? 'numeric' : 'text'}
                  pattern={guest.documentType === 'CEDULA' ? '[0-9 -]{11,13}' : '[A-Za-z0-9 -]{5,20}'}
                  title={guest.documentType === 'CEDULA' ? 'Escribe los 11 dígitos de tu cédula' : 'Escribe tu número de pasaporte'}
                  required
                  maxLength={20}
                />
              </div>
              <Field label="Teléfono / WhatsApp" icon={Phone} type="tel" value={guest.phone} onChange={update('phone')} placeholder="829-000-0000" autoComplete="tel" required maxLength={20} />
              <p className="flex items-center gap-2 rounded-lg bg-sand px-3 py-2 text-[13px] text-muted">
                <Clock className="h-4 w-4 shrink-0" aria-hidden />
                Check-in a las 3:00 p. m. · Check-out a las 11:00 a. m.
              </p>
              <label className="block">
                <span className="field-label">
                  Notas adicionales <span className="font-normal text-muted">(opcional)</span>
                </span>
                <span className="field h-auto items-start py-2.5">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <textarea rows={3} maxLength={500} value={guest.notes} onChange={update('notes')} placeholder="Solicitudes especiales, celebraciones, etc." className="resize-none" />
                </span>
              </label>
            </form>
          )}

          {step !== 'details' && (
            <form id="checkout-payment" onSubmit={pay} className="space-y-4">
              {/* Vista previa de la tarjeta */}
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-sea-deep via-sea-dark to-sea p-5 text-white shadow-lg">
                <div className="flex items-start justify-between">
                  <span className="h-8 w-11 rounded-md bg-gradient-to-br from-amber-200 to-amber-400/80" aria-hidden />
                  <span className="text-sm font-bold italic tracking-wide">{brand || 'Tarjeta'}</span>
                </div>
                <p className="mt-6 font-mono text-lg tracking-[0.18em]">
                  {(digits.padEnd(16, '•').match(/.{1,4}/g) ?? []).slice(0, 4).join(' ')}
                </p>
                <div className="mt-4 flex justify-between text-xs uppercase">
                  <span className="truncate pr-3">{card.name || 'Nombre del titular'}</span>
                  <span>{card.expiry || 'MM/AA'}</span>
                </div>
              </div>

              <label className="block">
                <span className="field-label">Número de tarjeta</span>
                <span className="field">
                  <CreditCard className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <input
                    inputMode="numeric"
                    autoComplete="cc-number"
                    placeholder="4242 4242 4242 4242"
                    value={card.number}
                    disabled={step === 'processing'}
                    onChange={(event) => setCard({ ...card, number: event.target.value.replace(/[^\d ]/g, '').slice(0, 23) })}
                  />
                </span>
              </label>
              <label className="block">
                <span className="field-label">Nombre en la tarjeta</span>
                <span className="field">
                  <User className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <input autoComplete="cc-name" placeholder="Como aparece en la tarjeta" value={card.name} disabled={step === 'processing'} onChange={(event) => setCard({ ...card, name: event.target.value })} />
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="field-label">Vencimiento</span>
                  <span className="field">
                    <input autoComplete="cc-exp" placeholder="MM/AA" maxLength={5} value={card.expiry} disabled={step === 'processing'} onChange={(event) => setCard({ ...card, expiry: event.target.value })} />
                  </span>
                </label>
                <label className="block">
                  <span className="field-label">CVC</span>
                  <span className="field">
                    <Lock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <input inputMode="numeric" autoComplete="cc-csc" placeholder="123" maxLength={4} value={card.cvc} disabled={step === 'processing'} onChange={(event) => setCard({ ...card, cvc: event.target.value })} />
                  </span>
                </label>
              </div>
              <p className="flex items-center gap-2 rounded-lg bg-sand px-3 py-2 text-xs text-muted">
                <ShieldCheck className="h-4 w-4 shrink-0 text-sea" aria-hidden />
                Pasarela de demostración: no se realiza ningún cargo real.
              </p>
            </form>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
              {error}
            </p>
          )}
        </div>

        <footer className="border-t border-line px-5 py-4">
          {step === 'details' ? (
            <button type="submit" form="checkout-details" className="btn-primary w-full">
              Continuar al pago
            </button>
          ) : (
            <button type="submit" form="checkout-payment" disabled={step === 'processing'} className={clsx('btn-primary w-full', step === 'processing' && 'disabled:bg-sea')}>
              {step === 'processing' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Procesando pago…
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" aria-hidden /> Pagar {money(quote.total)}
                </>
              )}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & { label: string; icon: typeof User };

function Field({ label, icon: Icon, ...input }: FieldProps) {
  return (
    <label className="block min-w-0">
      <span className="field-label">{label}</span>
      <span className="field">
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <input {...input} />
      </span>
    </label>
  );
}

'use client';

import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | '.' | 'back' | 'clear';

/** Pad numérico grande para tablet. `allowDecimal` muestra el punto; si no, la tecla es "00". */
export function NumericKeypad({
  onKey,
  allowDecimal = false,
  disabled = false,
  className,
}: {
  onKey: (key: KeypadKey) => void;
  allowDecimal?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const keys: KeypadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDecimal ? '.' : '00', '0', 'back'];
  return (
    <div className={cn('grid grid-cols-3 gap-1.5', className)} role="group" aria-label="Teclado numérico">
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          // Evita que el botón robe el foco del campo activo.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onKey(key)}
          aria-label={key === 'back' ? 'Borrar' : key === '.' ? 'Punto decimal' : key}
          className={cn(
            'flex h-[clamp(2.5rem,7vh,3.75rem)] select-none items-center justify-center rounded-xl border text-xl font-bold tabular-nums shadow-sm transition active:scale-[0.97] disabled:opacity-40',
            key === 'back'
              ? 'border-rose-200 bg-rose-50 text-rose-600 active:bg-rose-100'
              : 'border-slate-200 bg-white text-slate-900 active:bg-teal-light',
          )}
        >
          {key === 'back' ? <Delete className="h-6 w-6" /> : key}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onKey('clear')}
        className="col-span-3 h-[clamp(2rem,4.5vh,2.5rem)] rounded-xl border border-slate-200 bg-slate-50 text-sm font-bold uppercase tracking-wide text-slate-600 active:bg-slate-100 disabled:opacity-40"
      >
        Limpiar
      </button>
    </div>
  );
}

/** Aplica una tecla a un monto en texto ("1234.5"): un solo punto y máximo dos decimales. */
export function applyAmountKey(current: string, key: KeypadKey, maxDigits = 9) {
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  if (key === '.') return current.includes('.') ? current : `${current || '0'}.`;
  const [whole, decimals] = current.split('.');
  if (decimals !== undefined && decimals.length + key.length > 2) return current;
  if (decimals === undefined && whole.replace(/^0+/, '').length + key.length > maxDigits) return current;
  const next = current === '0' ? key : current + key;
  return next.replace(/^0+(?=\d)/, '');
}

/** Aplica una tecla a un número de documento (solo dígitos, con largo máximo). */
export function applyDigitsKey(current: string, key: KeypadKey, maxLength: number) {
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  if (key === '.') return current;
  return (current + key).replace(/\D/g, '').slice(0, maxLength);
}

'use client';

import { Delete, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import {
  appendCurrencyInput,
  backspaceCurrencyInput,
  clearCurrencyInput,
  formatCurrencyInputFromNumber,
  parseCurrencyInput,
} from './currency-input';

type PaymentCalculatorProps = {
  total: number;
  amountReceived: string;
  disabled?: boolean;
  onAmountChange: (value: string) => void;
};

const numberKeys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0'];

export function PaymentCalculator({
  total,
  amountReceived,
  disabled = false,
  onAmountChange,
}: PaymentCalculatorProps) {
  function append(value: string) {
    onAmountChange(appendCurrencyInput(amountReceived, value));
  }

  function addAmount(value: number) {
    const current = parseCurrencyInput(amountReceived);
    onAmountChange(formatCurrencyInputFromNumber(current + value));
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="mb-3 rounded-md bg-zinc-950 p-3 text-white">
        <p className="text-xs text-zinc-300">Total a cobrar</p>
        <p className="mt-1 text-2xl font-bold">{formatCurrency(total)}</p>
        <p className="mt-2 text-xs text-zinc-300">
          Recibido: {formatCurrency(parseCurrencyInput(amountReceived))}
        </p>
      </div>

      <div className="mb-3 grid grid-cols-4 gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-12 text-base font-semibold"
          disabled={disabled}
          onClick={() => onAmountChange(formatCurrencyInputFromNumber(total))}
        >
          Exacto
        </Button>
        {[50, 100, 500].map((amount) => (
          <Button
            key={amount}
            type="button"
            variant="outline"
            className="h-12 text-base font-semibold"
            disabled={disabled}
            onClick={() => addAmount(amount)}
          >
            +{amount}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          className="h-12 text-base font-semibold"
          disabled={disabled}
          onClick={() => addAmount(1000)}
        >
          +1000
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-12"
          disabled={disabled}
          onClick={() => onAmountChange(backspaceCurrencyInput(amountReceived))}
        >
          <Delete className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => onAmountChange(clearCurrencyInput())}
          className="col-span-2 h-12 text-base font-semibold"
        >
          <RotateCcw className="h-4 w-4" />
          Limpiar
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {numberKeys.map((key) => (
          <Button
            key={key}
            type="button"
            variant="outline"
            className="h-14 text-lg font-semibold"
            disabled={disabled}
            onClick={() => append(key)}
          >
            {key}
          </Button>
        ))}
        <Button type="button" variant="outline" className="h-14 text-lg font-semibold" disabled>
          .00
        </Button>
      </div>
    </div>
  );
}

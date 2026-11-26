'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  formatCurrencyInput,
  formatCurrencyInputFromNumber,
  sanitizeCurrencyInput,
  parseCurrencyInput,
} from './currency-input';

type PaymentCalculatorProps = {
  total: number;
  amountReceived: string;
  disabled?: boolean;
  onAmountChange: (value: string) => void;
  summary?: ReactNode;
  action?: ReactNode;
};

export function PaymentCalculator({
  total,
  amountReceived,
  disabled = false,
  onAmountChange,
  summary,
  action,
}: PaymentCalculatorProps) {
  return (
    <div className="grid gap-2 rounded-lg border border-zinc-200 bg-white p-2 ">
      <div>
        <Label htmlFor="amountReceived">Monto entregado por el cliente</Label>
        <div className="relative mt-1">
          <Input
            id="amountReceived"
            type="text"
            inputMode="decimal"
            value={amountReceived}
            disabled={disabled}
            onChange={(event) => onAmountChange(sanitizeCurrencyInput(event.target.value))}
            onBlur={(event) => onAmountChange(formatCurrencyInput(event.target.value))}
            onFocus={(event) => event.currentTarget.select()}
            className="h-12 pr-12 text-lg font-semibold"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
            RD$
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-12 text-sm font-semibold"
            disabled={disabled}
            onClick={() => onAmountChange(formatCurrencyInputFromNumber(total))}
          >
            Exacto
          </Button>
          {[100, 200, 500, 1000, 2000].map((amount) => (
            <Button key={amount} type="button" variant="outline"
              className="h-12 text-sm font-semibold" disabled={disabled}
              onClick={() => onAmountChange(formatCurrencyInputFromNumber(parseCurrencyInput(amountReceived) + amount))}>
              +{amount.toLocaleString('en-US')}
            </Button>
          ))}
        </div>
        {summary ? <div className="mt-2">{summary}</div> : null}
      </div>

      <div>{action ? <div className="mt-2">{action}</div> : null}</div>
    </div>
  );
}

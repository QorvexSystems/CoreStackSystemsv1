// Tendered cash and the amount applied to an invoice are different: excess cash is change.
export function paymentSummary({
  total,
  received,
  paymentMethod,
  initialPayment,
  allowPartial,
}: {
  total: number;
  received: number;
  paymentMethod: string;
  initialPayment?: number;
  allowPartial: boolean;
}) {
  const cents = (value: number) => Math.round(value * 100);
  const totalCents = cents(total);
  const receivedCents = cents(received);
  const requiredCents = initialPayment !== undefined
    ? cents(initialPayment)
    : allowPartial && receivedCents > 0
      ? Math.min(totalCents, receivedCents)
      : totalCents;
  return {
    requiredPayment: requiredCents / 100,
    remainingBalance: Math.max(totalCents - requiredCents, 0) / 100,
    received,
    change: paymentMethod === 'CASH' ? Math.max(receivedCents - requiredCents, 0) / 100 : 0,
    valid: receivedCents >= 0 && (paymentMethod === 'CASH'
      ? receivedCents >= requiredCents && (requiredCents !== 0 || receivedCents === 0)
      : receivedCents === requiredCents),
  };
}

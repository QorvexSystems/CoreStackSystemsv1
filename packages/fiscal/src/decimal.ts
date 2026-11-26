/** Fixed-point arithmetic only. Input is never coerced through Number/parseFloat. */
export function scaledDecimal(value: unknown, scale: 2 | 4): bigint {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^(?:0|[1-9]\\d{0,15})(?:\\.\\d{1,${scale}})?$`).test(value)
  ) {
    throw new Error(`Expected decimal string with up to ${scale} fractional digits.`);
  }
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}

export function fixedDecimal(value: bigint, scale: 2 | 4): string {
  if (value < 0n || value >= 10n ** BigInt(16 + scale)) {
    throw new Error('Decimal amount outside the supported range.');
  }
  const text = value.toString().padStart(scale + 1, '0');
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

/** Explicit v1 rounding policy: nonnegative half-up, not a blanket DGII assertion. */
export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('Invalid rounding operands.');
  return (2n * numerator + denominator) / (2n * denominator);
}

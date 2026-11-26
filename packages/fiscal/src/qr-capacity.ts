import type { EcfType, FiscalEnvironment } from './catalog.ts';

export const QR_CAPACITY_BITS = Object.freeze({ 8: 1552, 9: 1856 } as const);
export type DgiiQrVersion = keyof typeof QR_CAPACITY_BITS;
export type DgiiQrContext = Readonly<{
  documentType: EcfType;
  environment: FiscalEnvironment;
}>;

export class DgiiQrCapacityError extends Error {
  readonly code = 'DGII_QR_V9_CAPACITY_EXCEEDED';
  readonly qrVersion = 9;
  readonly errorCorrectionLevel = 'L';
  readonly capacityBits = QR_CAPACITY_BITS[9];
  readonly documentType: EcfType;
  readonly environment: FiscalEnvironment;
  readonly actualBits: number;
  constructor(context: DgiiQrContext, actualBits: number) {
    super(
      `E${context.documentType} ConsultaTimbre payload requires ${actualBits} bits but the authorized QR version 9-L allows ${QR_CAPACITY_BITS[9]} bits.`,
    );
    this.name = 'DgiiQrCapacityError';
    this.documentType = context.documentType;
    this.environment = context.environment;
    this.actualBits = actualBits;
  }
}

/** Exact shortest segmentation for ASCII QR numeric/alphanumeric/byte modes.
 * Versions 8 and 9 share the same character-count widths for these modes.
 */
export function analyzeQr(value: string, version: DgiiQrVersion) {
  if (!/^[\x20-\x7e]{1,1024}$/.test(value) || !Object.hasOwn(QR_CAPACITY_BITS, version))
    throw Error('INVALID_QR_PAYLOAD');
  const costs = Array<number>(value.length + 1).fill(Infinity);
  const previous = Array<number>(value.length + 1).fill(-1);
  costs[0] = 0;
  for (let start = 0; start < value.length; start++) {
    let numeric = true,
      alphanumeric = true;
    for (let end = start + 1; end <= value.length; end++) {
      const char = value[end - 1]!;
      numeric = numeric && /[0-9]/.test(char);
      alphanumeric = alphanumeric && /[0-9A-Z $%*+./:-]/.test(char);
      const n = end - start;
      const bits =
        numeric && n <= 1023
          ? 14 + Math.floor(n / 3) * 10 + [0, 4, 7][n % 3]!
          : alphanumeric && n <= 511
            ? 13 + Math.floor(n / 2) * 11 + (n % 2) * 6
            : n <= 255
              ? 12 + n * 8
              : Infinity;
      if (costs[start]! + bits < costs[end]!) {
        costs[end] = costs[start]! + bits;
        previous[end] = start;
      }
    }
  }
  const segments: string[] = [];
  for (let end = value.length; end > 0; end = previous[end]!) {
    if (previous[end]! < 0) throw Error('INVALID_QR_SEGMENTATION');
    segments.unshift(value.slice(previous[end], end));
  }
  const capacityBits = QR_CAPACITY_BITS[version];
  return Object.freeze({
    segments: Object.freeze(segments),
    minimumBits: costs[value.length]!,
    capacityBits,
    fits: costs[value.length]! <= capacityBits,
    version,
    level: 'L' as const,
  });
}

/** DGII response communicated by the taxpayer: prefer v8-L and use v9-L only
 * when the unchanged payload does not fit v8-L. Never mutate fiscal values.
 */
export function planDgiiQr(value: string, context: DgiiQrContext) {
  const v8 = analyzeQr(value, 8);
  if (v8.fits) return v8;
  const v9 = analyzeQr(value, 9);
  if (!v9.fits) throw new DgiiQrCapacityError(context, v9.minimumBits);
  return v9;
}

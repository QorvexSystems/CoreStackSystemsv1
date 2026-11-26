export function toCurrency(value: number, currency = 'DOP') {
  return new Intl.NumberFormat('es-DO', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export {
  formatDominicanDocument,
  normalizeDominicanDocument,
  validateDominicanCedula,
  validateDominicanDocument,
  validateDominicanRnc,
} from './dominican-documents';

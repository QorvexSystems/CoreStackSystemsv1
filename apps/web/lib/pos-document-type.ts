export type PosDocumentType =
  | 'SALE_NOTE'
  | 'CONSUMER_ELECTRONIC_32'
  | 'FISCAL_CREDIT_ELECTRONIC_31';

export const CASH_DOCUMENT_TYPES = [
  { value: 'SALE_NOTE', label: 'Nota de venta' },
  { value: 'FISCAL_CREDIT_ELECTRONIC_31', label: 'Fiscal E31' },
] as const;

export const ELECTRONIC_DOCUMENT_TYPES = [
  { value: 'CONSUMER_ELECTRONIC_32', label: 'Consumo E32' },
  { value: 'FISCAL_CREDIT_ELECTRONIC_31', label: 'Fiscal E31' },
] as const;

export function getAllowedPosDocumentTypes(paymentMethod: string) {
  return ['CASH', 'TRANSFER'].includes(paymentMethod) ? CASH_DOCUMENT_TYPES : ELECTRONIC_DOCUMENT_TYPES;
}

export function getDefaultPosDocumentType(paymentMethod: string): PosDocumentType {
  return ['CASH', 'TRANSFER'].includes(paymentMethod) ? 'SALE_NOTE' : 'CONSUMER_ELECTRONIC_32';
}

export function normalizePosDocumentType(
  paymentMethod: string,
  documentType: string,
): PosDocumentType {
  const allowed = getAllowedPosDocumentTypes(paymentMethod);
  return allowed.some((option) => option.value === documentType)
    ? (documentType as PosDocumentType)
    : getDefaultPosDocumentType(paymentMethod);
}

export function isElectronicPosDocument(documentType: string) {
  return ['CONSUMER_ELECTRONIC_32', 'FISCAL_CREDIT_ELECTRONIC_31'].includes(documentType);
}

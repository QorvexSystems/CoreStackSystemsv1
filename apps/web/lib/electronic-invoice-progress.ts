type Progress = {
  documentType: string;
  fiscalStatus: string;
  issuedAt?: string | null;
  createdAt: string;
};
export function electronicInvoiceRefreshInterval(invoice?: Progress, now = Date.now()): number | false {
  if (!invoice || !['FISCAL_CREDIT_ELECTRONIC_31','CONSUMER_ELECTRONIC_32'].includes(invoice.documentType)) return false;
  if (['ACCEPTED','CANCELLED'].includes(invoice.fiscalStatus)) return false;
  // An operator/core reconciliation can recover a failed projection later.
  // Keep a slow read-only refresh instead of freezing the page permanently.
  if (['FAILED','REJECTED'].includes(invoice.fiscalStatus)) return 15_000;
  const start = Date.parse(invoice.issuedAt ?? invoice.createdAt);
  // Fast during a normal checkout; back off during long DGII delays rather
  // than repeatedly loading invoice details at high frequency indefinitely.
  const age = now - start;
  if (!Number.isFinite(age) || age < 0) return 2_000;
  return age < 30_000 ? 750 : age < 120_000 ? 2_000 : 5_000;
}
export function isElectronicInvoiceDelayed(invoice: Progress, now = Date.now()) {
  if (!electronicInvoiceRefreshInterval(invoice) || ['FAILED','REJECTED'].includes(invoice.fiscalStatus)) return false;
  const start = Date.parse(invoice.issuedAt ?? invoice.createdAt);
  return Number.isFinite(start) && now - start >= 120_000;
}

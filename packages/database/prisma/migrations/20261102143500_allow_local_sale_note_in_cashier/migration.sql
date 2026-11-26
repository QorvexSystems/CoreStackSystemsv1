BEGIN;

ALTER TABLE "SalesOrder"
  DROP CONSTRAINT IF EXISTS "SalesOrder_fiscal_purpose_document_type_check";

ALTER TABLE "SalesOrder"
  ADD CONSTRAINT "SalesOrder_fiscal_purpose_document_type_check"
  CHECK (
    (
      "fiscalPurpose" = 'CONSUMER'::"FiscalDocumentPurpose"
      AND "fiscalDocumentTypeSnapshot" IN (
        'CONSUMER_02'::"InvoiceDocumentType",
        'CONSUMER_ELECTRONIC_32'::"InvoiceDocumentType",
        'LOCAL_SALE_NOTE'::"InvoiceDocumentType"
      )
    )
    OR
    (
      "fiscalPurpose" = 'FISCAL_CREDIT'::"FiscalDocumentPurpose"
      AND "fiscalDocumentTypeSnapshot" IN (
        'FISCAL_CREDIT_01'::"InvoiceDocumentType",
        'FISCAL_CREDIT_ELECTRONIC_31'::"InvoiceDocumentType"
      )
    )
  );

COMMIT;

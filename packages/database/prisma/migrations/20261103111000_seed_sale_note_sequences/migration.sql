INSERT INTO "FiscalSequence" (
  "id",
  "tenantId",
  "documentType",
  "prefix",
  "startNumber",
  "endNumber",
  "nextNumber",
  "status",
  "createdAt",
  "updatedAt"
)
SELECT
  'sale_note_' || md5(t."id"),
  t."id",
  'SALE_NOTE'::"InvoiceDocumentType",
  'NV',
  1,
  999999999,
  1,
  'ACTIVE'::"FiscalSequenceStatus",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE NOT EXISTS (
  SELECT 1
  FROM "FiscalSequence" fs
  WHERE fs."tenantId" = t."id"
    AND fs."documentType" = 'SALE_NOTE'::"InvoiceDocumentType"
);

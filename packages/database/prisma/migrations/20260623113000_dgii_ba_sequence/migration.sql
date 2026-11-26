UPDATE "FiscalSequence"
SET
  "prefix" = 'BA',
  "startNumber" = 1,
  "endNumber" = 25,
  "nextNumber" = 1,
  "status" = 'ACTIVE',
  "updatedAt" = NOW()
WHERE "documentType" = 'CONSUMER_ELECTRONIC_32'
  AND "status" = 'ACTIVE';

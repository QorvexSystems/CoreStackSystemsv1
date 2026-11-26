CREATE TYPE "ElectronicFiscalRangeSyncStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED');

CREATE TABLE "ElectronicFiscalRange" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "issuerTaxId" TEXT NOT NULL,
  "ecfType" INTEGER NOT NULL,
  "prefix" TEXT NOT NULL,
  "startNumber" BIGINT NOT NULL,
  "endNumber" BIGINT NOT NULL,
  "nextNumber" BIGINT NOT NULL,
  "authorizationNumber" TEXT NOT NULL,
  "authorizedAt" DATE,
  "validUntil" DATE,
  "syncStatus" "ElectronicFiscalRangeSyncStatus" NOT NULL DEFAULT 'PENDING',
  "syncAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastErrorCode" TEXT,
  "remoteRangeId" TEXT,
  "syncedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ElectronicFiscalRange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ElectronicFiscalRange_shape_check" CHECK (
    "ecfType" IN (31,32,33,34,41,43,44,45,46,47)
    AND "prefix" = 'E' || "ecfType"::TEXT
    AND "issuerTaxId" ~ '^([0-9]{9}|[0-9]{11})$'
    AND "startNumber" BETWEEN 1 AND 9999999999
    AND "endNumber" BETWEEN "startNumber" AND 9999999999
    AND "nextNumber" BETWEEN "startNumber" AND "endNumber"
    AND LENGTH(BTRIM("authorizationNumber")) BETWEEN 1 AND 120
    AND ("validUntil" IS NULL OR "authorizedAt" IS NULL OR "validUntil" >= "authorizedAt")
    AND "syncAttempts" >= 0
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z0-9_]{1,80}$')
    AND ("remoteRangeId" IS NULL OR "remoteRangeId" ~ '^[1-9][0-9]{0,18}$')
  )
);

CREATE UNIQUE INDEX "ElectronicFiscalRange_tenant_issuer_type_start_key"
  ON "ElectronicFiscalRange"("tenantId", "issuerTaxId", "ecfType", "startNumber");
CREATE INDEX "ElectronicFiscalRange_tenant_createdAt_idx"
  ON "ElectronicFiscalRange"("tenantId", "createdAt");
CREATE INDEX "ElectronicFiscalRange_syncStatus_nextSyncAt_idx"
  ON "ElectronicFiscalRange"("syncStatus", "nextSyncAt");

ALTER TABLE "ElectronicFiscalRange"
  ADD CONSTRAINT "ElectronicFiscalRange_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ElectronicFiscalRange_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_electronic_fiscal_range_overlap()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."tenantId" || ':' || NEW."issuerTaxId" || ':' || NEW."ecfType"::TEXT, 0
  ));
  IF EXISTS (
    SELECT 1 FROM "ElectronicFiscalRange" existing
    WHERE existing."tenantId" = NEW."tenantId"
      AND existing."issuerTaxId" = NEW."issuerTaxId"
      AND existing."ecfType" = NEW."ecfType"
      AND existing."id" <> NEW."id"
      AND existing."startNumber" <= NEW."endNumber"
      AND existing."endNumber" >= NEW."startNumber"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'electronic fiscal range overlap';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION prevent_electronic_fiscal_range_overlap() FROM PUBLIC;

CREATE TRIGGER "ElectronicFiscalRange_prevent_overlap"
BEFORE INSERT OR UPDATE OF "tenantId", "issuerTaxId", "ecfType", "startNumber", "endNumber"
ON "ElectronicFiscalRange"
FOR EACH ROW EXECUTE FUNCTION prevent_electronic_fiscal_range_overlap();

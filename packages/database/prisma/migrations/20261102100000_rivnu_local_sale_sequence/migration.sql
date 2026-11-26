ALTER TYPE "InvoiceDocumentType" ADD VALUE 'LOCAL_SALE_NOTE';

CREATE TABLE "LocalSaleSequence" (
  "tenantId" TEXT NOT NULL,
  "nextNumber" BIGINT NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LocalSaleSequence_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "LocalSaleSequence_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

REVOKE ALL ON TABLE "LocalSaleSequence" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rivnu_runtime') THEN
    REVOKE ALL ON TABLE "LocalSaleSequence" FROM rivnu_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE "LocalSaleSequence" TO rivnu_runtime;
  END IF;
END
$$;

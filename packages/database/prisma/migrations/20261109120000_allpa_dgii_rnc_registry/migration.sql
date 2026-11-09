CREATE TYPE "DgiiRegistrySource" AS ENUM ('DGII_OFFICIAL', 'TEST_FIXTURE');
CREATE TYPE "DgiiRegistryDatasetStatus" AS ENUM ('IMPORTING', 'READY', 'ACTIVE', 'SUPERSEDED', 'FAILED');
CREATE TYPE "DgiiTaxpayerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEREGISTERED', 'TEMPORARY_CESSATION', 'ANNULLED', 'REJECTED', 'UNKNOWN');

CREATE TABLE "DgiiRegistryDataset" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" "DgiiRegistrySource" NOT NULL,
    "status" "DgiiRegistryDatasetStatus" NOT NULL DEFAULT 'IMPORTING',
    "filename" TEXT,
    "checksumSha256" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "invalidRecordCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    CONSTRAINT "DgiiRegistryDataset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DgiiTaxpayerRecord" (
    "datasetId" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "fiscalName" TEXT NOT NULL,
    "registryStatus" TEXT NOT NULL,
    "status" "DgiiTaxpayerStatus" NOT NULL,
    CONSTRAINT "DgiiTaxpayerRecord_pkey" PRIMARY KEY ("datasetId", "documentType", "documentNumber"),
    CONSTRAINT "DgiiTaxpayerRecord_document_type_check" CHECK ("documentType" IN ('RNC', 'CEDULA'))
);

CREATE UNIQUE INDEX "DgiiRegistryDataset_one_active_idx" ON "DgiiRegistryDataset" ((1)) WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "DgiiRegistryDataset_version_key" ON "DgiiRegistryDataset"("version");
CREATE UNIQUE INDEX "DgiiRegistryDataset_checksumSha256_key" ON "DgiiRegistryDataset"("checksumSha256");
CREATE INDEX "DgiiRegistryDataset_status_idx" ON "DgiiRegistryDataset"("status");
CREATE INDEX "DgiiRegistryDataset_source_sourceUpdatedAt_idx" ON "DgiiRegistryDataset"("source", "sourceUpdatedAt");
CREATE INDEX "DgiiRegistryDataset_activatedAt_idx" ON "DgiiRegistryDataset"("activatedAt");
CREATE INDEX "DgiiTaxpayerRecord_datasetId_status_idx" ON "DgiiTaxpayerRecord"("datasetId", "status");
ALTER TABLE "DgiiTaxpayerRecord" ADD CONSTRAINT "DgiiTaxpayerRecord_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "DgiiRegistryDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allpa_runtime') THEN
    GRANT SELECT ON "DgiiRegistryDataset", "DgiiTaxpayerRecord" TO allpa_runtime;
  END IF;
END $$;

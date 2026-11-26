BEGIN;

CREATE TYPE "CertificationCaseStatus" AS ENUM (
  'DRAFT', 'ACTIVE', 'WAITING_OPERATOR', 'BLOCKED', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE "CertificationStepStatus" AS ENUM (
  'LOCKED', 'READY', 'RUNNING', 'WAITING_OPERATOR', 'SUCCEEDED', 'FAILED', 'SKIPPED'
);
CREATE TYPE "CertificationExecutionMode" AS ENUM ('HUMAN', 'AUTOMATIC', 'MIXED', 'SYSTEM');
CREATE TYPE "CertificationJobStatus" AS ENUM (
  'PENDING', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE "CertificationArtifactKind" AS ENUM (
  'POSTULATION_UNSIGNED_XML', 'POSTULATION_SIGNED_XML', 'ECF_DATA_WORKBOOK',
  'APPROVAL_DATA_WORKBOOK', 'SIGNED_ECF_SET', 'SIGNED_RFCE_SET',
  'SIGNED_APPROVAL_SET', 'SIGNED_SIMULATION_SET', 'PRINTED_REPRESENTATION_ARCHIVE',
  'SWORN_DECLARATION_UNSIGNED_XML', 'SWORN_DECLARATION_SIGNED_XML',
  'PORTAL_EVIDENCE', 'TECHNICAL_REPORT', 'OTHER'
);
CREATE TYPE "CertificationEventActor" AS ENUM ('USER', 'AGENT', 'SYSTEM');

CREATE TABLE "ElectronicCertificationCase" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "issuerRnc" TEXT NOT NULL,
  "legalName" TEXT NOT NULL,
  "commercialName" TEXT NOT NULL,
  "representativeName" TEXT NOT NULL,
  "representativeDocument" TEXT NOT NULL,
  "softwareName" TEXT NOT NULL,
  "softwareVersion" TEXT NOT NULL,
  "receptionUrl" TEXT NOT NULL,
  "approvalUrl" TEXT NOT NULL,
  "authenticationUrl" TEXT NOT NULL,
  "certificateSha256" TEXT,
  "portalReference" TEXT,
  "status" "CertificationCaseStatus" NOT NULL DEFAULT 'DRAFT',
  "currentStep" INTEGER NOT NULL DEFAULT 1,
  "agentEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "lastErrorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ElectronicCertificationCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ElectronicCertificationCase_shape_check" CHECK (
    "issuerRnc" ~ '^([0-9]{9}|[0-9]{11})$'
    AND "representativeDocument" ~ '^([0-9]{9}|[0-9]{11})$'
    AND "currentStep" BETWEEN 1 AND 15
    AND LENGTH(BTRIM("legalName")) BETWEEN 1 AND 200
    AND LENGTH(BTRIM("commercialName")) BETWEEN 1 AND 160
    AND LENGTH(BTRIM("representativeName")) BETWEEN 1 AND 200
    AND LENGTH(BTRIM("softwareName")) BETWEEN 1 AND 120
    AND LENGTH(BTRIM("softwareVersion")) BETWEEN 1 AND 40
    AND "receptionUrl" ~ '^https://'
    AND "approvalUrl" ~ '^https://'
    AND "authenticationUrl" ~ '^https://'
    AND ("certificateSha256" IS NULL OR "certificateSha256" ~ '^[a-f0-9]{64}$')
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z0-9_]{1,80}$')
  )
);

CREATE UNIQUE INDEX "ElectronicCertificationCase_one_open_per_tenant_key"
  ON "ElectronicCertificationCase"("tenantId")
  WHERE "status" NOT IN ('COMPLETED', 'CANCELLED');
CREATE INDEX "ElectronicCertificationCase_tenant_createdAt_idx"
  ON "ElectronicCertificationCase"("tenantId", "createdAt");
CREATE INDEX "ElectronicCertificationCase_status_updatedAt_idx"
  ON "ElectronicCertificationCase"("status", "updatedAt");

CREATE TABLE "ElectronicCertificationStep" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "stepNumber" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "executionMode" "CertificationExecutionMode" NOT NULL,
  "status" "CertificationStepStatus" NOT NULL DEFAULT 'LOCKED',
  "operatorInstruction" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "result" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ElectronicCertificationStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ElectronicCertificationStep_shape_check" CHECK (
    "stepNumber" BETWEEN 1 AND 15 AND "attempts" >= 0
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z0-9_]{1,80}$')
  )
);
CREATE UNIQUE INDEX "ElectronicCertificationStep_caseId_stepNumber_key"
  ON "ElectronicCertificationStep"("caseId", "stepNumber");
CREATE INDEX "ElectronicCertificationStep_caseId_status_idx"
  ON "ElectronicCertificationStep"("caseId", "status");

CREATE TABLE "ElectronicCertificationJob" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "stepId" TEXT,
  "type" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "CertificationJobStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ElectronicCertificationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ElectronicCertificationJob_shape_check" CHECK (
    "type" ~ '^[A-Z0-9_]{1,80}$' AND "attempts" >= 0
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z0-9_]{1,80}$')
  )
);
CREATE UNIQUE INDEX "ElectronicCertificationJob_idempotencyKey_key"
  ON "ElectronicCertificationJob"("idempotencyKey");
CREATE INDEX "ElectronicCertificationJob_status_nextRunAt_idx"
  ON "ElectronicCertificationJob"("status", "nextRunAt");
CREATE INDEX "ElectronicCertificationJob_caseId_createdAt_idx"
  ON "ElectronicCertificationJob"("caseId", "createdAt");

CREATE TABLE "ElectronicCertificationArtifact" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "stepId" TEXT,
  "kind" "CertificationArtifactKind" NOT NULL,
  "originalName" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "storageReference" TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ElectronicCertificationArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ElectronicCertificationArtifact_shape_check" CHECK (
    "sizeBytes" BETWEEN 1 AND 104857600
    AND "sha256" ~ '^[a-f0-9]{64}$'
    AND LENGTH(BTRIM("originalName")) BETWEEN 1 AND 255
    AND LENGTH(BTRIM("mediaType")) BETWEEN 1 AND 120
    AND LENGTH(BTRIM("storageReference")) BETWEEN 1 AND 500
    AND "storageReference" !~ '(^|[?&])(password|token|secret|key)='
  )
);
CREATE UNIQUE INDEX "ElectronicCertificationArtifact_caseId_sha256_kind_key"
  ON "ElectronicCertificationArtifact"("caseId", "sha256", "kind");
CREATE INDEX "ElectronicCertificationArtifact_caseId_stepId_createdAt_idx"
  ON "ElectronicCertificationArtifact"("caseId", "stepId", "createdAt");

CREATE TABLE "ElectronicCertificationEvent" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "stepNumber" INTEGER,
  "actor" "CertificationEventActor" NOT NULL,
  "actorId" TEXT,
  "eventType" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ElectronicCertificationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ElectronicCertificationEvent_shape_check" CHECK (
    ("stepNumber" IS NULL OR "stepNumber" BETWEEN 1 AND 15)
    AND "eventType" ~ '^[A-Z0-9_]{1,80}$'
    AND LENGTH(BTRIM("summary")) BETWEEN 1 AND 500
  )
);
CREATE INDEX "ElectronicCertificationEvent_caseId_createdAt_idx"
  ON "ElectronicCertificationEvent"("caseId", "createdAt");

ALTER TABLE "ElectronicCertificationCase"
  ADD CONSTRAINT "ElectronicCertificationCase_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ElectronicCertificationCase_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ElectronicCertificationStep"
  ADD CONSTRAINT "ElectronicCertificationStep_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "ElectronicCertificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ElectronicCertificationStep_completedById_fkey"
    FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ElectronicCertificationJob"
  ADD CONSTRAINT "ElectronicCertificationJob_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "ElectronicCertificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ElectronicCertificationJob_stepId_fkey"
    FOREIGN KEY ("stepId") REFERENCES "ElectronicCertificationStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ElectronicCertificationArtifact"
  ADD CONSTRAINT "ElectronicCertificationArtifact_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "ElectronicCertificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ElectronicCertificationArtifact_stepId_fkey"
    FOREIGN KEY ("stepId") REFERENCES "ElectronicCertificationStep"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ElectronicCertificationArtifact_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ElectronicCertificationEvent"
  ADD CONSTRAINT "ElectronicCertificationEvent_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "ElectronicCertificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;

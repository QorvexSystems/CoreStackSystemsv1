#!/usr/bin/env bash
# Isolated migration contract test; never uses the ERP DATABASE_URL or host ports.
set -euo pipefail
database_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_container="$(docker run --rm -d --network none --memory=256m --cpus=1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=128m \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine)"
trap 'docker stop "$evidence_container" >/dev/null' EXIT
evidence_ready=false
for ((attempt=0; attempt<30; attempt++)); do
  # The init server only opens a Unix socket; TCP means final startup completed.
  if docker exec "$evidence_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then evidence_ready=true; break; fi
  sleep 1
done
if [[ "$evidence_ready" != true ]]; then echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; fi
evidence_psql() { docker exec -i "$evidence_container" psql -X -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 "$@"; }
# Minimal existing table contract: not a claim that the complete migration chain
# or full production schema was exercised.
evidence_psql <<'SQL'
CREATE TABLE "Product" (id text PRIMARY KEY);
CREATE TABLE "SalesOrderItem" (id text PRIMARY KEY, "unitPrice" decimal(12,2));
CREATE TABLE "InvoiceItem" (id text PRIMARY KEY, "unitPrice" decimal(12,2));
INSERT INTO "Product" VALUES ('historical');
INSERT INTO "SalesOrderItem" VALUES ('historical', 95);
INSERT INTO "InvoiceItem" VALUES ('historical', 95);
SQL
evidence_psql < "$database_root/prisma/migrations/20260920120000_capture_sales_fiscal_evidence/migration.sql"
evidence_psql <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Product" WHERE "fiscalItemKind" IS NOT NULL) OR
     EXISTS (SELECT 1 FROM "SalesOrderItem" WHERE "originalUnitPrice" IS NOT NULL OR "fiscalItemKind" IS NOT NULL OR "unitPrice" <> 95) OR
     EXISTS (SELECT 1 FROM "InvoiceItem" WHERE "originalUnitPrice" IS NOT NULL OR "fiscalItemKind" IS NOT NULL OR "unitPrice" <> 95)
  THEN RAISE EXCEPTION 'Historical evidence was invented or totals changed'; END IF;
END $$;
INSERT INTO "SalesOrderItem" VALUES ('new', 95, 100, 'GOOD');
INSERT INTO "InvoiceItem" SELECT * FROM "SalesOrderItem" WHERE id='new';
INSERT INTO "InvoiceItem" VALUES ('maximum',9999999999.99,9999999999.99,'SERVICE');
BEGIN;
INSERT INTO "InvoiceItem" VALUES ('rolled-back',95,100,'GOOD');
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "InvoiceItem" WHERE id='rolled-back') OR
     NOT EXISTS (SELECT 1 FROM "InvoiceItem" WHERE id='new' AND "unitPrice"=95 AND "originalUnitPrice"=100 AND "fiscalItemKind"='GOOD')
  THEN RAISE EXCEPTION 'Roundtrip or rollback failed'; END IF;
  BEGIN
    INSERT INTO "InvoiceItem" VALUES ('invalid',1,-1,'GOOD');
    RAISE EXCEPTION 'Negative original price was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE "Product" SET "fiscalItemKind"='UNKNOWN';
    RAISE EXCEPTION 'Invalid classification was accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;
END $$;
SQL
echo 'PASS: additive evidence migration, historical NULLs, decimal range, copy, rollback and constraints.'

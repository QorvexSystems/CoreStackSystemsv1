UPDATE "Membership"
SET "role" = 'ADMIN'
WHERE "role" IN ('COMPANY_ADMIN', 'MANAGER', 'ACCOUNTANT', 'INVENTORY', 'VIEWER');

ALTER TYPE "Role" RENAME TO "Role_old";

CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'CASHIER', 'QORVEX_SUPER_ADMIN');

ALTER TABLE "Membership"
  ALTER COLUMN "role" TYPE "Role"
  USING "role"::text::"Role";

DROP TYPE "Role_old";

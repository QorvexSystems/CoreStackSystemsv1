-- Rebrand the internal platform/provider tenant from Qorvex to CoreStack.
UPDATE "Tenant"
SET
  "name" = 'CoreStack',
  "commercialName" = 'CoreStack',
  "legalName" = 'CoreStack SRL',
  "slug" = CASE
    WHEN NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "slug" = 'corestack') THEN 'corestack'
    ELSE "slug"
  END,
  "email" = 'soporte@corestack.local'
WHERE "slug" = 'qorvex-systems' OR "name" = 'Qorvex Systems';

UPDATE "CompanyBranding"
SET "loginTitle" = 'CoreStack Core'
WHERE "tenantId" IN (
  SELECT "id"
  FROM "Tenant"
  WHERE "slug" IN ('corestack', 'qorvex-systems') OR "name" IN ('CoreStack', 'Qorvex Systems')
);

UPDATE "User"
SET "email" = 'superadmin@corestack.local'
WHERE "email" = 'superadmin@qorvex.local'
  AND NOT EXISTS (SELECT 1 FROM "User" WHERE "email" = 'superadmin@corestack.local');

UPDATE "User"
SET "name" = 'Soporte CoreStack'
WHERE "email" IN ('superadmin@corestack.local', 'superadmin@qorvex.local')
  OR "name" = 'Soporte Qorvex';

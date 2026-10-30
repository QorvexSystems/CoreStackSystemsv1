-- ALLPA catalog prices become tax-exclusive while customer totals remain unchanged.
-- This affects only the ALLPA tenant and only while its old inclusive policy is active.
BEGIN;

UPDATE "Product" AS product
SET
  "price" = round(product."price" / (1 + product."taxRate"), 2),
  "salePrice" = round(product."salePrice" / (1 + product."taxRate"), 2),
  "margin" = CASE
    WHEN product."cost" IS NULL OR
      (CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END) <= 0
      THEN product."margin"
    ELSE round(
      ((CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END)
        / (1 + product."taxRate") - product."cost")
        / ((CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END)
          / (1 + product."taxRate")),
      4
    )
  END
FROM "Tenant" AS tenant
WHERE product."tenantId" = tenant."id"
  AND tenant."slug" = 'allpa'
  AND tenant."salePricesIncludeTax" = true;

INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "metadata", "createdAt")
SELECT
  'allpa_net_catalog_20261030',
  tenant."id",
  'ALLPA_NET_CATALOG_PRICES_ENABLED',
  'Tenant',
  tenant."id",
  jsonb_build_object(
    'taxPolicy', 'SALE_PRICE_EXCLUDES_TAX',
    'convertedProducts', (SELECT count(*) FROM "Product" WHERE "tenantId" = tenant."id")
  ),
  CURRENT_TIMESTAMP
FROM "Tenant" AS tenant
WHERE tenant."slug" = 'allpa' AND tenant."salePricesIncludeTax" = true;

UPDATE "Tenant"
SET "salePricesIncludeTax" = false
WHERE "slug" = 'allpa' AND "salePricesIncludeTax" = true;

COMMIT;

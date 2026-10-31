-- The existing ALLPA catalog amount is the customer's final price.
-- Keep price and salePrice unchanged; only extract ITBIS for fiscal breakdowns.
BEGIN;

UPDATE "Product" AS product
SET "margin" = round(
  (
    (CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END)
      / (1 + product."taxRate") - product."cost"
  ) / (
    (CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END)
      / (1 + product."taxRate")
  ),
  4
)
FROM "Tenant" AS tenant
WHERE product."tenantId" = tenant."id"
  AND tenant."slug" = 'allpa'
  AND tenant."salePricesIncludeTax" = false
  AND product."cost" IS NOT NULL
  AND (CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END) > 0;

INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "metadata", "createdAt")
SELECT
  'allpa_inclusive_catalog_20261031',
  tenant."id",
  'ALLPA_CATALOG_PRICES_INCLUDE_ITBIS',
  'Tenant',
  tenant."id",
  jsonb_build_object(
    'taxPolicy', 'SALE_PRICE_INCLUDES_TAX',
    'unchangedCatalogPrices', (SELECT count(*) FROM "Product" WHERE "tenantId" = tenant."id")
  ),
  CURRENT_TIMESTAMP
FROM "Tenant" AS tenant
WHERE tenant."slug" = 'allpa' AND tenant."salePricesIncludeTax" = false;

UPDATE "Tenant"
SET "salePricesIncludeTax" = true
WHERE "slug" = 'allpa' AND "salePricesIncludeTax" = false;

COMMIT;

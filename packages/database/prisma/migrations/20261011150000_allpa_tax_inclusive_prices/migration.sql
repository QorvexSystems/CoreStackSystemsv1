-- ALLPA advertises and enters final sale prices with ITBIS already included.
-- Other tenants keep the existing net-price behavior.
ALTER TABLE "Tenant"
ADD COLUMN "salePricesIncludeTax" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Tenant"
SET "salePricesIncludeTax" = true
WHERE "slug" = 'allpa';

UPDATE "Product" AS product
SET
  "price" = round(product."price" * (1 + product."taxRate"), 2),
  "salePrice" = round(
    (CASE WHEN product."salePrice" > 0 THEN product."salePrice" ELSE product."price" END)
      * (1 + product."taxRate"),
    2
  ),
  "margin" = CASE
    WHEN product."cost" IS NULL OR product."price" <= 0 THEN product."margin"
    ELSE round((product."price" - product."cost") / product."price", 4)
  END
FROM "Tenant" AS tenant
WHERE product."tenantId" = tenant."id"
  AND tenant."slug" = 'allpa';

INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "metadata", "createdAt")
SELECT
  'allpa_tax_inclusive_20261011',
  tenant."id",
  'ALLPA_TAX_INCLUSIVE_PRICES_ENABLED',
  'Tenant',
  tenant."id",
  jsonb_build_object(
    'taxPolicy', 'SALE_PRICE_INCLUDES_TAX',
    'convertedProducts', (
      SELECT count(*)
      FROM "Product" product
      WHERE product."tenantId" = tenant."id"
    )
  ),
  CURRENT_TIMESTAMP
FROM "Tenant" tenant
WHERE tenant."slug" = 'allpa';

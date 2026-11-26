# Importador del catálogo web (aislado)

Estado: código y pruebas listos; **no aplicado a ninguna base**. La migración `20261028120000_web_catalog_grouping` está generada y sin ejecutar.

## Modelo
- `WebProduct`: grupo comercial (174). Sin precio ni existencias. `published=false` por defecto.
- `Product`: cada variante (312) con su precio e inventario. `webProductId`, `webOptions`, `legacyEcommerceVariantId`, `legacyShopifyVariantId` (solo procedencia), `originalSku`, `webAvailability` (`UNDECIDED` hasta decidir).
- Los IDs de Shopify nunca se escriben en `shopifyProductId` / `shopifyVariantId`.

## Uso
```
pnpm --filter @qorvex/database import:web-catalog -- --catalog=<catalog.normalized.json>            # dry-run (por defecto, sin base)
pnpm --filter @qorvex/database test:web-catalog                                                       # pruebas
```
Modo aislado: solo con una base PostgreSQL local de prueba (nombre con `test`/`isolated`/`sandbox`/`scratch`/`ensayo`), la migración aplicada a mano en esa base, un tenant existente, y en el entorno
`DATABASE_URL` y `WEB_CATALOG_IMPORT_ISOLATED=I_UNDERSTAND_THIS_IS_NOT_THE_REAL_DATABASE`. No se lee ningún `.env`.
Informes en `.tmp/web-catalog-import/` (ignorado por git): `import-report.json` y `sku-mapping.json`.

## Garantías (verificadas por pruebas)
Transacción única; idempotente (reintento = `NO_CHANGES`); conflictos abortan sin escribir; precios sin transformar; registros `INACTIVE`, stock 0 técnico, sin movimientos ni `InventorySyncJob`; sin llamadas a servicios del API ni a Shopify.

## SKUs
Candidatos no aprobados para una base real (`approvedForRealDatabase: false`). Ver `sku-policy.ts`.


## Base local de prueba (Docker)
Contenedor Docker de pruebas (postgres:16-alpine) enlazado solo a `127.0.0.1`, con su propio volumen.
```
docker start <contenedor-de-pruebas>                 # iniciar
docker stop <contenedor-de-pruebas>                  # detener
docker rm -f <contenedor-de-pruebas>; docker volume rm <su-volumen>   # eliminar SOLO sus recursos
```
Variables (solo credenciales locales de prueba): `DATABASE_URL` y `DIRECT_URL` = `postgresql://<usuario>:<clave>@127.0.0.1:<puerto>/<base>_test` (el nombre de la base debe llevar `test`, `isolated`, `sandbox`, `scratch` o `ensayo`), y `WEB_CATALOG_IMPORT_ISOLATED=I_UNDERSTAND_THIS_IS_NOT_THE_REAL_DATABASE`.
Esquema: `pnpm exec prisma migrate deploy --schema prisma/schema.prisma`; tenant: una fila en `"Tenant"` con slug `hotel-ancla`.
Integración: `pnpm --filter @qorvex/database test:web-catalog:integration`.

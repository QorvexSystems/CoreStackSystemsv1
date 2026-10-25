# Sincronización del catálogo de AbarrotesPDV a ALLPA — 25 de octubre de 2026

## Fuente y alcance

- ZIP recibido: `AbarrotesPDV (1).zip`, SHA-256 `4003e61a15c6e5b08efb765b78625e52c386b6733339764aec8faaa00025071b`.
- Base activa utilizada: `AbarrotesPDV/db/PDVDATA.FDB`, modificada el 24 de octubre de 2026. Es posterior al respaldo incluido más reciente, del 23 de octubre.
- La base Firebird contiene 753 productos. Nueve pertenecen al departamento eliminado `MERCANCIA FAMILIA` y se excluyeron. Se sincronizaron 744 productos de 14 departamentos activos.
- Archivo extraído y validado: `/opt/corestack/apps/allpa/migration/sync-20261025/source-products.psv`, SHA-256 `8B65106578F9EDBBD80BB18175D143DFFFD5883230917C433B9C3110AF7B827C`.
- Identidad de la primera importación: `/opt/corestack/apps/allpa/migration/abarrotes-products-20261011.psv`, SHA-256 `4A178ACD9B3A753532A6653BBF783D3FBED49BFD97A07B9608BE7BAA6B3E9095`.

## Reglas aplicadas

- Los SKU existentes de la primera importación se actualizaron sin cambiar sus ID. Se conservaron las relaciones de cotizaciones y los movimientos anteriores.
- Los SKU nuevos se crearon con su departamento, costo, precio final con 18% de ITBIS y existencia de la fuente.
- Los productos presentes en ALLPA y ausentes en la fuente nueva se conservaron, sin borrado automático.
- Las diferencias de existencia se registraron como movimientos de inventario con referencia `ALLPA-LEGACY-SYNC-8B65106578F9EDBB`.
- Los productos `CC25` y `EA5414` tenían existencia `-1` en AbarrotesPDV. Se importaron con existencia `0`; la diferencia queda documentada en el lote y el informe.
- La fuente antigua no se reimportó con el procedimiento de reemplazo completo. La nueva sincronización usa `packages/database/prisma/sync-allpa-legacy-products.ts`.

## Resultado en producción

| Concepto | Resultado |
|---|---:|
| Productos existentes actualizados o conciliados | 687 |
| Productos nuevos | 57 |
| Productos de ALLPA ausentes en la nueva fuente, conservados | 28 |
| Total final del catálogo | 772 |
| Filas del lote importadas | 744 de 744; 0 inválidas |
| Movimientos de inventario registrados | 714 |
| Existencia total final | 27,506 unidades |

El lote de importación es `cmvo7p7qc0001pm0nqxt9rlus`. El respaldo PostgreSQL anterior a la operación está en `/opt/corestack/backups/allpa-production/20261025T191857Z/` y se verificó con `pg_restore --list` y SHA-256. El informe de diferencias está en `/opt/corestack/apps/allpa/migration/sync-20261025/dry-run-report.json`.

La operación se probó primero sobre una copia restaurada del respaldo. Después de aplicarla en producción se verificaron los 744 precios con ITBIS, las existencias, los departamentos, los 715 ID anteriores, el lote, la cotización existente y la salud de API y web.

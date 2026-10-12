# Análisis de migración de AbarrotesPDV a ALLPA

Fecha del análisis: 11 de octubre de 2026.

## Fuente seleccionada

El archivo `AbarrotesPDV.zip` contiene una base activa Firebird 1.5 y respaldos diarios.

- Base activa: `AbarrotesPDV/db/PDVDATA.FDB`.
- Formato original: Firebird ODS 10.1.
- Última venta en la base activa: 12 de septiembre de 2026 a las 12:41:17.
- Respaldo más reciente: `respaldo-11-09-26.fbk`.
- Última venta en el respaldo: 11 de septiembre de 2026 a las 17:44:48.
- Resultado: la base activa es la fuente correcta porque contiene información posterior al respaldo.

La base activa fue convertida en un entorno temporal aislado para poder leerla. No se ejecutaron los programas `.exe` incluidos en el ZIP.

## Catálogo encontrado

- 724 productos.
- 724 SKU únicos.
- Todos los productos tienen nombre y precio de venta.
- Precio mínimo: RD$5.00.
- Precio máximo: RD$2,550.00.
- 195 productos tienen costo RD$0.00.
- 3 productos tienen costo mayor que el precio de venta.
- 5 nombres normalizados están duplicados y representan 11 productos con SKU distintos.
- 723 productos tienen tipo de venta `U`.
- 1 producto tiene tipo de venta `D`, aunque su descripción corresponde a un paquete.
- No existen productos temporales con código `COMUN-*` en el catálogo.

## Departamentos

La fuente contiene 16 departamentos. Los productos utilizan 15 de ellos:

| Departamento | Productos | Estado legado |
|---|---:|---|
| DIJES LAMINADOS | 93 | Activo |
| EXHIBIDORES | 89 | Activo |
| CAJAS DE CARTON | 82 | Activo |
| BISUTERIA | 74 | Activo |
| BOLSAS PLASTICAS | 65 | Activo |
| FUNDAS CELOFAN | 63 | Activo |
| CARTONES/EXTRAS EMPA | 58 | Activo |
| BOLSAS PAPEL KRAFT | 52 | Activo |
| PIEZAS LAMINADAS | 50 | Activo |
| BOLSAS TELA | 44 | Activo |
| BASES DE ARETE LAMIN | 20 | Activo |
| JOYERIA HECHA | 12 | Activo |
| MERCANCIA FAMILIA | 9 | Eliminado en el sistema legado |
| ORGANIZADORES | 9 | Activo |
| CADENAS LAMINADAS | 4 | Activo |

El departamento eliminado `piezas laminadas` no tiene productos asociados. En ALLPA estos registros se mostrarán como **Departamentos** y se guardarán mediante la relación existente de categorías de producto.

El departamento eliminado `MERCANCIA FAMILIA` y sus 9 productos no se migrarán. El catálogo resultante tendrá 715 productos distribuidos entre 14 departamentos activos.

## Campos adicionales de la fuente

- Proveedores: la tabla está vacía y los 724 productos usan el identificador `0`.
- Unidades: la tabla de medidas está vacía. Los identificadores guardados en productos son huérfanos, por lo que no ofrecen una equivalencia confiable.
- Impuestos por producto: los 724 productos tienen el campo vacío.
- Impuesto configurado en el programa: existe una tasa general de ITBIS de 18%, pero las ventas históricas revisadas registran impuesto RD$0.00.
- Precio mayorista: 535 productos tienen un precio mayorista positivo.
- Existencias: 699 productos tienen existencia positiva, pero se migrarán con stock cero por decisión de ALLPA.
- Imágenes: no hay imágenes de productos en el ZIP.

Los precios mayoristas no equivalen a los descuentos generales del 5% y 10%:

- Solo 10 productos representan exactamente 5% de descuento.
- Solo 26 productos representan exactamente 10% de descuento.
- Existen 73 porcentajes efectivos distintos.

## Comparación con el catálogo actual de ALLPA

- ALLPA tiene 727 productos.
- Los 724 productos legados están presentes actualmente.
- Los 724 coinciden exactamente en SKU, nombre, costo y precio.
- El catálogo actual no tiene categorías asignadas.
- Hay tres productos adicionales de prueba:
  - `6888361425939` — Caja met Nav.
  - `ALL-CELO-30X4-0727` — Celofan 30x40cm.
  - Un producto sin SKU llamado Exhibidor.

Al reemplazar el catálogo, esos tres productos desaparecerán salvo que se solicite conservarlos expresamente.

## Limitaciones del importador anterior

El importador existente `packages/database/prisma/import-allpa-products.ts` conserva SKU, nombre, costo, precio y existencias, pero omite:

- Categoría.
- Precio mayorista.
- Unidad legada.
- Proveedor.
- Configuración tributaria.

Además, importa las existencias del sistema antiguo. Debe modificarse para establecer `stock = 0` y no crear movimientos de inventario inicial.

## Reglas ya acordadas

- No se respaldará el catálogo actual porque contiene datos de prueba.
- El catálogo actual será reemplazado completamente.
- El stock migrado será cero para que ALLPA registre el inventario físico real.
- El campo legado `DEPT` se migrará como Departamento del producto.
- Solo se crearán los 14 departamentos activos que tienen productos migrables.
- `MERCANCIA FAMILIA` y sus 9 productos se excluirán porque el departamento estaba eliminado.
- Los costos en cero se conservarán como RD$0.00, sin estimarlos ni sustituirlos.
- Los costos superiores al precio de venta se conservarán exactamente como aparecen en la fuente para su revisión posterior.
- Los 715 productos se importarán con unidad `UNIT`. La presentación continuará formando parte del nombre del producto.
- El código legado se conservará tanto como SKU como código de barras para mantener la identificación y el escaneo.
- Marca no se usará en el catálogo de ALLPA.
- El precio mayorista legado (`MAYOREO`) se ignorará.
- La configuración tributaria legada (`IMPUESTOS`) se ignorará en esta migración.
- La modificación de precios para incluir ITBIS se realizará después de validar la nueva migración.

## Dry-run final

El dry-run se completó el 11 de octubre de 2026 sin modificar PostgreSQL.

- Archivo preparado: `/opt/corestack/apps/allpa/migration/abarrotes-products-20261011.psv`.
- SHA-256: `4A178ACD9B3A753532A6653BBF783D3FBED49BFD97A07B9608BE7BAA6B3E9095`.
- Filas validadas en la fuente: 724.
- Productos excluidos: 9.
- Productos que se importarán: 715.
- Departamentos activos que se crearán: 14.
- Productos actuales que se reemplazarán: 727.
- Stock total que se importará: 0.
- Productos migrables con costo cero: 187.
- Productos migrables con costo superior al precio: 3.
- Nombres duplicados permitidos: 5.
- Precio total unitario conciliado: RD$150,084.00.

## Ejecución final

La migración se ejecutó el 11 de octubre de 2026 y PostgreSQL confirmó el lote `cmv4h4nen0001mh0ns7mdp2vf` con estado `IMPORTED`.

- Productos importados: 715.
- Filas inválidas: 0.
- Departamentos creados: 14.
- Productos sin departamento: 0.
- Productos con una unidad distinta de `UNIT`: 0.
- Productos con stock distinto de cero: 0.
- Productos con marca: 0.
- Diferencias entre SKU y código de barras: 0.
- Departamento `MERCANCIA FAMILIA`: ausente.
- Sus 9 SKU fueron comprobados individualmente y están ausentes.
- Tres productos adicionales de prueba: eliminados.
- Productos con costo cero preservados: 187.
- Productos con costo superior al precio preservados: 3.

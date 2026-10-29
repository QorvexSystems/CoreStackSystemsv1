# Mejoras implementadas en la demo de Unique Personalizado

## Alcance

Se conserva la estructura de CoreStack y todos los módulos existentes. Se mantiene el nombre **Toma de órdenes**. Se excluyen expresamente el endurecimiento de Supabase/RLS y los cambios de cuentas globales entre empresas. Despliegue, correo real y proveedor e-CF siguen pendientes.

## Cambios implementados

1. **Catálogo e inventario.** Un producto comparte catálogo y precios; tienda y fábrica conservan existencias y reservas separadas. Las órdenes reservan en su ubicación y el cobro consume esa reserva. Los ajustes y transferencias no pueden consumir existencias reservadas. Las transferencias generan movimientos enlazados en ambas ubicaciones. Las compras sin orden de compra también permiten escoger dónde recibir.
2. **Operación por rol.** Toma de órdenes consulta catálogo, clientes, facturas y cola compartida, factura desde caja y cobra balances. La configuración del rol conserva estos permisos. Fábrica recibe datos de fabricación mediante proyecciones explícitas, sin precios, costos o pagos, incluso en respuestas de acciones. El cambio de sesión limpia la caché del navegador. Se protege la permanencia de una administradora activa.
3. **Facturas y cobros.** Crear la orden genera su documento pendiente/borrador; el cobro emite su NCF de prueba sobre la misma factura. No se cuentan borradores como venta o deuda emitida. Se permiten anticipos sin abrir una línea de crédito y abonos por efectivo, tarjeta o transferencia. Los abonos tienen comprobante e idempotencia. Se impide emitir documentos manuales que eludan el flujo de venta. Una caja no puede tener dos sesiones abiertas y permite fondo inicial cero.
4. **Producción y entrega.** Se bloquea el avance de órdenes pausadas/con problemas. Diseño y calidad tienen aprobaciones manuales y registro histórico. Volver a fabricación invalida calidad. La entrega desde Kanban y desde despacho usa la misma validación: orden facturada, lista, sin incidencia, calidad aprobada cuando corresponde y saldo liquidado salvo crédito autorizado. Cancelar libera reservas y cancela el borrador; las ventas cobradas se resuelven mediante devolución, no mediante un borrado de inventario.
5. **Empresariales.** Una tarjeta agrupa la orden. Cada destinatario se enlaza con una línea/producto; no se admiten más destinatarios que unidades vendidas. Se pueden editar nombres y mensajes, retirar destinatarios pendientes e importar Excel con SKU cuando hay varios productos. El progreso distingue pendientes, en progreso y terminadas. La entrega parcial se registra por destinatario.
6. **Shopify.** Variantes asociadas por identificador/SKU; actualizar una variante no reemplaza las demás. Precio e inventario disponible salen del ERP. Se consultan moneda y configuración de impuestos de Shopify. Una cola persistente registra cambios pendientes, errores y reintentos; el catálogo muestra su estado. Órdenes y pagos repetidos no duplican cargos o descuentan inventario otra vez. Reembolsos se enlazan a líneas originales, se registran una sola vez y solo reponen cuando Shopify indica reintegro físico. Cambios comerciales posteriores se señalan para revisión. Las entregas completas del ERP tienen envío de fulfillment pendiente/reintentable hacia Shopify.
7. **Devoluciones y documentos.** Búsqueda por factura, orden, documento o nombre; ante múltiples coincidencias se escoge la factura. El reintegro usa la ubicación original por defecto y admite selección administrativa. Los importes reducen deuda/pago neto, y una devolución completa acredita la factura. La personalización queda guardada en las líneas de factura y se imprime desde ese snapshot.
8. **Histórico, reportes y datos demo.** Las importaciones exigen precio histórico, conservan referencia, canal, ubicación, pago y etapa, rechazan referencias repetidas/cabeceras contradictorias y permiten indicar inventario previamente descontado para no consumirlo otra vez. Dashboard diferencia ventas facturadas de cobros, resta devoluciones, descuenta unidades devueltas en rankings y usa la fecha de Santo Domingo para atrasos y períodos. El seed no reinicia stock, contraseñas ni datos de productos existentes.
9. **Verificación.** Suite de regresión, flujo con base real dentro de una transacción que se revierte, comprobaciones HTTP por rol y compilación del monorepo.

## Validación realizada

- Compilación del monorepo, TypeScript y revisión de whitespace: correctas.
- 19 pruebas de regresión, 24 comprobaciones de flujo contra la base demo (rollback confirmado) y 17 comprobaciones HTTP por rol.
- Datos demo existentes verificados: 3 productos, existencias en tienda/fábrica, 3 roles operativos, un cliente empresarial y 2 secuencias de prueba.
- Migración `20261016190000_demo_flow_consistency` aplicada a la demo. No se reiniciaron existencias ni se dejaron las ventas temporales de las pruebas.

## Cómo probar

```powershell
pnpm lint
pnpm build
pnpm --filter @qorvex/api test
pnpm --filter @qorvex/api test:demo
pnpm --filter @qorvex/api test:http
pnpm db:verify:demo
```

- `test`: reglas de precios/personalización, reservas, vista de fábrica, entrega, abonos repetidos y pago Shopify repetido.
- `test:demo`: usa los productos/cuentas demo existentes, crea documentos temporales y revierte toda su transacción. No envía correo ni llama a Shopify. Requiere existencias libres y secuencias demo; en una base remota puede tardar varios minutos.
- `test:http`: inicia una API local en un puerto libre y comprueba respuestas reales por rol con tokens efímeros internos; no cambia cuentas ni contraseñas. No prueba el formulario de login ni la interfaz visual.
- `db:seed:demo` crea los pocos productos/cuentas de ejemplo que falten. No se debe usar `db:seed` para restablecer una demo en uso.

## Importaciones

El archivo `examples/ordenes-abiertas-ejemplo.csv` sirve como plantilla: abrir y guardar como **.xlsx** antes de subirlo. Una fila por producto, referencia compartida para líneas de la misma orden.

- Precio unitario sin ITBIS; se aplica la tasa del producto existente. No es un importador de contabilidad fiscal certificada.
- `inventario descontado=no`: orden pendiente, inventario disponible a reservar; pagado debe ser cero y etapa WAITING.
- `inventario descontado=si`: la existencia cargada ya refleja la venta histórica; no se descuenta ni reserva de nuevo. Permite conservar el pagado y el balance.
- FACTORY exige diseño aprobado. READY de productos personalizados exige diseño y calidad aprobados.
- Pagado es el importe total histórico de la orden, repetido de forma consistente, no un pago por cada línea. Se registra como transferencia histórica; no genera un movimiento en una caja actual.
- Las referencias históricas provenientes de Shopify se distinguen con IMPORT y no se envían como nuevos fulfillments de Shopify.

## Pendientes deliberados y límites de validación

- No se han aplicado cambios de RLS, grants ni protección de cuentas globales entre empresas: bloque 0 excluido.
- Shopify real: faltan credenciales, ubicación y webhooks de la tienda; no se ha verificado publicación en canales, medios remotos o cobros AZUL con una cuenta real. La demo valida eventos simulados, no confirma una integración externa desplegada.
- Correo real desactivado por defecto. Para habilitarlo posteriormente se necesita `ENABLE_EMAIL_DELIVERY=true`, dominio y credenciales válidas.
- e-CF mantiene la simulación de la demo; falta seleccionar e integrar el proveedor. Las secuencias/documentos de prueba no constituyen una emisión fiscal real.
- Cargas de imágenes de la demo local: `PRODUCT_IMAGE_STORAGE=local` (también es el valor por defecto en desarrollo). Evita depender de las credenciales de Storage pendientes. El almacenamiento persistente y URLs públicas de producción se configuran al migrar.
- Despliegue, dominios, backup/recuperación e infraestructura productiva siguen pendientes.
- Las pruebas automatizadas no sustituyen la aceptación visual/operativa del cliente, escáner físico, impresión real o conexión real de Shopify.

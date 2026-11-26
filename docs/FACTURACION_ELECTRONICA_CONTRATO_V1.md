# Contrato ERP → motor fiscal: versión 1

Estado: implementado en `packages/fiscal`, **sin conexión al POS, a Prisma ni a DGII**. Perfil inicial `DOP_BASIC_V1`; todos los resultados siguen siendo borradores no enviables. Cubre mapeo estructural de los diez tipos, no todas sus operaciones ni los casos oficiales de certificación.

## Entradas y responsabilidades

El contrato completo está en `src/contract.ts`. El ejemplo [e31-dop.json](../packages/fiscal/examples/e31-dop.json) contiene datos sintéticos. El adaptador del ERP deberá construir este contrato desde snapshots persistidos, no desde valores de identidad o impuestos proporcionados libremente por el navegador.

| Entrada                                          | Responsabilidad                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `scope` separado del cuerpo                      | Tenant, RNC y ambiente obtenidos del contexto autenticado; producción bloqueada              |
| `version`, `operationId`, `source`               | Versión del contrato, idempotencia e identidad/revisión del documento de origen              |
| `issuer`, `buyer`                                | Identidad fiscal explícita; `fiscalName` no es el nombre operativo del pedido                |
| `issuedOn`, `payment`, `incomeType`, `reference` | Fecha de negocio y datos aplicables al tipo                                                  |
| `lines`                                          | Orden estable, identificadores únicos, clasificación fiscal explícita y decimales en cadenas |
| `expectedTotals`                                 | Cinco totales calculados por el origen que deben reconciliar exactamente con el motor        |
| Reserva externa al cuerpo                        | Alcance, operación, hash, e-NCF, fecha y vencimiento obtenidos del repositorio futuro        |
| `plannedSignatureAt` separado                    | Fecha/hora provisional del borrador con offset `-04:00`; no afirma que exista una firma      |

`buyer` representa el bloque XML `Comprador`; **no** significa que siempre provenga de una fila `Customer`. El adaptador debe resolver el rol correspondiente a la operación, especialmente en compras y pagos al exterior.

Se rechazan campos desconocidos en todos los objetos del contrato. Moneda diferente de DOP, precios con ITBIS incluido, valores monetarios JS `number`, cantidades no positivas, ids de línea duplicados y más de 1000 líneas también se rechazan. El contrato valida formato de identidad, no existencia en DGII, autorización fiscal ni vigencia de verificación; esos controles siguen pendientes en la capa de servicio.

## Flujo de uso

1. `analyzeFiscalRequest(scope, input)` analiza el contrato, calcula y compara totales y aplica las reglas del perfil. Devuelve una copia normalizada/congelada y `payloadSha256`. No reserva números ni accede a la base.
2. El servicio futuro persistirá ese snapshot y obtendrá una reserva transaccional usando el mismo hash, operación, fecha y alcance. El hash se calcula antes de asignar e-NCF, con claves ordenadas y decimales normalizados; conserva el orden de líneas e incluye empresa/ambiente/revisión.
3. `mapFiscalRequest(...)` comprueba la correspondencia de la reserva y construye los nodos XML ordenados. **No** comprueba por sí solo el XSD ni demuestra que la reserva exista en la base.
4. `prepareMappedEcfDraft(..., validator)` añade la validación XSD real. Usar `XmllintDraftValidator` en ejecución, nunca un validador simulado del cliente. Devuelve `sendable: false` y mantiene pendientes las comprobaciones fiscales completas, autorización de secuencia, firma y DGII.

El servicio deberá guardar también el timestamp elegido y el XML generado: el hash del pedido no incluye el futuro e-NCF ni el timestamp de firma. Reintentar el mismo pedido no es permiso para regenerar un documento firmado distinto. No hay todavía un servicio que ejecute automáticamente los cuatro pasos.

## Cálculos y reglas incluidas

Se usan enteros escalados `bigint`: cantidad con hasta dos decimales, precio con hasta cuatro, montos con dos. `unitPrice` significa precio **antes del descuento de esta línea**. `discount` es un monto total de línea; se representa como un subdescuento en monto. El perfil emplea redondeo no negativo half-up a centavos por línea y por tasa agregada. Esta política es explícita de implementación, no una afirmación de que DGII exija ese método para todas las operaciones.

El cálculo debe coincidir exactamente con `expectedTotals`; no se aplica tolerancia automática ni se corrigen importes del ERP silenciosamente. `total` es el monto fiscal antes de descontar retenciones, no un cálculo de saldo a pagar.

La base funcional consultada es el [Formato e-CF de DGII, octubre 2025](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Formatos%20XML/Formato%20Comprobante%20Fiscal%20Electr%C3%B3nico%20%28e-CF%29%20V1.0.pdf), especialmente páginas del PDF 7–8, 21–22, 26, 37–38, 42, 45 y 58–59, junto con los XSD versionados. Las reglas implementadas incluyen indicadores de tasa/exención por tipo, descuentos de línea, agregación por tasa, retenciones declaradas y sus sumas, referencias de notas y el indicador de plazo de E34. No se deduce automáticamente qué tasa de retención corresponde legalmente a una operación.

| Tipos         | Cobertura del perfil inicial                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| E31, E32, E45 | Tasas 18/16/0 y exento; contado/crédito; E32 admite comprador anónimo debajo del umbral y determina ruta ECF/RFCE |
| E33           | Ajuste de montos, código 3, con referencia explícita                                                              |
| E34           | Códigos 1/2/3; corrección de texto sin montos; referencia y plazo; ajuste tardío gravado rechazado                |
| E41           | Bloque de retención obligatorio; montos explícitos; ISR en este perfil solo para servicios                        |
| E43           | Exento y contado, sin comprador ni descuentos en este perfil                                                      |
| E44           | Exento, comprador identificado                                                                                    |
| E46           | Tasa cero, comprador identificado; montos expresados en DOP                                                       |
| E47           | Exento, ISR explícito; comprador extranjero si se informa; sin descuentos                                         |

Algunas restricciones son **del perfil**, no prohibiciones generales DGII: comprador requerido en todas las notas de este perfil, crédito no soportado en E43, códigos de débito limitados, notas que referencian otras notas no soportadas. No deben presentarse al usuario como una restricción legal universal.

## Pendientes y límites de integración

No están implementados: moneda extranjera/conversión, impuestos adicionales, propina, no facturables, recargos, descuentos globales o porcentuales, operaciones gratuitas, todo incluido, contingencia, paginación, RFCE y otros XML auxiliares. Tampoco se consulta el comprobante original de una nota ni el saldo acumulado de créditos, identidad original, autorización de un régimen especial, catálogos completos, titularidad del certificado, reloj real de firma o vigencia de la identidad. Los tipos admitidos no equivalen a reglas fiscales exhaustivas.

Antes de conectar las facturas existentes hay dos diferencias concretas que resolver:

- El ERP calcula algunos precios **ya descontados** y conserva `discountTotal` como diferencia informativa con el precio regular (`OrdersService`/`PosService`). Copiar simultáneamente ese precio neto y ese descuento al contrato lo descontaría dos veces. El adaptador implementado exige evidencia del precio original y reconcilia los importes; no reconstruye un precio supuesto. La captura de evidencia en órdenes/POS está implementada con migración pendiente de aplicar. La conexión automática al motor y el productor transaccional siguen pendientes.
- El ERP suma impuestos redondeados por línea en esos flujos; este perfil calcula por base agregada. En importes fraccionarios pueden diferir centavos. Hoy se rechaza la diferencia como `TOTAL_MISMATCH`; se necesita acordar e implementar una política consistente en la integración, con casos oficiales, sin cambiar facturas ya emitidas.

No se asigna automáticamente una `Invoice` B01/B02 a E31/E32. Los demás tipos requerirán orígenes de compras, gastos, notas o exportaciones apropiados, no reutilizar ciegamente ventas del POS. El snapshot actual tampoco reemplaza la autorización del cliente/RNC/ambiente ni un registro de retenciones con fundamento fiscal.

## Verificación

`test/mapper.test.ts` ejecuta casos positivos de los diez tipos con libxml2 real, además de límites decimales, tasas mixtas, descuentos, retenciones, notas, comprador anónimo/identificado, campos no soportados, snapshot inmutable y correspondencia de reserva. Los originales XSD siguen protegidos por hash; E31 conserva su normalización puntual documentada.

Las pruebas son reproducibles con los comandos del [README fiscal](../packages/fiscal/README.md). No consumen secuencias reales ni conectan con DGII.

## Adaptador de ventas ERP implementado

`adaptErpSalesSnapshot` en `src/erp-sales-adapter.ts` transforma una **proyección explícita de un borrador de venta** al contrato v1 y ejecuta `analyzeFiscalRequest`. No recibe objetos Prisma completos, no consulta la base ni lee precios actuales del catálogo. Se expone en el servicio interno de prevalidación instalado en VM4 solo en loopback, todavía sin conexión automática al POS.

El tipo `ErpSalesSnapshot` define la proyección requerida: identidad/revisión/tenant/operación, estado, tipo electrónico, fechas, identidad fiscal del emisor y comprador, líneas y totales persistidos. Los decimales se envían como cadenas. `kind` y el precio original cuando se necesite deben provenir de evidencia persistida, no de inferencias del adaptador. La selección/normalización de los datos y la validación de identidad corresponden al servicio que produzca la proyección. Los snapshots completos y su evidencia de identidad deben conservarse en el expediente, aunque esta proyección use solo los campos necesarios para mapear.

Perfil de origen: `ERP_NET_UNIT_PRICE_V1`, que expresa la semántica revisada de ventas actuales. Solo admite E31/E32 en `DRAFT`, estado fiscal `NOT_APPLICABLE`, sin NCF/e-NCF previo y en ambiente no productivo. **No convierte facturas locales ni reemite facturas existentes.** Los otros ocho tipos conservan sus mapeadores de contrato, pero requieren adaptadores de sus propios orígenes.

Política implementada `EXACT_NO_ADJUSTMENT`:

- Comprueba cantidad × precio neto contra subtotal, categoría contra tasa, impuesto y total por línea, y las cuatro sumas de encabezado.
- Si hay descuento, exige `originalUnitPrice` documentado. Verifica precio original × cantidad − descuento contra el subtotal y emite precio original más descuento exactamente una vez. Si falta la evidencia, devuelve `ORIGINAL_PRICE_EVIDENCE_REQUIRED`; nunca reconstruye un precio dividiendo totales.
- Contrasta impuestos por tasa agregada con la suma de impuestos de las líneas de **cada tasa**. Una diferencia produce `ERP_TAX_ROUNDING_MISMATCH`, incluso si dos tasas se compensan y el total general coincide. No agrega tolerancias ni modifica cantidades, impuestos o precios.
- Devuelve solicitud, hash, cálculo y evidencia de reconciliación separados del origen, congelados. La comprobación de correspondencia de reserva sigue siendo una etapa posterior; este adaptador no consume numeración.

Las diferencias de cálculo quedan controladas mediante rechazo explícito, no resueltas para toda factura histórica. Se prepararon campos Prisma y captura de `originalUnitPrice`/`fiscalItemKind` en líneas de orden/factura, conservando NULL históricos. La migración todavía no se aplicó al ERP. `projectPersistedElectronicSalesDraft` produce la proyección desde borradores Prisma, y está probado conjuntamente con este adaptador, pero no sustituye la autorización del llamante ni crea un snapshot completo inmutable en una transacción.

Faltan el productor transaccional autorizado, la conexión automática al POS/motor y una política consistente de cálculo para nuevos borradores. No se modificaron facturas históricas ni procesos productivos. Los 10 tests del adaptador incluyen recorrido proyección → contrato → XML → XSD, descuentos, diferencias por tasa, consistencia de totales y límites de ámbito/estado. Ver [estado y verificación ampliados](FACTURACION_ELECTRONICA_DESARROLLO.md).

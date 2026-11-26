# Facturación electrónica CoreStack / RIVNU

**Avance RI offline (2026-09-24):** motor de representación desde XML vinculado a firma verificada, fixtures criptográficas de los diez tipos, 168 pruebas del núcleo y cinco pruebas web aprobadas. Muestra E32 HTML/PDF y QR decodificado independientemente. No desplegado ni certificado. URLs E31 largas siguen excediendo QR v8 aun con segmentación óptima; requieren criterio DGII, no un cambio silencioso de versión. Ver [detalle y límites](FACTURACION_ELECTRONICA_RI_QR.md) y matriz vigente.

**Despliegue de impresión (2026-09-24):** preview `ecf-print-20260924`, saludable. Caja permite imprimir un borrador identificado SIN FIRMA / SIN VALIDEZ FISCAL desde el XML persistido y su hash. Cuatro pruebas de impresión/QR y 45 regresiones API aprobadas; preparación remota 8 posterior al despliegue aprobada. Generador QR RFCE sintético decodificado independientemente, separado de Caja; versiones superiores a 8 rechazadas. RI fiscal completa y capacidad de URLs ECF largas pendientes. Ver matriz vigente para límites; producción intacta.

**Avance offline adicional (2026-09-24):** puente `prepareVerifiedDelivery` implementado; ensayo firma XMLDSig sintética → autenticación → PostgreSQL → cliente/gateway → simulador aprobado para E31 y E32/RFCE, incluyendo rechazo, respuesta perdida y caída posterior al envío. 167 pruebas del núcleo y TypeScript aprobados. No desplegado en VM4 ni habilitado contra DGII; consultar la matriz consolidada para los límites y pendientes reales.

**Última entrega (2026-09-24):** preview `ecf-linked-20260923` enlaza borrador persistido + outbox + preparación dentro de una transacción autorizada de Caja. Despachador conectado a VM4; 45 pruebas API, recorrido concurrente y rollback inducido aprobados. Sin cobro, firma ni emisión DGII. Prevalece [el estado consolidado](FACTURACION_ELECTRONICA_ESTADO_ACTUAL.md) sobre las listas históricas inferiores.

**Despliegue posterior del 2026-09-23:** preview API/web `ecf-recovery-20260923` con recuperación automática de preparación remota, ensayo de caída/recuperación aprobado, 37 pruebas API y build aprobados. Esquema de envío instalado solo en la base aislada de VM4, pausado y sin permisos runtime de transmisión. Ver la matriz vigente y `deploy/preview/README.md`; esto no cierra el flujo definitivo de facturas/outbox ni habilita cobros o envíos reales.

**Estado vigente consolidado (2026-09-23):** consultar [la matriz de avances y pendientes](FACTURACION_ELECTRONICA_ESTADO_ACTUAL.md). Sustituye las listas y estados históricos de este documento. Auxiliares, cliente DGII, cola persistente de transmisión/conciliación y contenido del QR implementados y probados localmente; aún sin firmante real, integración definitiva ERP ni despliegue de estos módulos. 164 pruebas del núcleo y restauración SQL sintética completa aprobadas. No listo todavía para completar certificación ni para producción.

Actualizado: 2026-09-22 (pruebas finalizaron el 23 en UTC). Recorrido sintético E32 Caja→VM4 desplegado y probado por API. Persistencia fiscal y preparación sin firma previamente instaladas en VM3/VM4. Sin certificación DGII ni emisión productiva. Las secciones históricas inferiores describen entregas anteriores; prevalece el estado de esta sección.

## Estado vigente: Caja usa el motor remoto de preview

- API del preview conectado por HTTPS verificado a `10.0.0.1:4082`. Servicio separado `corestack-preview-remote-service`, base separada `corestack_preview_remote`, credenciales propias y scope del tenant de preview; ninguna escritura ni rango sintético en VM3.
- Solicitud y modo LOCAL/REMOTE_VM4 congelados por revisión; acuse remoto persistente e inmutable. Timeouts o falta de credencial dejan PENDING, sin fallback local ni numeración nueva. Recuperación mediante la misma operación; consulta GET remota sin mutaciones/reservas.
- Flujo real por HTTP con administrador/cajero demo aprobado: nueva orden, toma en Caja, dos preparaciones simultáneas, generación/validación XSD en VM4, lectura del XML y persistencia local del resultado. Acceso desde otro tenant bloqueado y cobro electrónico bloqueado. Orden `ORD-20260923-024021-E9Y`, preparación 3, modo REMOTE_VM4.
- La preparación 2, inicialmente pendiente por permiso del archivo de token, se recuperó con el mismo ID y documento remoto 1 (`E320000000001`). Corregidos grupo heredado del token y normalización de salto de línea en contraseña del nuevo PostgreSQL. No se expusieron credenciales.
- Detalles de operación, respaldo, vigencia TLS de pruebas, contenedores y límites en `deploy/preview/README.md`.
- API/web del preview desplegados con `corestack/rivnu-api:ecf-remote-ui-20260922`, saludables; login web y health API responden 200. UI indica motor remoto y consulta estado cada tres segundos mientras está pendiente. Compilación Next/API aprobada; 35 pruebas ERP y 121 del núcleo aprobadas, más prueba de timeout/recuperación remota. Interacción visual en navegador no comprobada manualmente. Producción no reiniciada ni migrada.

**Cerrado:** recorrido remoto sintético de Caja E32. **No cerrado:** productor/outbox autónomo del flujo definitivo de facturas, resto de operaciones/reglas fiscales avanzadas, firma, RFCE y otros auxiliares, servicios DGII/intercambio, RI/QR, contingencia y certificación. La numeración es ficticia y no se envía a DGII. La autorización de CoreStack como proveedor tampoco se obtiene con estas pruebas.

## Última entrega: orden → Caja → XML sintético E32

### Avance posterior: transporte distribuido probado, integración POS aún pendiente

El 2026-09-22 se añadió cliente HTTPS de consulta de preparación y resolución de documento desde la outbox ERP por tenant/RNC/ambiente/factura. Comprueba documento/e-NCF, hash del XML, estados de preparación y marca sin firma/no enviable. No sigue redirecciones ni reserva otro número ante 404, timeout o evidencia alterada. La consulta requiere autorización del actor en el controlador ERP; no se ha conectado a Caja.

Ensayo VM2→VM4 con servicio y PostgreSQL desechables en red interna: registro, duplicados simultáneos, generación XSD y recuperación de XML verificado aprobados; token incorrecto y e-NCF esperado incorrecto rechazados. No usa VM3, rangos reales ni secretos de RIVNU. Detalles reproducibles en `packages/fiscal/test/DISTRIBUTED_REHEARSAL.md`. El preview visible sigue usando el mapper local: **no declarar cerrado el punto ERP/POS→VM4**.

La integración local con PostgreSQL/TLS también pasó después de añadir pruebas de respuestas remotas alteradas, redirecciones, ausencia y timeouts. Incidencias del ensayo corregidas: sintaxis TypeScript no soportada por strip-only de Node; ruta de montaje distinta entre imagen de tests y runtime; conexión al contenedor en red interna mediante túnel directo en vez de puerto publicado. Ninguna afectó los servicios fiscales existentes.

- Preview API/web saludables, imagen `corestack/rivnu-api:ecf-synthetic-20260922`; producción no reiniciada ni migrada.
- Migraciones `20260920120000_capture_sales_fiscal_evidence` y `20260921180000_add_fiscal_dispatch_outbox` aplicadas únicamente a `rivnu_dgii_preview`. Tabla adicional aislada `corestack_preview_ecf.preparation` guarda snapshot, revisión, estado y XML de pruebas. No se cargaron rangos en VM3.
- Selector NCF/e-CF en órdenes, captura de precio original y bien/servicio. En Caja: preparación sintética E32, consulta de estado y visor de XML. No habilita cobro electrónico.
- Prueba HTTP con usuarios demo separados (administrador y cajero): producto sintético, orden `ORD-20260922-190611-NSA`, ID `cmud1oodc0007ph071duorcx6`, preparación `1` terminada. Reintentos simultáneos devolvieron el mismo XML, lectura posterior coherente, otro tenant recibió 403 y checkout recibió 400 sin crear factura.
- Pasaron 35 pruebas de órdenes/seguridad/DTO; compilación API y Next con comprobación de tipos. Prueba adicional sin red: bloqueo fuera del preview, E32 contra XSD real adaptado para borrador sin firma, idempotencia terminal y rechazo de totales incoherentes. Interacción visual en navegador aún no verificada manualmente.
- Corregida carrera del frontend: la respuesta de preparación se guarda en la caché de la orden solicitada aunque se cambie de orden mientras responde.
- Respaldo previo: `/opt/corestack/apps/rivnu/preview-ecf-backup.72QyKv/before-ecf.dump`, directorio privado; índice de `pg_restore --list` legible. No equivale a una restauración completa ensayada.

**Límites:** este recorrido ejecuta el mapper/XSD del núcleo dentro del API de preview; NO prueba el transporte distribuido VM2→VM4. Solo E32 menor de RD$250,000, sin comprador; no firma, RFCE, envío DGII ni emisión válida. No sustituye la cobertura avanzada ni los casos oficiales de los diez tipos. Los resultados se etiquetan sintéticos, no firmados y no enviables. La cola ERP creada todavía no tiene productor/consumidor conectado en este recorrido.

Operación del preview: combinar `deploy/docker/compose.preview.dgii.yml` con `deploy/preview/compose.synthetic.yml`, usando el archivo de despliegue existente fuera del repositorio. No usar `initialize`/`seed` ni sustituir producción. Ver `deploy/preview/README.md`.

**Situación portal comunicada por el usuario:** RIVNU está en paso 1, Registrado; lista los diez tipos de e-CF, software PROPIO, nombre/versión/URL y postulación firmada pendientes. No se dispone aún del set oficial asignado. La clasificación PROPIO requiere confirmación por la relación CoreStack–RIVNU. Certificado fiscal pendiente de entrega, distinto de la CA interna TLS.

**Siguiente trabajo real:** conectar productor autorizado y transporte ERP→VM4 en un ámbito de pruebas separado; completar reglas/orígenes de documentos, firma, XML auxiliares/cliente DGII, intercambio y rutas públicas, representación impresa/QR y contingencia; ejecutar casos asignados cuando se habiliten. No se declara terminada la integración ni lista para certificar.

## Objetivo y separación de responsabilidades

CoreStack desarrolla un motor compartido para su ERP, empezando por RIVNU, con vistas a convertirse en proveedor autorizado. Cada empresa mantiene su identidad fiscal y su proceso de autorización. El RNC de CoreStack no sustituye el RNC emisor de los clientes.

La topología es gateway público (VM1, rutas fiscales pendientes), ERP (VM2), persistencia fiscal de precertificación (VM3, instalada) y motor fiscal (VM4, preflight y consumidor instalados). El paquete `packages/fiscal` concentra el núcleo independiente de NestJS/Next; las credenciales se provisionan fuera del repositorio. No hay conexión fiscal productiva habilitada.

La API actual conserva su proveedor simulado y sus bloqueos de emisión electrónica. Las secuencias locales B01/B02 no se mezclan con las nuevas secuencias e-CF. Se añadieron campos Prisma de evidencia fiscal y una migración aditiva, sin aplicarla a ninguna base del ERP y preservando los cambios previos ajenos a esta entrega.

## Dominios y endpoints: diseño pendiente de implementar

**Etapa de infraestructura y persistencia/preparación sin firma cerrada y desplegada.** Login fiscal real desde VM4 con TLS estricto y ámbito correcto; denegaciones de escritura/DDL/escalada, otras bases y conexión sin TLS comprobadas. Tres migraciones aplicadas por el usuario en VM3, con hashes coincidentes. Consumidor arrancado y healthy, sin reinicios, sin puertos, UID 1000 y raíz de solo lectura. Verificadas cinco funciones autorizadas, propietario no administrativo y ocho triggers de evidencia inmutable. 98 pruebas Node, SQL concurrente e integración TLS→registro→XSD→XML aprobadas; TypeScript sin errores. No se cargaron rangos ni se generaron comprobantes reales. Ver [persistencia: garantías, pruebas y límites](FACTURACION_ELECTRONICA_PERSISTENCIA.md). Siguen pendientes productor/transporte ERP/POS, firma, envío DGII, respaldos automatizados/alertas y casos oficiales; no equivalen a esta etapa.

Acceso fiscal: runtime con LOGIN y secreto individual provisionado en VM4; owner/migrator permanecen NOLOGIN. Conexión nueva del ERP verificada después del despliegue con TLSv1.3. Ver [acceso fiscal y relación con las pruebas DGII](FACTURACION_ELECTRONICA_ACCESO_FISCAL.md). No se habilitó emisión ni se consumieron secuencias reales.

Se reutilizará el dominio de cada cliente: por ejemplo, `https://rivnu.corestack-systems.com/fe/…`, en lugar de exigir `fe-rivnu` como nuevo dominio productivo. Otra empresa podrá usar su propio host y el mismo conjunto de rutas. El dominio exacto de Allpa debe verificarse antes de configurarlo; en la conversación aparecen variantes de `corestack-system` y `corestack-systems`.

El gateway resolverá un host de una lista permitida a una empresa configurada. No bastará un encabezado Host para autorizar operaciones. La identidad de la contraparte, el certificado y el RNC del documento deberán validarse; el API interno del ERP no se expondrá como si fuera un endpoint DGII.

Se implementarán los contratos exigidos de autenticación entre emisores, recepción de e-CF, acuse de recibo y aprobación/rechazo comercial, además del cliente saliente de autenticación, envío y consultas DGII. Los paths/métodos exactos deben fijarse contra los manuales vigentes y el registro del portal; `/fe/` es solo la base propuesta, no una afirmación de que DGII imponga esa ruta.

Precertificación, certificación y producción tendrán configuración, credenciales, tokens, rangos, almacenamiento y destinos separados. Los hosts de pruebas no se eliminarán ni redirigirán sin revisar las URL registradas y obligaciones de intercambio. Ningún cambio de ambiente podrá habilitar producción solo por cambiar un hostname o una variable.

## Estado por capacidad

| Capacidad                                                         | Estado de esta entrega                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numeración E31/E32/E33/E34/E41/E43/E44/E45/E46/E47                | Implementada y probada en PostgreSQL desechable                                                                                                   |
| Aislamiento tenant/RNC/ambiente y reintentos de reserva           | Implementado a nivel de núcleo/SQL; falta autorización del servicio                                                                               |
| XML ordenado, escapado y validación local sin red                 | Implementado para borradores; mapeadores de los diez tipos en perfil limitado DOP_BASIC_V1                                                        |
| Contrato ERP→motor v1 y cálculo exacto                            | Adaptador E31/E32, captura de evidencia en órdenes/POS y proyección de borradores implementados; falta productor transaccional y reglas avanzadas |
| XSD E32/E33/E34/E41/E43/E44/E45/E46/E47                           | Fixtures estructurales sintéticos positivos y negativos probados                                                                                  |
| XSD E31                                                           | Validación local resuelta con normalización puntual del nombre de tipo; pruebas positivas y negativas aprobadas                                   |
| RFCE/ARECF/ACECF/ANECF/semilla                                    | XSD versionados; flujos y generadores todavía pendientes                                                                                          |
| Firma/custodia de claves                                          | No implementada; no se almacenaron certificados reales                                                                                            |
| Endpoints, autenticación, envío DGII e intercambio entre emisores | Pendientes; ningún endpoint nuevo abierto                                                                                                         |
| Servicio HTTP interno de prevalidación | Instalado y saludable en VM4, RIVNU/precertificación, solo loopback; autenticación y alcance probados. No es endpoint DGII ni persiste/emite |
| Persistencia y expediente fiscal | Registro atómico, worker con recuperación, XML sin firma inmutable y auditoría probados y desplegados en precertificación. XML firmado y estados DGII son fases posteriores |
| PDF/QR/representación impresa y contingencia                      | Pendientes                                                                                                                                        |
| Casos oficiales de RIVNU y autorización productiva                | Pendientes; no se consumieron secuencias reales                                                                                                   |

Los rangos sintéticos prueban la implementación. Que existan diez tipos en el motor no significa que RIVNU esté autorizada a emitirlos todos en producción. La matriz del portal y los datos asignados a su postulación determinarán los casos oficiales a ejecutar.

## Orden de continuación

### Entorno RIVNU de desarrollo confirmado (2026-09-22)

Se localizó `rivnu-dgii-preview`: web loopback 3101, API loopback 4101 y PostgreSQL sin puerto publicado. La guarda ejecutada en el API confirmó `NODE_ENV=development`, marcador `RIVNU_DGII_PREVIEW_ONLY` y destino exacto `rivnu-dgii-preview-db/rivnu_dgii_preview`; volumen independiente `rivnu-dgii-preview-pgdata`. No usa VM3 ni la base productiva.

El preview sigue en imágenes `dgii-preview-ocr-20260909`, anteriores al selector y al flujo e-CF. Para probar sin borrar sus datos se copió **solo su esquema** a la base temporal `rivnu_fe_schema_test_20260922` dentro del PostgreSQL de preview. Ambas migraciones fiscales nuevas se aplicaron allí correctamente. `packages/database/test/fiscal-preview-schema.sql` comprobó relaciones, columnas de evidencia y snapshot inmutable con registros identificados SYNTHETIC y rollback. Se eliminó únicamente la base temporal creada para esa prueba; el esquema original quedó sin esas migraciones, confirmado por consultas posteriores. No se ejecutaron initialize, seed ni reset del preview existente.

La integración fiscal desechable volvió a pasar (cola ERP, rollback/reintentos/leases, HTTPS estricto, registro, XSD, XML y consulta del artefacto). Es una prueba de componentes, **no una prueba de navegador Caja→XML ni un set oficial DGII**. No se conectó el preview al servicio real de VM4 ni se cargaron rangos en RIVNU. Quedan implementar y desplegar allí el productor autorizado y la pantalla, junto con un motor/base fiscal exclusivamente sintéticos, antes de anunciar el recorrido visible listo.

### Consulta de preparación y revisión de asignación DGII

Implementada en código, sin desplegar, la ruta autenticada `GET /internal/v1/documents/:id/preparation` del receptor. Consulta exclusivamente la función SQL delimitada por el login fiscal; documento inexistente o fuera del ámbito devuelve 404, sin exponer diferencias. Comprueba identificador, estado y SHA-256 del XML antes de devolverlo; `signed:false` y `sendable:false` siempre. Respuestas no-store, concurrencia limitada y errores de infraestructura sanitizados. No equivale a aprobación DGII ni a una pantalla del ERP.

Verificación: 116 pruebas Node aprobadas, TypeScript y la integración PostgreSQL/HTTPS/XSD sintética aprobados. Incluye lectura de XML almacenado, digest alterado rechazado, autenticación y estado pendiente no presentado como validación XSD. No se modificó el servicio desplegado ni se registraron comprobantes reales.

Revisión solicitada por el usuario: no se encontró un set oficial entre los archivos de facturación examinados; la evidencia de instalación local indica `NO_RANGES`. El portal DGII redirige a Login y exige credenciales, por lo que no se pudo comprobar la postulación ni su asignación privada. Esto **no demuestra que DGII no haya asignado casos**. Se solicitó al usuario entrar y compartir una captura del estado/opciones de prueba sin credenciales. La falta de esa evidencia impide ejecutar casos oficiales, no desarrollar el recorrido con fixtures aisladas. Productor autorizado de Caja y pantalla de resultado siguen pendientes; no se declara cerrado el bloque.

### Elección por orden NCF / e-CF (código, no desplegado)

Se incorporó la propuesta del usuario en Toma de Órdenes: selector NCF/e-CF, NCF predeterminado, aviso explícito de preparación electrónica y etiqueta en tickets pendientes. El DTO recibe `fiscalIssuanceMode`; se conserva la familia elegida en `fiscalDocumentTypeSnapshot` existente (B02/E32 provisional), sin una nueva migración ni reservar numeración. Caja sigue siendo responsable del propósito consumidor/crédito fiscal; Toma de Órdenes no confirma identidad fiscal ni emite documentos.

La edición restaura la elección previa y, si un cliente antiguo omite el campo al editar, el backend conserva su familia. Liberar una orden, vencer su reclamo o aceptar una cotización restablece el propósito provisional sin convertir una orden electrónica a B02. Caja muestra el aviso e-CF y el backend bloquea confirmación/cobro electrónico antes de consultar o reservar NCF: no hay conversión silenciosa al flujo local. Esta protección debe permanecer hasta conectar el productor autorizado y completar el flujo electrónico.

Alcance: esta entrega captura y conserva la intención solicitada; **todavía no crea el borrador fiscal en el motor desde Caja ni muestra su XML**. No se ha desplegado al ERP real ni realizado prueba visual de navegador. El siguiente paso continúa siendo el productor autorizado y su recorrido visible de preparación, no habilitar el cobro de estas órdenes.

### Avance del puente ERP → motor (sin desplegar)

**Actualización operativa:** receptor HTTPS de registro desplegado y saludable en VM4, solo `127.0.0.1:4081`, con certificado TLS y token propios; preflight y worker conservados. Verificados montajes protegidos, identidad/clave TLS, conexión fiscal estricta, autenticación y rechazo de contratos inválidos sin reservar e-NCF. 110 pruebas Node e integración SQL/HTTPS sintética aprobadas. La parte **ERP/POS y su cola siguen sin desplegar ni conectar**. Ver [despliegue y límites](FACTURACION_ELECTRONICA_TRANSPORTE_ERP.md).

Continuación: cliente HTTPS estricto, arranque separado del receptor TLS, repositorio y procesador de cola ERP implementados. Migración `20260921180000_add_fiscal_dispatch_outbox` preparada, no aplicada a bases reales. El certificado tributario de RIVNU sigue pendiente de entrega según aclaración del usuario. Ver [transporte ERP, seguridad y pendientes concretos](FACTURACION_ELECTRONICA_TRANSPORTE_ERP.md). Estos componentes aún no están conectados al servicio autorizado de Caja ni desplegados.

Se añadió una fábrica independiente `createFiscalRegistrationServer` con `POST /internal/v1/requests`. Recibe el contrato fiscal v1, no filas Prisma ni una factura B01/B02. Exige token por instancia, fija tenant/RNC/ambiente desde configuración, rechaza producción y valida el contrato antes de ejecutar el registro atómico existente. El preflight instalado conserva únicamente sus rutas de análisis: no adquiere capacidad de escritura.

La respuesta de registro indica `RESERVED`, `persisted:true`, `sendable:false` y `schemaValidated:false`: la validación XSD sucede después en el consumidor. Una respuesta perdida o inválida de persistencia produce `503 REGISTRATION_UNCONFIRMED`, que exige reenviar exactamente la misma operación y contenido; no afirma rollback ni autoriza reservar otro número. Los detalles SQL, XML y credenciales no se devuelven.

Verificación: 102 pruebas Node aprobadas y TypeScript sin errores. Integración en PostgreSQL desechable aprobada: HTTP autenticado → registro con TLS estricto → pérdida simulada de respuesta después del commit → reenvío con el mismo documento/e-NCF → consumidor → XML sin firma validado por XSD y almacenado. No se usaron rangos reales ni la base fiscal de VM3 para esta prueba. Ambos servicios desplegados en VM4 se comprobaron nuevamente saludables; no se cambió su configuración.

Este receptor sigue siendo código probado, **no un servicio desplegado ni un endpoint DGII**. Antes de conectarlo entre VM2 y VM4 faltan: productor ERP transaccional con snapshot/outbox inmutable y autorización, despachador con reintentos, credencial propia, TLS verificado entre hosts, arranque con conexión fiscal validada, configuración/red privada y pruebas de extremo a extremo del POS. No se debe publicar el token sobre HTTP sin TLS entre hosts ni reutilizar la credencial de preflight.

Estado actual: infraestructura y preparación sin firma desplegadas; integración ERP/POS en desarrollo. Después siguen reglas fiscales completas, firma autorizada, XML auxiliares y transporte DGII, intercambio, representación impresa/QR, contingencia y casos oficiales. Respaldos automatizados y alertas continúan pendientes operativos.

Los dos pendientes iniciales están cerrados: compatibilidad local E31 y prueba antigua de identidad fiscal. Las futuras versiones del XSD requieren revisión explícita.

1. Completar el productor transaccional/autorizado de solicitudes fiscales ERP. La captura de precio original/clasificación en órdenes y facturas y la proyección hacia el adaptador ya están en código; no están desplegadas. Falta congelar la solicitud completa y su revisión, verificar identidad vigente, conectar el transporte al POS y definir cálculo coherente para nuevos borradores. Completar adaptadores de los otros orígenes y reglas avanzadas antes de considerarlos completos.
2. Montar el servicio fiscal de pruebas y repositorios: snapshot inmutable, reserva + documento + outbox en una transacción, estados explícitos, control de acceso y recuperación ante fallos. Almacenar XML original, firmado, respuestas y hashes en almacenamiento privado con respaldo y políticas de retención revisadas.
3. Integrar un firmante bajo un modelo contractual/autorizado confirmado. Separar firma de emisión; ninguna clave de cliente en repositorio, logs o variables compartidas. La certificación de proveedor no se tomará como permiso automático para custodiar claves. Las pruebas locales pueden usar material sintético claramente separado.
4. Implementar XML auxiliares, autenticación semilla/token, transporte multipart según especificación, consulta de resultados y políticas de reintento. Un timeout no debe consumir otra secuencia; aceptación técnica, resultado DGII y respuesta comercial son estados distintos.
5. Exponer endpoints de intercambio bajo el dominio de RIVNU en ambiente de pruebas, validar XMLDSig y aislar empresa/ambiente. Incorporar protección de tamaño, tiempos, replay, almacenamiento y auditoría sin datos fiscales sensibles en logs.
6. Representación impresa/QR, contingencia y conciliación; correr el set oficial asignado, conservar evidencias y pasar certificación. Habilitar producción mediante una revisión y despliegue explícitos, nunca como efecto de estos tests.

No se garantiza lectura perfecta de facturas por OCR ni aceptación fiscal por obtener un XML válido. El OCR y la emisión electrónica son subsistemas distintos.

## Verificación de esta entrega

- Núcleo fiscal: 88/88 pruebas Node aprobadas (46 iniciales, 26 de contrato/mapeadores, 10 del adaptador ERP y 6 HTTP), con casos sintéticos y XSD real. TypeScript sin errores. No son los casos oficiales ni prueban aceptación DGII.
- PostgreSQL 17 desechable: pruebas de diez secuencias, límites, aislamiento, idempotencia, vigencia, rollback, concurrencia y permisos aprobadas. Se eliminaron únicamente las bases/contenedores efímeros creados para esas pruebas.
- Regresión acotada del ERP (`fiscal-number.test.ts` y `fiscal-document.test.ts`): 16/16 aprobadas y comprobación TypeScript de ambos archivos sin errores. Se actualizó la llamada antigua a nombre operativo + identidad verificada y se añadieron cuatro casos de regresión; no se modificó la implementación ni se rebajaron validaciones. Los datos de verificación son sintéticos, no consultas reales a DGII.
- Regresión ampliada (`orders-fiscal-intent.test.ts`, `pos-fiscal-dto.test.ts`, `pos-fiscal-security.test.ts`): 31/31 aprobadas con dependencias simuladas. Verifica, entre otras cosas, aislamiento por tenant, control del cajero, identidad inválida/caducada antes de reservar NCF y separación entre toma de órdenes y decisión fiscal. Total del ERP revisado: 47/47; no equivale a una prueba end-to-end ni al conjunto completo del ERP.
- `git diff --check` sin errores. No se ejecutó un build integral del ERP ni el set oficial DGII.
- Se agregó el paquete al chequeo de tipos raíz y al manifiesto copiado por Docker para futuras compilaciones. No se construyó ni desplegó una nueva imagen productiva, ni se aplicaron migraciones al ERP.

Verificación adicional de captura/servicio: 57/57 pruebas ERP (47 anteriores, 5 de evidencia, 2 de persistencia POS simulada y 3 de proyección integrada con el adaptador); TypeScript de API y web sin errores; Prisma validate/generate en contenedor aislado. Migración de evidencia probada sobre tablas mínimas PostgreSQL 17 desechables (no la cadena completa ni una copia de producción). Imagen `corestack/fiscal-preflight:dev-20260920` construida y smoke test de su entrypoint aprobado con usuario no root, filesystem de solo lectura y sin red exterior. Compose validado, no ejecutado en VM4. No se hizo auditoría de vulnerabilidades ni prueba visual de navegador.

## Fuentes y evidencia

- [Documentación oficial DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Paginas/documentacionSobreE-CF.aspx).
- [Portal de certificación](https://ecf.dgii.gov.do/certecf/portalcertificacion).
- [Consulta sobre proveedor compartida por el usuario](https://ayuda.dgii.gov.do/conversations/discusiones/proveedor-de-facturacin-electrnica/65e57091b969fd6095bce883): contexto, no sustituto de normativa/manuales vigentes.
- [Manifest de los XSD descargados](../packages/fiscal/schemas/manifest.json): origen, fecha y SHA-256.
- [Pruebas y límites del núcleo](../packages/fiscal/README.md): comandos reproducibles y normalización E31.

## Incidencias iniciales cerradas

La definición de `IndicadorServicioTodoIncluidoType` no estaba ausente: el atributo `name` de su declaración contiene un espacio inicial. Se corrigió el diagnóstico y se implementó `E31-TYPE-NAME-SPACE-001` en `packages/fiscal/src/schema-compatibility.ts`.

El ajuste se ejecuta únicamente en la copia temporal usada para validar, después de comprobar la integridad del archivo. Está limitado al hash concreto revisado y elimina exactamente un espacio del nombre. No modifica los XSD versionados, no inventa valores fiscales ni altera el XML emitido. Otra versión, aunque tenga un manifest actualizado, exige revisión explícita. Las pruebas confirman que el indicador admite `1` y rechaza valores inválidos, y que su ausencia opcional sigue siendo válida.

E31 queda desbloqueado **para validación local de borradores**. La firma, el set oficial y la aceptación DGII siguen pendientes. No se abrió ningún endpoint ni se desplegó a producción.

La regresión antigua de identidad fiscal también quedó cerrada: el snapshot conserva razón social fiscal, nombre operativo separado, documento normalizado y evidencia de verificación. Los snapshots históricos no adquieren evidencia artificial; una autorización manual conserva su clase y referencia, sin convertirse en verificación automática. La autorización y vigencia de la identidad siguen siendo responsabilidad del servicio llamante, no del helper que copia sus datos.

## Contrato y mapeadores iniciales implementados

El [contrato v1 y su matriz de cobertura](FACTURACION_ELECTRONICA_CONTRATO_V1.md) están implementados en `packages/fiscal/src/contract.ts`, `decimal.ts` y `mapper.ts`. El contrato separa alcance autenticado, contenido, reserva y timestamp provisional de firma; crea un snapshot normalizado/congelado con hash y rechaza campos no soportados.

El perfil `DOP_BASIC_V1` convierte solicitudes de los diez tipos a XML sin firma, calcula con decimales exactos, reconcilia los totales e incluye un subconjunto explícito de reglas por tipo. No transforma automáticamente filas Prisma ni habilita emisión. El set oficial, las reglas completas, firma y envío siguen pendientes.

La revisión del ERP detectó dos asuntos para el siguiente paso: ciertos precios unitarios ya contienen descuentos que también se guardan informativamente, y el ERP suma impuestos redondeados por línea. Copiar los descuentos o sumar impuestos sin reconciliar podría duplicar rebajas o generar diferencias de centavos. Se documentaron; no se modificó la facturación actual ni se acepta una diferencia silenciosamente.

Se implementó `adaptErpSalesSnapshot` para proyecciones de borradores E31/E32. Requiere evidencia de precio original en descuentos, reconcilia todas las líneas/totales e impide aceptar diferencias de redondeo por tasa. No altera los importes ni convierte B01/B02 o documentos ya emitidos. La [documentación del contrato](FACTURACION_ELECTRONICA_CONTRATO_V1.md) detalla la proyección, errores y límites.

## Captura ERP y puente de proyección implementados

- `Product.fiscalItemKind` permite GOOD/SERVICE explícito, sin inferirlo de la unidad o del inventario. El formulario completo de producto y su API permiten clasificar o dejar pendiente; las altas rápidas/importaciones que no lo indiquen quedan pendientes.
- `SalesOrderItem` e `InvoiceItem` conservan `originalUnitPrice` decimal(14,4) y `fiscalItemKind`, ambos opcionales para respetar históricos. Las nuevas órdenes y ediciones capturan evidencia del cálculo; Caja copia la evidencia de la orden, nunca la reconstruye desde el catálogo actual. Las ediciones de una cotización generan nuevas líneas y evidencia de esa edición, no una reconstrucción histórica.
- Migración preparada: `20260920120000_capture_sales_fiscal_evidence`. Debe revisarse y aplicarse explícitamente antes de desplegar el nuevo ERP. No se ejecutó en VM3. Cambiar la clasificación del producto no modifica líneas existentes; los históricos con descuento sin precio original siguen bloqueados para el adaptador.
- `projectPersistedElectronicSalesDraft` transforma Decimals y snapshots persistidos al contrato del adaptador. Solo acepta borradores electrónicos sin emitir; no convierte B01/B02 a e-CF. Se probó conjuntamente con `adaptErpSalesSnapshot`. Es un helper interno, no un endpoint ni un productor autorizado/persistente por sí solo; su llamante deberá cargar el documento bajo autorización, verificar vigencia de identidad y congelarlo transaccionalmente.
- El cálculo de impuestos del POS local no cambió. Las diferencias de redondeo siguen causando rechazo en el motor, sin ajustes silenciosos.

## Contenedor y punto de revisión VM4

CA interna creada por el usuario mediante bootstrap con sudo/contraseña interactiva. Certificado público comprobado en VM3: autofirma válida, CA:TRUE/pathlen:0 y vigencia hasta 2031-09-20 UTC; huella registrada en el documento TLS. El agente no leyó la clave privada ni recibió contraseña. Usuario confirmó respaldo Windows y recuperación satisfactoria el 2026-09-21. Certificado de servidor emitido y activado por el usuario; vence 2027-09-21 UTC. Custodia offline definitiva y limpieza de copias temporales pendientes. Ver [procedimiento y límites de TLS](FACTURACION_ELECTRONICA_TLS_POSTGRESQL.md).

TLS PostgreSQL activado y comprobado desde fiscal-network: CA/IP correctas aceptadas con TLSv1.3; IP incorrecta y CA no confiable rechazadas. CA pública en `/opt/corestack/fe/config/internal-root-2026.crt`, sin claves privadas ni cambio de confianza global. Base/roles/HBA fiscales instalados y autenticación/permisos comprobados. El consumidor usa validación estricta; la URL del ERP no cambió y continúa con sslmode=require. Preflight sigue sin BD y healthy. No se reinició PostgreSQL.

Servicio instalado en VM4 después de que el usuario confirmara datos reales de RIVNU/precertificación y generara personalmente la credencial mediante sudo. Compose en `/opt/corestack/fe/compose/compose.preflight.yml`, imagen en `preflight.env` junto al Compose y configuración en `/opt/corestack/fe/config/preflight.json`. Token montado individualmente y de solo lectura, sin imprimirlo. Preflight no usa BD; el futuro cliente deberá montar la CA pública e imponer validación estricta de identidad/cadena como en la prueba aislada.

Acceso Docker resuelto mediante pertenencia autorizada de luismel al grupo docker. Daemon/red inspeccionados; imagen transferida con ID verificado y pruebas previas aisladas aprobadas. Servicio permanente `corestack-fiscal-preflight-fiscal-preflight-1` running/healthy. Verificados salud 200, falta de credencial 401, análisis E32 sintético 200 y otro RNC rechazado con 422. Usuario 1000:1000, raíz de solo lectura, capacidades eliminadas, publicación solo 127.0.0.1:4080 y reinicio unless-stopped. Se consultaron solo datos identificativos del ERP bajo READ ONLY para corroboración; LOCAL_NCF no cambió. Sudo del host sigue con contraseña; firewall/reinicio y confianza TLS pendientes.

Se preparó un servicio **interno y sin estado**: `GET /health/live`, `POST /internal/v1/analyze` (contrato de los diez tipos) y `POST /internal/v1/sales-drafts/analyze` (adaptador E31/E32). Autenticación mediante token por instancia, alcance provisionado en configuración, límites de entrada/conexiones/tiempo y producción rechazada al arrancar. Devuelve `sendable:false`, `persisted:false`, `schemaValidated:false`; no reserva secuencias ni crea XML, firma o consulta a DGII desde HTTP. El núcleo offline conserva sus generadores y validación XSD.

La imagen creada/probada en VM2 está instalada en VM4 sobre `fiscal-network`, publicada exclusivamente en loopback. No se abrió una ruta Nginx en VM1 ni se configuró acceso desde VM2 al servicio. Solo se montan configuración identificativa y token de servicio; ninguna clave de firma, factura ni credencial PostgreSQL.

SSH a `luismel@10.0.0.1` confirma `CoreStackSystems-VM4-Billing`. Revisión parcial: 4 CPU, 7,8 GiB RAM, 69 GiB libres, NTP sincronizado, directorios restrictivos y Docker 29.8.1 activo. Hay reinicio pendiente. TCP desde el host y desde un contenedor fiscal-network a VM3 10.0.0.4:5432 funciona, pero TLS estricto desde el host falla por certificado autofirmado no confiable; autenticación pendiente. Ver [estado operativo y checklist VM4](FACTURACION_ELECTRONICA_VM4.md). El usuario ejecutará las acciones administrativas del host. No se deshabilitó verificación TLS ni se aplicaron migraciones.

Incidencias de verificación resueltas: espera PostgreSQL corregida para no confundir el servidor temporal de inicialización con el definitivo; contenedor de formateo ajustado al grupo compartido de los archivos, sin cambiar permisos del host. Las bases y contenedores de prueba se eliminaron al finalizar; solo contenían datos sintéticos.

El productor transaccional ERP/POS, transporte al registro fiscal, firma autorizada, XML auxiliares, cola de envío/intercambio DGII, representación impresa y casos oficiales continúan pendientes. La cola desplegada solo prepara XML sin firma. No se declara terminado el plan global ni listo para certificar o emitir.

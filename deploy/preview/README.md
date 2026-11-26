# Preview sintético e-CF

Exclusivo del proyecto `rivnu-dgii-preview`. No usar contra producción ni enviar sus XML a DGII.

## Impresión de prueba — 2026-09-24

Imagen desplegada y saludable: `corestack/rivnu-api:ecf-print-20260924`. Añade «Imprimir borrador sin firma» en Caja después de completar una preparación no obsoleta. Imprime únicamente la evidencia XML ya guardada, con comprobación de hash y leyenda de prueba; no abre un cobro ni un registro de impresión fiscal. Permitir ventanas emergentes para usar el diálogo del navegador. Sin firma, código de seguridad ni QR fiscal en esta impresión.

Pruebas reproducibles: `bash deploy/preview/test-electronic-print.sh`. Instala dependencias de test fijadas en un directorio temporal separado, después ejecuta las pruebas sin red. El arnés usa DOM XML y decodificador QR independientes; no usa credenciales del ERP. Un ensayo adicional ya validó la proyección del XML persistido del preview. El generador de QR de prueba está separado y no aparece en la impresión unsigned; rechaza URLs que no quepan en la versión 8 en lugar de cambiar de versión silenciosamente.

Sin migraciones de base en esta entrega. Rollback de aplicación: cambiar ambas imágenes del override remoto a `ecf-linked-20260923` y ejecutar el comando de actualización exclusiva del preview. No borrar datos ni restaurar la base para revertir esta UI.

## Actualización 2026-09-24: borrador y outbox atómicos

Imagen vigente: `corestack/rivnu-api:ecf-linked-20260923` (API y web). El override remoto inferior ya la selecciona. Sin nueva migración: usa la outbox instalada en el ERP de preview. Respaldo previo: `/opt/corestack/apps/rivnu/preview-linked-backup.wNhzbO/before-link.dump`, índice verificado; no se restauró este respaldo.

El productor de Caja crea un borrador `Invoice`, líneas, outbox y preparación en una sola transacción. La preparación enlaza `order_id` con `snapshot.id` (factura). `SalesOrder.invoiceId` sigue vacío porque no hay venta completada. El despachador registra la solicitud congelada en VM4 y conserva su acuse antes de consultar XML. Las preparaciones antiguas no se migran ni reemiten. No se cobra, firma, mueve inventario ni envía a DGII.

Pruebas reproducibles después del despliegue:

```bash
docker run --rm --network host --entrypoint node -e EXPECT_REMOTE=true \
  -v "$PWD/deploy/preview/test-order-flow.cjs:/test-order-flow.cjs:ro" \
  corestack/rivnu-api:ecf-linked-20260923 /test-order-flow.cjs
docker exec -i rivnu-dgii-preview-api node < deploy/preview/test-linked-dispatch.cjs
```

La primera crea datos sintéticos y verifica concurrencia/aislamiento/bloqueo de cobro. La segunda comprueba relaciones/acuses y provoca un error de encolado dentro de una transacción real: no deben sobrevivir factura, preparación ni outbox. Conserva una orden claramente etiquetada `ROLLBACK-ONLY` como evidencia del ensayo, sin factura.

Rollback de aplicación: volver el override a `ecf-recovery-20260923` y ejecutar únicamente el `up` del preview indicado abajo. No borrar/restaurar datos ni reinicializar volúmenes. Esa imagen anterior ignora el consumo de la outbox: para continuar sus nuevas operaciones enlazadas se debe recuperar la versión enlazada, no confundir ese rollback temporal con cierre de cola. Producción, VM3 y rutas VM1 no se modificaron.

## Estado remoto — 2026-09-22

Caja está conectada por HTTPS al servicio exclusivo de preview en VM4 (`10.0.0.1:4082`). Solicitudes nuevas guardan `execution_mode=REMOTE_VM4`; las preparaciones locales históricas siguen siendo locales. No hay fallback automático a generación local. Un fallo de comunicación conserva la solicitud pendiente y su acuse, si existe; «Preparar» reintenta la misma operación. «Consultar estado» no reserva números ni escribe solicitudes. La interfaz consulta cada tres segundos mientras el resultado está pendiente.

La numeración remota es **sintética**, almacenada en una base nueva `corestack_preview_remote`, no en `rivnu_fiscal_pre` de VM3. El tenant es el del preview, distinto del de producción. Base sin puerto publicado, red interna Docker, contraseña SCRAM propia y runtime sin permisos administrativos/directos sobre las tablas. El enlace entre contenedores DB/servicio dentro de VM4 no usa TLS; no es la configuración de persistencia fiscal productiva de VM3.

Directorio VM4: `/opt/corestack/fe/compose/preview-remote.F1hoTh`. Compose: `deploy/preview/compose.remote-vm4.yml`, ejecutado con `--project-directory` apuntando a ese directorio. Persistencia en volumen del proyecto, sin reinicializarlo. Certificado HTTPS autofirmado de pruebas fijado explícitamente en el cliente, vence **2026-10-23 02:35:21 UTC**: renovar antes de expirar; no sustituye certificado fiscal ni TLS público. Tokens/contraseñas/clave permanecen fuera del repositorio. No se copiaron claves privadas entre VMs.

Cliente VM2: `/opt/corestack/apps/rivnu/preview-remote-client.QFk3lj`, directorio privado; token 0440 con grupo 1007, añadido únicamente al contenedor de API. El directorio padre puede heredar otro grupo: confirmar explícitamente el grupo del token al provisionarlo. Certificado público 0444.

Para mantener el modo remoto, añadir al comando de despliegue inferior:

```bash
PREVIEW_REMOTE_CLIENT_DIR=/opt/corestack/apps/rivnu/preview-remote-client.QFk3lj \
docker compose --env-file /opt/corestack/apps/rivnu/secrets/preview-dgii/deploy.env \
  -f deploy/docker/compose.preview.dgii.yml \
  -f deploy/preview/compose.synthetic.yml \
  -f deploy/preview/compose.remote-client.yml \
  up -d --no-deps --no-build --wait rivnu-dgii-preview-api rivnu-dgii-preview-web
```

`fiscal-remote.sql` ya fue aplicado: modo de ejecución inmutable y acuse remoto que no puede sustituirse después de guardarlo. No reejecutarlo. Respaldo previo: `/opt/corestack/apps/rivnu/preview-remote-backup.kgIyzs/before-remote.dump`; índice legible con pg_restore, no se realizó restauración completa.

Pruebas: orden `cmudhuidt0007mt0745ox8awp`, preparación 2, recuperada conservando su ID tras corregir acceso al token; documento remoto 1, `E320000000001`. Segundo recorrido completo: orden `ORD-20260923-024021-E9Y`, preparación 3, modo REMOTE_VM4, duplicados concurrentes coherentes, otro tenant denegado y checkout bloqueado. Las fechas del número de orden reflejan el comportamiento UTC actual del ERP.

Límites: E32 sintético menor de RD$250,000, sin firma, RFCE, envío DGII ni cobro; preparación activada por el usuario y recuperada automáticamente. La actualización del 24 enlaza facturas/outbox en este ensayo, no en el ciclo comercial productivo. Son rutas segregadas; no declarar terminada la emisión fiscal productiva.

## Acceso

Conservar el túnel SSH del preview con puertos locales 3101 (web) y 4101 (API), hacia VM2. Abrir `http://127.0.0.1:3101`. Usar las cuentas demo documentadas en `docs/DGII_PREVIEW_AISLADO.md`.

Crear un producto de prueba clasificado como bien/servicio. En órdenes seleccionar e-CF, enviar a Caja, tomar la orden con el cajero y usar «Preparar XML sintético E32». No completar el cobro. Este recorrido admite únicamente E32 menor de RD$250,000 y conserva las restricciones de permisos de Caja.

## Despliegue existente

```bash
docker compose --env-file /opt/corestack/apps/rivnu/secrets/preview-dgii/deploy.env \
  -f deploy/docker/compose.preview.dgii.yml \
  -f deploy/preview/compose.synthetic.yml \
  up -d --no-deps --no-build --wait rivnu-dgii-preview-api rivnu-dgii-preview-web
```

Imagen construida con `Dockerfile.fiscal` en este directorio. El override cambia solamente las imágenes del preview y el comando web. Los scripts generales `up` sin override volverían a la imagen antigua indicada en deploy.env: mantener el override mientras se pruebe esta entrega.

Las dos migraciones Prisma y `fiscal-preparation.sql` ya se aplicaron al preview el 2026-09-22. **No volver a ejecutar el SQL de creación ni resetear/resembrar la base.** Los productos históricos quedan sin clasificación fiscal hasta revisión explícita; no se reconstruye su evidencia con valores actuales.

## Pruebas repetibles

`test-preparation.cjs` se ejecuta dentro de la imagen con red deshabilitada y valida generación/XSD y bloqueos de entorno. `test-order-flow.cjs` requiere acceso a `127.0.0.1:4101` y escribe solo datos sintéticos en el tenant de preview fijado en el script: crea un producto y una orden nuevos por ejecución, usa una sesión del cajero o abre una con importe sintético de 1, y deja los resultados disponibles para inspección. No imprime tokens ni cobra la orden.

## Recuperación

Las imágenes anteriores `corestack/rivnu-api:dgii-preview-ocr-20260909` y `corestack/rivnu-web:dgii-preview-ocr-20260909` se conservan. Quitar el override y recrear solo API/web permite volver a la versión anterior; las migraciones son aditivas. No restaurar automáticamente la base porque descartaría trabajo posterior. El respaldo privado previo está indicado en el documento de desarrollo.

El contenedor incluye el mapper de `packages/fiscal` para compatibilidad con preparaciones locales anteriores. Las nuevas solicitudes remotas usan el adaptador para congelar el contrato, y el XML se genera/almacena en VM4. No es el diseño final de emisión y no se debe reutilizar como despliegue fiscal productivo.
# Actualización 2026-09-23: recuperación automática y esquema de envío

- Preview API/web: `corestack/rivnu-api:ecf-recovery-20260923`. `compose.remote-client.yml` activa `RIVNU_PREVIEW_REMOTE_RECOVERY=true` exclusivamente con la guarda del preview y modo remoto.
- Migración `fiscal-recovery.sql` aplicada únicamente a `rivnu_dgii_preview`. Agrega contador y próxima fecha de recuperación; no cambia snapshots, facturas, pagos ni inventario.
- Trabajador ERP cada cinco segundos, sin ejecuciones solapadas, con bloqueo `FOR UPDATE SKIP LOCKED`. Recupera exclusivamente solicitudes PENDING/REMOTE_VM4 del tenant de preview; máximo diez intentos y esperas progresivas de hasta cinco minutos. Continúa la misma operación/acuse. Al agotar intentos, no inventa otra numeración: queda pendiente para revisión manual.
- VM4: `004_delivery_queue.sql` instalada bajo `preview_owner` en `corestack_preview_remote`. No se concedieron permisos de envío a `preview_runtime`, ni se activó `delivery_control`, ni se arrancó un worker DGII. No se tocó VM3.
- Respaldos previos privados: VM2 `/opt/corestack/apps/rivnu/preview-recovery-backup.CXVVgV/before-recovery.dump`; VM4 `/opt/corestack/backups/preview-delivery.E3509H/before-delivery.dump`. Índices de ambos respaldos legibles; la restauración completa ensayada anteriormente corresponde a la base sintética desechable, no a estos dumps concretos.
- `test-autonomous-recovery.sh` detiene temporalmente SOLO `corestack-preview-remote-service`, crea una orden sintética por API y verifica PENDING → DONE sin otro POST de preparación. Restaura el contenedor mediante trap incluso ante fallo del test. No ejecutar durante pruebas simultáneas de otros usuarios del preview.
- Rollback de aplicación: volver al tag anterior `ecf-remote-ui-20260922` y desactivar el recuperador. Las columnas aditivas pueden permanecer; no borrar tablas, documentos ni volúmenes para revertir la aplicación.

**Límite:** esta es recuperación del recorrido de preparación de órdenes de prueba, no el productor transaccional definitivo de facturas/outbox, cobro e-CF ni transmisión DGII. La instalación de una cola pausada tampoco constituye despliegue operativo de emisión.

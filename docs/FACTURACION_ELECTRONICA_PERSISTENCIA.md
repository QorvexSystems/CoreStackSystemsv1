# Persistencia fiscal y preparación sin firma: desplegadas en precertificación

Estado: las tres migraciones se aplicaron por el administrador a VM3 en una transacción, con hashes coincidentes. Consumidor instalado y healthy en VM4. No se crearon rangos reales, no se consumieron secuencias de RIVNU ni se conectó POS/preflight a esta API de persistencia.

Actualización 2026-09-21: **etapa desplegada y verificada para persistencia/preparación sin firma**. `corestack-fiscal-worker-fiscal-worker-1` healthy, cero reinicios, heartbeat reciente, sin puertos, UID 1000:1000, read_only=true, cap_drop=ALL/no-new-privileges. Sin errores registrados en la revisión de logs. Preflight healthy y conexión nueva del ERP TLSv1.3 comprobada después. Esto no demuestra emisión ni aceptación DGII. Integración ERP/POS es la etapa siguiente.

Verificación de instalación: `deploy/scripts/verify-fiscal-persistence-install.mjs`, ejecutado desde la imagen/credencial reales con consultas de solo lectura. Comprueba por nombre nueve tablas del esquema, propietario rivnu_fe_pre_owner, ninguna lectura/DML directa para runtime, cinco funciones SECURITY DEFINER autorizadas, ocho triggers activos y lectura privada de documento inexistente sin exposición. Se corrigió una aserción inicial del verificador que esperaba diez tablas: ahora compara los nueve nombres explícitamente; no requirió modificar la base.

## Garantías implementadas

- `registerFiscalRequest` analiza contrato/importes/reglas del perfil DOP_BASIC_V1 antes de acceder a la base. Envía parámetros, no SQL concatenado. Conserva ID bigint como texto y devuelve sendable=false.
- Se conserva el texto canónico exacto de `{scope, request}`; PostgreSQL vuelve a calcular SHA-256 sobre sus bytes UTF-8. No se calcula sobre la representación reordenada de jsonb.
- `runtime_scope` vincula un único tenant/RNC/ambiente a cada identidad de conexión. La función SECURITY DEFINER consulta `session_user`, no current_user ni una variable de sesión modificable por el cliente. La futura conexión debe usar directamente el runtime dedicado; un pool superusuario que use SET ROLE no cumple este contrato.
- El mismo bloqueo transaccional utilizado para secuencias protege la solicitud: snapshot, reserva, documento, tarea PREPARE_XML y evento REQUEST_REGISTERED se crean juntos o se revierten juntos.
- Misma operación y mismo texto/hash devuelven el mismo documento/e-NCF. Cambio de solicitud con la misma operación produce conflicto. Una misma fuente/revisión bajo otra operación también se rechaza, sin consumir número.
- Snapshot, documento y eventos tienen protección de UPDATE/DELETE/TRUNCATE mediante triggers. No protege frente a un administrador que desactive triggers: no se presenta como almacenamiento WORM ni auditoría independiente del DBA.
- Runtime no tiene DML/DDL directo ni acceso a autorizar rangos. La nueva migración no concede privilegios al rol real ni registra su ámbito automáticamente: eso requiere una migración de despliegue revisada. No se debe conceder al runtime la función de reserva aislada; solo la operación transaccional completa.

Las comprobaciones SQL de identidad/digest/duplicados son defensas adicionales, no un reemplazo del contrato, validación XSD ni reglas fiscales. Los fixtures de persistencia SQL son mínimos y sintéticos, no XML ni solicitudes aprobadas por DGII.

## Cola y expediente: límites explícitos

La tarea creada es únicamente PREPARE_XML, inicialmente PENDING. El consumidor implementado usa SKIP LOCKED, lease de 120 segundos y token nuevo por intento. Rechaza workers obsoletos, conserva la fecha/hora planificada entre reintentos y recupera trabajos tras caída. Máximo cinco intentos, espera exponencial 30–300 segundos para fallos transitorios; snapshot/XML inválidos pasan a FAILED sin reintento automático. No existe cola de envío DGII.

`document_artifact` guarda el XML **sin firma**, hash de sus bytes UTF-8, hash del XSD original, perfiles de mapeo/validación y ruta prevista. Inserción de artefacto, DONE y evento UNSIGNED_XML_STORED son atómicos; reenvío idéntico de una finalización es idempotente, XML distinto se rechaza. UPDATE/DELETE/TRUNCATE están bloqueados por trigger, sin prometer protección frente al DBA. Todavía no almacena XML firmado, respuestas de DGII, TrackId ni aceptación comercial. REQUEST_REGISTERED/UNSIGNED_XML_STORED son eventos internos, nunca estados de aceptación DGII. La FechaHoraFirma contenida en este borrador es planificada, no prueba de firma realizada. Firma, autorización/custodia, contingencia y set oficial siguen pendientes.

El SQL valida identidad/digest/límites, pero no ejecuta XSD: esa verificación se hace en el consumidor con libxml2, sin red y con esquemas versionados. El runtime es código de confianza; poseer su contraseña no debe considerarse una frontera suficiente frente a falsificación de evidencia por un atacante que controle ese mismo rol. La protección y rotación del secreto, registros operativos y control del despliegue siguen siendo necesarios.

## Pruebas

`bash packages/fiscal/test/postgres.sh`: diez tipos e-CF, idempotencia, digest, rechazo de producción/ámbito incorrecto, restricciones de acceso, evidencia inmutable, unicidad de fuente/revisión. Un fallo inyectado al insertar la tarea, después de reservar, revierte todo sin consumir e-NCF. Dieciséis registros concurrentes idénticos producen un solo documento, reserva, tarea y evento. La suite anterior de secuencias (48 solicitudes concurrentes) también pasa.

Suite Node: 98 pruebas pasan (88 previas + 4 del repositorio + 6 del consumidor); TypeScript sin errores. Validación antes de BD, parámetros/hash exacto, bigint sin pérdida, reintentos y resultados malformados; E31 real contra XSD, IDLE, snapshot alterado, errores permanentes/transitorios y respuesta de COMMIT perdida (UNCERTAIN sin marcar FAILED).

La suite SQL incluye además fencing, intento expirado/agostado, espera de reintento, lectura aislada por tenant, XML inmutable y 16 consumidores concurrentes. `bash packages/fiscal/test/worker-integration.sh` prueba el driver pg real con TLS, bootstrap y migración reales como owner en un servidor desechable, registro→consumidor→XSD→lectura del XML y restricciones de escritura/ámbito/base. Prueba adicional de restauración del dump previo en otra base desechable. Credencial/certificados ficticios; ningún caso se envía a DGII.

Se corrigió la espera de arranque del fixture PostgreSQL para comprobar TCP y no confundir el servidor temporal de initdb con el servidor listo. En la suite Node se añadió tmpfs /tmp al comando de pruebas; sin él, la raíz de solo lectura impedía crear los archivos temporales de validación XSD. No se relajaron permisos de producción.

## Driver y contenedor preparados

`pg` 8.16.3 y sus dependencias fijadas en pnpm-lock.yaml. Pool de dos conexiones, timeouts, secreto leído de archivo sin recortar sus bytes; CA explícita, rejectUnauthorized=true y comprobación del host/IP. No connectionString ni forma de desactivar TLS; verifica identidad de sesión y tabla de ámbito antes de entregar la conexión. Errores expuestos como códigos saneados, sin SQL/XML ni credenciales. Referencia: [node-postgres TLS](https://node-postgres.com/features/ssl), [pool y límites](https://node-postgres.com/apis/pool).

Imagen `corestack/fiscal-worker:dev-20260921`, ID local/remoto comprobado `sha256:fdf6a4e88019180c39b73c04d3209b770f29c8c637aea489474ebf8a759cb36e`. Servicio arrancado con Compose `up -d --wait` y comprobado healthy:

- `/opt/corestack/fe/compose/compose.worker.yml` y `worker.env`.
- `/opt/corestack/fe/config/fiscal-worker.json` (0444), sin contraseña.
- Montajes individuales de CA y contraseña ya provisionada, de solo lectura.
- Red fiscal-network, sin puertos, UID 1000, sin capacidades, raíz de solo lectura, tmpfs limitado, core dumps deshabilitados y límites de recursos/logs.
- Healthcheck basado en ciclos exitosos de BD, no en aceptación fiscal. SIGTERM deja terminar el ciclo y cierra el pool. Un corte abrupto se recupera por expiración del lease.

Se probó la imagen definitiva desde fiscal-network contra VM3 usando únicamente conexión y comprobación del ámbito: `FISCAL_WORKER_DRIVER_REAL_TLS_SCOPE_OK_NO_MIGRATIONS`. No se ejecutó claim contra las tablas aún ausentes.

La primera construcción rechazó el lockfile porque faltaba copiar el package.json raíz con sus overrides. Se corrigió la receta conservando frozen-lockfile; no se relajó la fijación de dependencias. No se cambiaron versiones del ERP deliberadamente.

## Registro de migración ejecutada en VM3 (no repetir)

```bash
sudo bash /opt/corestack/scripts/install-vm3-fiscal-persistence.sh
```

Comprueba host/base/propietario/ámbito y ausencia de esquema previo. Copia y valida SHA-256 de los tres SQL revisados desde `/opt/corestack/scripts/fiscal-persistence-20260921`. Conserva dump previo y archivos bajo `/var/lib/corestack-pki/fiscal-persistence-install-20260921`, root-only; verifica el inventario del dump. Ejecuta todo en **una transacción como rivnu_fe_pre_owner**, registra versiones/hashes y concede solo las cinco funciones de registro/worker/lectura. No concede reserva aislada, autorización de rangos ni DML directo al runtime. Cualquier error SQL revierte la migración; el staging se conserva y la repetición se rechaza para revisión.

Resultado recibido del usuario: `FISCAL_PERSISTENCE_INSTALLED_NO_RANGES`, COMMIT y hashes de las tres migraciones coincidentes. No genera datos fiscales, rangos ni secuencias; no cambia el ERP. Posteriormente se verificaron ownership/grants/funciones y se arrancó el consumidor. No simular emisión en la base real con rangos inventados.

Comprobación operativa:

```bash
docker compose --env-file /opt/corestack/fe/compose/worker.env \
  -f /opt/corestack/fe/compose/compose.worker.yml ps
```

Para pausar únicamente el consumidor, sustituir `ps` por `stop fiscal-worker`; no borrar tablas, credenciales, volúmenes ni contenedores del ERP. El trabajo en curso está protegido por lease/rollback y se recupera al reanudar. La migración es aditiva: no se ofrece un rollback destructivo de expedientes.

Pendientes después del despliegue: política automatizada de respaldo externo/retención/alertas, puesta en marcha con casos/rangos de precertificación suministrados y productor transaccional ERP/POS. La prueba de restauración de esta entrega es sobre datos sintéticos, no prueba de recuperación de futuros expedientes reales. XML firmado y envío/consulta DGII pertenecen a fases posteriores.

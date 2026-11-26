# Núcleo fiscal DGII: contrato y mapeadores iniciales

Estado: desarrollo y prevalidación interna, captura de evidencia ERP en código, sin transporte automático desde POS, sin firmas, sin envío a DGII y sin activación productiva. No es todavía un sistema certificable. Node >=22.18; el adaptador XSD requiere `xmllint` (libxml2-utils).

## Cobertura implementada

- Catálogo y formato e-NCF de los diez tipos: E31, E32, E33, E34, E41, E43, E44, E45, E46 y E47. Secuencias decimales de diez posiciones, tratadas como `bigint` internamente y cadenas en los contratos.
- Registro SQL independiente de rangos y reservas, segmentado por tenant/RNC/ambiente. Comprueba rangos solapados, vigencia, agotamiento e idempotencia; las reservas concurrentes se serializan en PostgreSQL.
- Contrato de entrada v1 estricto y mapeadores XML de los diez tipos bajo el perfil limitado `DOP_BASIC_V1`. Aritmética exacta, reconciliación de totales, snapshot/hash canónico y correspondencia con reserva.
- Adaptador puro `adaptErpSalesSnapshot` para proyecciones de borradores E31/E32. Descuento con evidencia de precio original y reconciliación exacta por tasa; rechaza inconsistencias sin modificar el origen. El ERP captura evidencia y tiene un helper de proyección probado con este adaptador; falta productor transaccional y transporte automático desde POS.
- Serialización de nodos XML ordenados: escape de texto, prohibición de firmas suministradas, límites de tamaño/profundidad y rechazo de ciclos/caracteres inválidos. Solo `Comprador` admite contenedor vacío para consumo anónimo E32; los otros vacíos se rechazan.
- Preparación de borradores con identidad, e-NCF, fecha, hash SHA-256 y ruta prevista ECF/RFCE. E32 usa RFCE cuando `MontoTotal < 250000.00`; no se genera ni transmite RFCE todavía.
- Validación XSD sin red, con archivos oficiales versionados y comprobación de integridad. Diez fixtures estructurales sintéticos válidos; E31 utiliza la normalización puntual documentada abajo.
- Quince XSD almacenados: diez e-CF, RFCE, ARECF, ACECF, ANECF y semilla. Tener un archivo no implica haber implementado su flujo.

`prepareEcfDraft` devuelve siempre `sendable: false`. Sus comprobaciones pendientes son reglas fiscales, autorización de secuencia, firma y validación DGII. La inyección de `DraftSchemaValidator` es un contrato interno de confianza, no una entrada del cliente.

Para entradas tipadas usar `analyzeFiscalRequest` antes de reservar y `prepareMappedEcfDraft` después de obtener la reserva del repositorio futuro. Ver [contrato v1, cobertura y límites](../../docs/FACTURACION_ELECTRONICA_CONTRATO_V1.md) y [ejemplo sintético](examples/e31-dop.json). La correspondencia del objeto de reserva no sustituye su comprobación en base de datos ni autoriza el envío.

## E31: compatibilidad del nombre de tipo resuelta localmente

El archivo oficial descargado el 2026-09-20 referencia `IndicadorServicioTodoIncluidoType` en la línea 18 y **sí contiene su definición** en la línea 476, pero como `name=" IndicadorServicioTodoIncluidoType"`, con un espacio inicial. Nuestro `xmllint/libxml2` no resuelve esa referencia al compilar el archivo. La explicación anterior de una definición ausente era imprecisa.

El ajuste `E31-TYPE-NAME-SPACE-001` en [schema-compatibility.ts](src/schema-compatibility.ts) elimina **solo ese espacio** en la copia usada por el validador. No cambia el XML de la factura, el tipo base `xs:integer`, su enumeración `1`, la obligatoriedad ni las demás reglas. El XSD versionado y su [manifest](schemas/manifest.json) permanecen intactos.

La normalización está limitada al tipo E31 y al SHA-256 revisado `7c930fe6bd53c4c885cc5b3a8fef2afeca8bc1200c5598b9b0653eee10dcd17a`. También exige exactamente una declaración afectada y ausencia de la declaración corregida. Si se actualiza el archivo, **incluso actualizando el manifest**, se bloqueará la adaptación hasta revisar la nueva versión y actualizar o retirar expresamente el ajuste. Los otros nueve esquemas no reciben esta normalización.

Las pruebas E31 ahora validan un borrador sin el indicador y otro con valor `1`; rechazan `0`, `2`, texto, totales ausentes e importes mal formados. También comprueban que el archivo original no cambie tras validar y que otra versión del esquema no reciba automáticamente el ajuste. Esto desbloquea la validación local, no implica aceptación o autorización DGII.

Para reproducir el problema original, desde la raíz del repositorio después de construir la imagen de pruebas:

```bash
docker run --rm --network none --read-only \
  -v "$PWD/packages/fiscal:/workspace/packages/fiscal:ro" \
  --entrypoint xmllint corestack/fiscal-test:local \
  --nonet --noout --schema schemas/ecf-31.xsd schemas/semilla.xsd
```

Este comando usa deliberadamente el XSD **sin** el adaptador y sigue fallando al compilarlo. La evidencia es la referencia que `libxml2` no puede resolver, no el resultado del XML semilla. La suite de pruebas de abajo usa el adaptador y debe aprobar los diez tipos.

## Validación de borradores y firma

Los XSD oficiales contienen un `xs:any` obligatorio al final para la firma. Para validar un borrador **sin firma**, el adaptador crea una copia temporal que aplica primero la normalización E31 cuando corresponde y después elimina exclusivamente ese comodín. Comprueba que exista exactamente uno y que no haya importaciones externas. Los originales no cambian y no se agrega una firma ficticia.

Esta técnica comprueba la estructura del borrador; no comprueba XMLDSig. En una etapa posterior el documento firmado deberá validarse nuevamente conservando el requisito de firma del XSD y verificarse criptográficamente. El validador de documentos firmados deberá revisar también si sigue necesitando la normalización puntual E31. No se deben reutilizar este adaptador de borradores ni su resultado como autorización de envío.

## Pruebas reproducibles

Desde la raíz del repositorio:

```bash
docker build -f packages/fiscal/Dockerfile.test -t corestack/fiscal-test:local packages/fiscal
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cpus=1 --memory=384m \
  -v "$PWD/packages/fiscal:/workspace/packages/fiscal:ro" corestack/fiscal-test:local
bash packages/fiscal/test/postgres.sh
```

El primer comando necesita acceso a los repositorios de imágenes y paquetes; las pruebas XML se ejecutan sin red. El script PostgreSQL crea y destruye exclusivamente su propio contenedor, sin puertos publicados, con datos en tmpfs y sin credenciales reales. Prueba los diez tipos, límites, reintentos, aislamiento, expiración, reversión de transacciones, 48 solicitudes concurrentes y permisos de un rol de ejecución restringido. No usa la base del ERP.

Con las dependencias del workspace instaladas y `xmllint` disponible:

```bash
pnpm --filter @corestack/fiscal lint
pnpm --filter @corestack/fiscal test
pnpm --filter @corestack/fiscal test:postgres
```

Los fixtures son sintéticos. No son el set asignado a RIVNU y no se deben presentar como comprobantes fiscales. La suite usa dobles del validador únicamente en pruebas unitarias; las pruebas de esquemas ejecutan libxml2 real.

## Contrato de persistencia

`sql/001_sequence_registry.sql` no forma parte de las migraciones Prisma. No ejecutarlo en producción. La migración es inicial, no repetible, y falla si el esquema ya existe.

`register_range` es administrativo: solo debe registrar rangos autorizados y evidencia del ambiente correspondiente. `reserve_encf` recibe tenant, RNC, ambiente, tipo, identificador estable de operación, hash del contenido original y fecha de negocio. El hash debe calcularse sobre un snapshot canónico e inmutable **antes de asignar el e-NCF**, no sobre el XML final que contiene ese número.

Un reintento con la misma operación/datos devuelve la reserva anterior, incluso si el rango después se agota. Cambiar tipo/hash/fecha produce conflicto. Un número reservado y confirmado no se borra ni se reutiliza si falla un envío: el flujo futuro deberá conservar el snapshot y reintentar el mismo documento. La fecha de negocio no es un mecanismo para autorizar retroactivamente emisiones; el servicio deberá controlarla según reglas DGII y su reloj de emisión.

El rol de ejecución recibirá únicamente `USAGE` del esquema y `EXECUTE` de `reserve_encf`; no será propietario y no tendrá DML ni acceso a `register_range`. Las funciones segmentan datos pero **no autentican** al llamante. El servicio futuro debe obtener tenant/RNC de la identidad autenticada, verificar titularidad única del RNC en el ambiente y no aceptar ese alcance libremente desde el cuerpo HTTP. No se ha implementado RLS ni autorización de transporte.

El esquema rechaza `production`. La preparación y planificación nuevas también la rechazan. Los bloqueos actuales E31/E32 del ERP no fueron retirados.

## Siguiente integración

Ver [plan y estado de implementación](../../docs/FACTURACION_ELECTRONICA_DESARROLLO.md). Antes de abrir endpoints DGII faltan productor transaccional autorizado, política de cálculo compatible para nuevos borradores, adaptadores de otros orígenes, reglas avanzadas, persistencia de XML, firma aprobada, XML auxiliares, transporte/estados, representación impresa y pruebas oficiales.

## Servicio interno de prevalidación / VM4

`Dockerfile` construye una imagen independiente, sin dependencias npm de runtime. `src/server.ts` carga configuración de `/run/fiscal/config.json` y token de `/run/secrets/fiscal_preflight_token`, sin valores secretos por defecto. Configuración: únicamente `tenantId`, `issuerRnc`, `environment` (precertification/certification). Token aleatorio base64url de al menos 32 bytes (43 caracteres), provisionado fuera del repositorio; una credencial/instancia por alcance. Producción se rechaza al iniciar.

- `GET /health/live`: liveness únicamente, no readiness fiscal ni conectividad con DGII/BD.
- `POST /internal/v1/analyze`: cuerpo = contrato v1; valida el perfil básico de los diez tipos.
- `POST /internal/v1/sales-drafts/analyze`: cuerpo = proyección ERP E31/E32.

Ambos POST requieren `Authorization: Bearer …`, JSON sin compresión y máximo 512 KiB. Alcance obtenido exclusivamente de configuración, no del cuerpo. Respuesta con hash/totales y flags `sendable:false`, `persisted:false`, `schemaValidated:false`. No hay reserva, firma, outbox, XML, persistencia ni envío DGII en estos endpoints. Los generadores y validación XSD existen como biblioteca offline, no expuestos en esta API inicial.

Build desde la raíz: `docker build -t corestack/fiscal-preflight:dev-20260920 -f packages/fiscal/Dockerfile packages/fiscal`. Compose: `deploy/docker/compose.fiscal-preflight.yml`. **Instalado en VM4 para RIVNU/precertificación, solo loopback**, con salud, autenticación y rechazo de otro emisor verificados. No hay transporte automático ERP→motor ni conexión PostgreSQL. Antes de habilitar acceso entre hosts se exige revisar firewall y transporte protegido. Ver [estado operativo VM4](../../docs/FACTURACION_ELECTRONICA_VM4.md).

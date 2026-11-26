# Transporte privado ERP → motor fiscal

Estado: receptor HTTPS desplegado en VM4, exclusivamente loopback; productor/despachador ERP implementados por componentes pero no desplegados ni conectados a Caja. No es un endpoint DGII ni habilita emisión productiva.

## Despliegue del receptor en VM4

Imagen `corestack/fiscal-registration:dev-20260922`, ID comprobado en VM2 y VM4: `sha256:6e894c10c997368a0674285dcafba9ba8433ab68eb1f5f76fe07a64323788a96`. Usa el Dockerfile compartido del motor, con comando y healthcheck de registro sobrescritos explícitamente por Compose; no reemplaza la imagen del worker.

Compose `/opt/corestack/fe/compose/compose.registration.yml`, variables no secretas `registration.env` y configuración `/opt/corestack/fe/config/fiscal-registration.json`. Contenedor `corestack-fiscal-registration-fiscal-registration-1` saludable. Publicación `127.0.0.1:4081 → 8443`, red `fiscal-network`, UID/GID 1000, raíz read-only, capacidades eliminadas, no-new-privileges, límites de recursos y logs. También es alcanzable por contenedores de esa red; exige token. No hay listener publicado en la IP LAN ni rutas VM1 nuevas.

Token dedicado creado por el usuario; se montan únicamente sus archivos individuales, la clave TLS local de VM4, certificado público, CA y credencial PostgreSQL. Verificados permisos 0400/UID 1000, correspondencia clave/certificado y conexión PostgreSQL con TLS estricto/ámbito provisionado mediante contenedor efímero. El proceso usa por ahora el rol fiscal existente con sus cinco funciones; separar un rol exclusivo de registro sigue siendo una mejora de aislamiento antes de ampliar acceso.

Pruebas reales sin registrar comprobantes: salud HTTPS, credencial incorrecta 401, contrato vacío autenticado 422 y nombre TLS incorrecto rechazado. No se enviaron contratos válidos ni se cargaron rangos. Las 110 pruebas Node, TypeScript y la integración SQL/HTTPS sintética siguen aprobadas. La salud del receptor es liveness, no una comprobación continua de disponibilidad PostgreSQL.

Para detener solo este receptor: `docker compose --env-file /opt/corestack/fe/compose/registration.env -f /opt/corestack/fe/compose/compose.registration.yml stop fiscal-registration`. No eliminar tablas ni credenciales para revertir su arranque. La conexión desde VM2 requiere un despliegue privado posterior, revisión de firewall, credencial segura del cliente y la integración autorizada de Caja.

## Recorrido preparado

1. Dentro de la transacción autorizada del ERP, congelar el contrato fiscal y registrar la fila de `corestack_erp_fiscal.dispatch`. `enqueueFiscalDispatch` comprueba emisor, tenant, tipo, revisión y estado del borrador, y bloquea las filas de factura/emisor durante esa transacción. La autorización del actor y la vigencia de identidad deben ser comprobadas por el futuro servicio ERP llamante; el helper no las sustituye.
2. El despachador reclama una fila con `SKIP LOCKED`, un token nuevo y una vigencia de 120 segundos. Solo usa el snapshot guardado; no recalcula desde productos o facturas cambiadas.
3. El cliente hace un único POST HTTPS a `/internal/v1/requests`, con token provisionado por empresa/ambiente, CA explícita y comprobación de identidad del servidor. No sigue redirecciones ni permite desactivar TLS. Límite de solicitud 512 KiB, respuesta 8 KiB y plazo total de 25 segundos por defecto.
4. El receptor valida el contrato antes de llamar al registro atómico fiscal. El acuse incluye documento, e-NCF y hash del contenido/ámbito. El cliente verifica ese hash y el tipo antes de confirmar el trabajo.
5. Una respuesta perdida no implica rollback: se reenvía la misma operación y snapshot. La cola aplica espera de 30–300 segundos y hasta diez intentos. Rechazos explícitos, contenido corrupto o agotamiento quedan en `REVIEW_REQUIRED`; no se inventan operaciones ni números nuevos. Ese estado requiere un procedimiento de conciliación/revisión posterior, todavía no implementado.

`REGISTERED` significa que el motor registró la solicitud y reservó el e-NCF. **No significa XML firmado, aceptado por DGII, venta emitida ni comprobante imprimible.** La preparación XSD ocurre después.

## Archivos y límites

- `packages/fiscal/src/registration-main.ts`: arranque HTTPS separado, valida conexión fiscal antes de escuchar en 8443. Usado en el nuevo contenedor de registro. Requiere certificado TLS del servidor, no certificado tributario de RIVNU.
- `registration-client.ts`: transporte estricto y acuses ligados al hash.
- `dispatch-worker.ts` y `dispatch-repository.ts`: procesador y acceso SQL a la cola del **ERP**, no a la base fiscal de VM4.
- Migración ERP `20260921180000_add_fiscal_dispatch_outbox`: esquema SQL independiente, snapshots protegidos contra cambios/borrado y estados terminales protegidos. No se ha aplicado a bases reales. No concede permisos a PUBLIC ni inventa un rol runtime; los grants mínimos y el procedimiento de respaldo deben revisarse al desplegar.

El esquema es administrado por SQL; no tiene modelos Prisma. Antes de desplegarlo se debe validar la cadena completa de migraciones y su compatibilidad con los procedimientos de introspección/reset del ERP. El runtime de Caja no debe recibir autoridad para cambiar snapshots ni el rol propietario por comodidad. Los triggers no protegen frente a un administrador que pueda desactivarlos.

Faltan la conexión del servicio autorizado de Caja con el productor, la validación de identidad vigente, la política de edición/cancelación de borradores congelados, el puente entre el API CommonJS y el núcleo ESM, el arranque/configuración del despachador, roles de ejecución, conciliación visible en UI y despliegue privado. El cliente fiscal recibe contratos v1, no proyecciones ERP sin adaptar. No se ha eliminado el bloqueo electrónico existente de Caja.

## Verificación reproducible

Última ejecución: 110 pruebas Node aprobadas, TypeScript sin errores. Integración SQL/HTTPS aprobada, incluyendo rollback de inserción, operación conflictiva, exclusión por bloqueo entre dos conexiones, recuperación y token de lease, diez intentos y revisión obligatoria, rechazo de CA/nombre incorrectos, redirecciones, hash incorrecto, respuesta demasiado grande y timeout. Se corrigió en la prueba auxiliar de PostgreSQL la identidad TLS predeterminada `localhost`: ahora comprueba explícitamente la IP configurada, sin desactivar verificación.

`bash packages/fiscal/test/worker-integration.sh` crea PostgreSQL, CA y certificados sintéticos desechables. Dentro de esa fixture se colocan tablas mínimas del ERP para probar la nueva migración: no son una copia completa del ERP ni la cadena íntegra de migraciones. El test comprueba rollback, idempotencia, snapshots inmutables, aislamiento, leases, reintentos y registro HTTPS→SQL→XSD. Las claves TLS efímeras existen únicamente para el test y se eliminan con su fixture; no se copian claves reales de VM3.

## Próxima intervención administrativa: TLS de VM4

Avance confirmado: usuario ejecutó la preparación en VM4; CSR válido con subject `CN=CoreStack Fiscal Registration RIVNU`. Se transfirió únicamente el CSR público a `/home/luismel/rivnu-fe-registration.csr.pem` en VM3, comprobando firma de la solicitud y SHA-256 idéntico en origen/destino: `7628b4e621010349f63bcc9882c5dac0b2337bbf2cbb563c08e30b9a4f9b095a`. No se accedió a la clave privada.

El usuario emitió el certificado con la CA interna. Verificados cadena, propósito serverAuth, IP `10.0.0.1` y correspondencia de la clave pública con el CSR. Vigencia: 2026-09-22 02:59:36 UTC a 2027-09-22 02:59:36 UTC; SHA-256 `71:C3:36:5F:CC:10:E5:97:DA:75:4B:82:A6:04:2E:AE:5B:D5:D8:37:0C:87:20:5C:BD:F7:19:13:46:6E:BB:87`. Copiado únicamente el certificado público a `/opt/corestack/fe/config/rivnu-fe-registration-2026.crt` en VM4, modo 0444, con verificación de cadena/IP y huella en destino. No se activó el receptor ni se abrieron puertos; worker y preflight permanecen healthy.

Intervención completada: usuario ejecutó `sudo bash /opt/corestack/scripts/prepare-vm4-registration-token.sh` en VM4. Script separado probado en contenedor: genera 256 bits de entropía, publica sin sobrescribir, UID/GID 1000 y modo 0400 bajo directorio root 0700. No mostró el secreto ni rotó el preflight. Configuración, validación y arranque local del receptor completados según la sección de despliegue; acceso ERP pendiente.

Se prepararon `deploy/admin/prepare-vm4-registration-tls.sh` y `deploy/admin/issue-vm4-registration-certificate.sh`, probados con una CA cifrada sintética en contenedor. Rechazan sobrescrituras. El primero genera la clave privada únicamente en VM4 y exporta una solicitud pública CSR. El segundo firma esa solicitud en VM3 con la CA interna fijada por huella, requiere su contraseña interactiva y emite un certificado serverAuth para `10.0.0.1`. Ninguno cambia PostgreSQL, abre puertos ni arranca contenedores.

1. Usuario ejecuta con sudo en VM4: `bash /opt/corestack/scripts/prepare-vm4-registration-tls.sh`.
2. Transferir **solo** `/opt/corestack/fe/config/rivnu-fe-registration.csr.pem` desde VM4 a VM3 y comprobar su hash. No transferir la clave privada.
3. Usuario ejecuta con sudo en VM3 el script de emisión, pasando la ruta del CSR, e introduce la contraseña de la CA localmente.
4. Transferir el certificado público emitido a VM4, verificar cadena/IP y correspondencia con su clave, provisionar el token de servicio por un canal seguro y revisar configuración/grants/firewall antes del despliegue. Esta instalación/activación posterior todavía no está ejecutada.

La pausa administrativa no equivale a finalizar el plan global: siguen pendientes integración autorizada con POS, firma tributaria, DGII, intercambio, representación impresa, contingencia y casos oficiales.

## Certificado tributario de RIVNU

El usuario aclaró que todavía está pendiente de entrega. No se recibió, inspeccionó ni instaló una clave privada. Se deben confirmar proveedor, modalidad, titular, vigencia, cadena, uso y autorización/custodia antes de integrar el firmante real.

El [instructivo oficial de firmado DGII](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Instructivos%20sobre%20Facturaci%C3%B3n%20Electr%C3%B3nica/Firmado%20de%20e-CF.pdf) describe XMLDSig con referencia al documento completo y SHA-256. Es un flujo distinto del TLS de infraestructura: nuestra CA interna no sustituye ese certificado. Los ejemplos del instructivo son demostrativos; no se copian implementaciones criptográficas artesanales ni se considera suficiente que exista una etiqueta Signature.

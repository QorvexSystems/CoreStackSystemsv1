# VM4: prevalidación instalada y verificaciones pendientes

## Certificado de firma de RIVNU — 2026-10-05

Certificado DigiFirma PKCS#12 validado y provisionado en almacenamiento `root-only`, sin montajes de contenedor ni activación. La cadena pública verificada está en `/opt/corestack/fe/config/trust/digifirma`; las huellas SHA-1 comprobadas son raíz `D6:EA:33:97:54:CF:4B:6F:41:52:6A:8E:2A:65:A2:73:57:5F:E8:FA` y subordinada `8D:42:A1:09:89:51:A5:08:D5:EA:1D:AA:2A:16:95:8D:34:89:89:CC`.

Los secretos no deben copiarse al repositorio, `.env`, logs, servicios generales ni respaldos sin cifrar. La activación futura deberá montar únicamente los archivos requeridos en un firmante dedicado y conservar producción bloqueada hasta autorización explícita. El aprovisionamiento no reinició ni modificó los contenedores existentes.

El 2026-10-06 se instaló y ejecutó la imagen de un solo uso `corestack/fiscal-pkcs12-self-test:20261006` (ID `sha256:68d94a0dfc1b449f88061b071b48e04e687bd532b93fed7fcafb066f876d3776`) mediante `/home/luismel/test-rivnu-signing-certificate.sh`. La prueba, sin red y con trabajo efímero en `tmpfs`, verificó huella, creación/verificación XMLDSig, rechazo de alteración y limpieza. No persistió XML, no accedió a PostgreSQL y no activó colas ni DGII.

Antes de desplegar el firmante se comprobó que los tres servicios fiscales instalados aún fijan el tenant histórico `cmqn0r66a0002lit0vxbzq5l4`; el ERP/preview vigente fija `cmt397emm0002nm0ogb50l2q6`. El despliegue queda bloqueado hasta la auditoría read-only y migración controlada de VM3/VM4.

Actualización de persistencia 2026-09-21: imagen `corestack/fiscal-worker:dev-20260921`, Compose `compose.worker.yml`, `worker.env` y `fiscal-worker.json` instalados en VM4. Tras la migración administrativa en VM3, servicio `corestack-fiscal-worker-fiscal-worker-1` arrancado y healthy, cero reinicios y heartbeat actualizado. TLS/ámbito/ownership/grants/triggers comprobados desde el runtime real. Sin puertos, UID 1000, raíz de solo lectura y capacidades eliminadas. No se modificó el preflight ni se crearon rangos/documentos fiscales. Ver [procedimiento de persistencia](FACTURACION_ELECTRONICA_PERSISTENCIA.md).

Fecha: 2026-09-20. **Servicio interno de prevalidación instalado; no auditoría integral ni habilitación de emisión.** SSH a `luismel@10.0.0.1` confirma `CoreStackSystems-VM4-Billing`. El usuario confirmó los datos de RIVNU y precertificación y generó personalmente la credencial mediante sudo. Se instaló `corestack-fiscal-preflight-fiscal-preflight-1`, verificado running/healthy. No se modificaron firewall, PostgreSQL ni Nginx. Las operaciones administrativas del host siguen a cargo del usuario.

Daemon Docker 29.8.1 con AppArmor/seccomp/cgroupns; logging del servicio local con rotación. Red fiscal bridge 172.20.40.0/24, Internal=false. Imagen verificada por ID `sha256:32d8ebe56394ae1484195866411f50b31a10921968e983854f94ba93a5b3e28e`. Smoke test previo y TCP VM4-contenedor→VM3:5432 aprobados. La configuración real está solo en VM4, fuera del repositorio; la consulta previa al ERP fue READ ONLY y el ERP mantiene LOCAL_NCF. La credencial no se imprimió ni se copió al repositorio.

## Despliegue y comprobaciones actuales

- Compose: `/opt/corestack/fe/compose/compose.preflight.yml`; archivo de imagen (sin secretos): `/opt/corestack/fe/compose/preflight.env`.
- Configuración confirmada: `/opt/corestack/fe/config/preflight.json`, montada de solo lectura, ambiente `precertification`.
- Credencial montada individualmente desde `/opt/corestack/secrets/fiscal-preflight.token`. Se verificaron UID 1000 y modo 0400 desde el contenedor, sin mostrar su contenido.
- Contenedor: `corestack-fiscal-preflight-fiscal-preflight-1`; usuario 1000:1000, read_only=true, cap_drop=ALL, reinicio unless-stopped y logging local.
- Publicación verificada únicamente `127.0.0.1:4080:8080`. Acceso comprobado desde el host y dentro del contenedor; no se abrió acceso desde otras VMs ni una URL pública.
- Pruebas sobre el servicio instalado: salud 200, solicitud sin credencial 401, análisis sintético E32 autenticado 200 (total 100.00), RNC distinto 422/ISSUER_SCOPE_MISMATCH. Flags sendable=false, persisted=false, schemaValidated=false. Ninguna factura emitida, numeración consumida, firma ni escritura a BD.

Consulta de estado en VM4:

```bash
docker compose --env-file /opt/corestack/fe/compose/preflight.env \
  -f /opt/corestack/fe/compose/compose.preflight.yml ps
curl --fail http://127.0.0.1:4080/health/live
```

Para detener exclusivamente este servicio si fuera necesario: el mismo comando Compose con `stop fiscal-preflight` en lugar de `ps`. No borrar configuración ni credencial. TLS PostgreSQL ya verificado desde contenedor aislado en fiscal-network; CA pública disponible en `/opt/corestack/fe/config/internal-root-2026.crt` (0444). Pruebas negativas de identidad/CA aprobadas. El siguiente paso es base/roles/HBA fiscales e integrar el driver con confianza explícita; preflight sigue sin BD y su Compose no cambió. Reinicio pendiente y auditoría privilegiada de firewall siguen sin resolver; no se hizo escaneo CVE. Salud local no equivale a certificación DGII.

## Lo informado y lo verificado

| Elemento                                                                              | Evidencia / estado                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Directorios fiscales y backups/scripts | Verificados: root:corestack-admins, modo 2770; secrets root:root 0700 |
| `fiscal-network`, bridge local, `172.20.40.0/24`, gateway `.1`, Internal=false | Verificada; servicio preflight conectado |
| VM3 PostgreSQL 5432 desde VM4 | TLSv1.3 estricto, autenticación y ámbito RIVNU verificados; permisos mínimos y denegaciones comprobadas. Consumidor conectado y healthy |
| Imagen `corestack/fiscal-preflight:dev-20260920` | Instalada en VM4 con ID verificado y servicio saludable |
| Compose | Instalado y ejecutado en VM4, solo loopback |
| Emisión/firma/persistencia fiscal                                                     | No disponibles en el servicio HTTP inicial                                          |

## Evaluación preliminar de la red

### Hallazgos de la inspección inicial (permisos Docker resueltos posteriormente)

- Ubuntu 24.04.4 LTS, kernel activo 6.8.0-124-generic, 4 CPU, 7,8 GiB RAM (7,2 GiB disponibles), disco raíz 72 GiB (69 GiB libres), sin swap. Recursos holgados para la prevalidación inicial, no una prueba de capacidad de emisión.
- NTP sincronizado, zona America/Santo_Domingo, unattended-upgrades habilitado. Existe `/var/run/reboot-required`; su lista incluye actualizaciones de kernel y libc. Pendiente coordinar reinicio y verificar después; no se reinició.
- CLI Docker 29.8.1, Compose v5.5.1; servicio Docker activo y habilitado. **La versión/configuración del daemon no se obtuvo**: socket root:docker 0660, usuario luismel UID 1003 sin grupo docker. `sudo -n docker ...` y `sudo -n ufw ...` devuelven `a password is required`.
- Rutas visibles: LAN 10.0.0.0/22, docker0 172.17.0.0/16 y bridge fiscal 172.20.40.0/24; no se observa solapamiento entre esas rutas. Ruta 172.16.10.0/24 vía 10.0.0.2. No equivale a una revisión completa de VPNs/firewall. Los listeners del host muestran SSH en IPv4/IPv6 y DNS local; reglas de forwarding/publicación Docker pendientes.
- Los permisos de los directorios son restrictivos. No ampliar secrets a lectura global: se mantiene root:root 0700; los archivos montados individualmente deberán provisionarse con lectura para el UID/GID del servicio. El UID del usuario SSH (1003) no es el UID del contenedor (1000).
- TCP a VM3 10.0.0.4:5432 funciona desde VM4. `openssl s_client -starttls postgres ... -verify_return_error -verify_ip 10.0.0.4` falla con `self-signed certificate`, sujeto CN=VM3-SQLDB. Falta una cadena de confianza explícita y comprobar la identidad/SAN del servidor. No se deshabilitó validación ni se probó contraseña, usuario, pg_hba o privilegios. Repetir desde un contenedor cuando haya acceso administrativo.

Para avanzar debe intervenir un administrador mediante ejecución supervisada o un mecanismo administrativo acordado. No se cambió sudoers, grupos ni permisos del socket. Agregar un usuario a `docker` concede privilegios equivalentes a root, no es un permiso limitado a este proyecto. [Docker: permisos del grupo docker](https://docs.docker.com/engine/install/linux-postinstall/).

La red bridge dedicada es una base razonable para los contenedores fiscales **del mismo host**. No une automáticamente VM1, VM2 y VM3 ni proporciona DNS entre esas máquinas. Los contenedores de la misma red pueden comunicarse entre sí: conectarlos todos a ella no implica aislamiento entre API, worker y firmante. [Docker: bridge networks](https://docs.docker.com/engine/network/drivers/bridge/).

`Internal:false` permite conectividad exterior según el resto de la configuración; no equivale a tener puertos públicos abiertos. Revisaremos subredes/rutas para descartar solapamientos y la salida real hacia VM3. No cambiaría la red compartida sin evaluar los servicios que la usan. Un firmante futuro merece aislamiento adicional y un modelo autorizado, no montar claves en cada contenedor.

El Compose inicial publica `127.0.0.1:4080:8080`. Se usa para comprobación local; **VM2 y VM1 todavía no podrán conectarse por la IP LAN**. Abrir el listener privado requerirá TLS/mTLS o un transporte protegido equivalente y una lista de orígenes permitidos. Es importante verificar la versión de Docker y sus reglas efectivas: hay advertencias para publicaciones en localhost en versiones anteriores a 28. [Docker: port publishing](https://docs.docker.com/engine/network/port-publishing/).

Las reglas Docker deben revisarse junto con el firewall, no basta con asumir que una regla UFW cubre todos los puertos publicados. Para backend iptables hay controles de forwarding y cadena DOCKER-USER; primero se identifica el backend real, sin desactivar las reglas administradas por Docker. [Docker: iptables](https://docs.docker.com/engine/network/firewall-iptables/).

## Contenedor preparado y alcance real

- Imagen independiente con Node, biblioteca fiscal y libxml2, sin ERP completo, certificados, contraseñas PostgreSQL ni datos de clientes.
- Usuario no root (UID/GID 1000 en la propuesta), raíz de solo lectura, capacidades eliminadas, `no-new-privileges`, límites CPU/memoria/PIDs, tmpfs y logs Docker rotados.
- Configuración fija por instancia: tenantId, RNC y ambiente. Credencial de servicio aleatoria propia de esa instancia. No compartir token entre RIVNU y otra empresa/ambiente.
- Arranque rechazado con configuración ausente, token débil o ambiente production. El archivo de ejemplo tiene marcadores deliberadamente inválidos; no es una configuración instalable.
- HTTP de prevalidación sin estado: `GET /health/live`, `POST /internal/v1/analyze`, `POST /internal/v1/sales-drafts/analyze`. No son URLs públicas DGII. Los POST autentican, concilian datos y devuelven hash/totales, no reservan ni firman ni persisten ni envían.
- No se monta `/opt/corestack/fe/data`: este servicio no guarda documentos. Tampoco se monta todo `/opt/corestack/secrets`, ni el socket Docker; solo el archivo de credencial necesario. Los logs van a stdout/rotación Docker, no al directorio `fe/logs` por ahora.

La propuesta está en `deploy/docker/compose.fiscal-preflight.yml`. No es un contenedor con todos los servicios terminados. Conviene evolucionar a servicios separados API/worker y firmante cuando sus responsabilidades estén implementadas y autorizadas.

## Checklist original y antecedentes del despliegue

Se dejó en VM4 `/opt/corestack/scripts/prepare-fiscal-preflight-token.sh`, para ejecución personal del administrador con `sudo bash /opt/corestack/scripts/prepare-fiscal-preflight-token.sh`. El script crea solo `/opt/corestack/secrets/fiscal-preflight.token`, con 256 bits aleatorios, dueño UID/GID 1000 y modo 0400, manteniendo el directorio raíz 0700. No muestra el valor, no sobrescribe una credencial existente y no modifica Docker, base de datos ni firewall. Se probó en contenedor aislado: permisos correctos y repetición rechazada sin alterar el archivo. El agente no lo ejecutó con privilegios en VM4. La publicación usa enlace atómico para evitar reemplazos concurrentes; los temporales de prueba se eliminaron al finalizar.

El usuario solicitó resolver TLS de PostgreSQL después de avanzar con preflight. El servicio permanece sin conexión a BD; este aplazamiento no autoriza omitir verificación TLS cuando se incorpore PostgreSQL. Datos y ambiente confirmados y provisionados; credencial generada por el usuario y servicio instalado según las comprobaciones actuales de arriba. El checklist siguiente conserva los puntos de revisión, no implica que todos estén cerrados.

1. SSH y hostname confirmados. Resolver ahora la ejecución administrativa aprobada para inspeccionar Docker/firewall y posteriormente instalar. No enviar contraseña o clave privada por chat. El script `deploy/scripts/fiscal-vm4-audit.sh` ya se ejecutó remotamente; los pasos sin permisos siguen pendientes, no aprobados.
2. Revisar hostname/SO, Docker/Compose, recursos, disco, sincronización de reloj, actualizaciones y recuperación. El script lista metadatos y listeners; no sustituye la auditoría privilegiada de firewall/ACLs.
3. Comprobar permisos y UID/GID. Configuración de solo lectura, secretos fuera del repositorio y legibles solo por los operadores y el UID/grupo del contenedor que los necesita. No usar permisos globales ni cambiar recursivamente `/opt/corestack`. Verificar la traducción de UID si Docker usa rootless/user namespaces.
4. Confirmar la IP/DNS de VM3 y probar 5432 **desde un contenedor**. Validar pg_hba, autenticación y TLS con validación de servidor; un puerto abierto no demuestra nada de eso. El usuario de servicio fiscal no debe ser superusuario ni heredar el acceso completo del ERP. Preflight no necesita PostgreSQL todavía.
5. Revisar la imagen por vulnerabilidades y fijar una versión/digest aprobado para instalar. Se hizo build/smoke test, no escaneo CVE. No usar una etiqueta mutable como garantía de trazabilidad.
6. Provisionar el tenantId real de RIVNU, RNC del ambiente, credencial por servicio y configuración fuera del repositorio. Tener rollback y copia de configuración antes de arrancar. El servicio rechaza producción; no cambiar ese control para lograr que arranque.
7. Arrancar y verificar localmente salud, rechazo sin credencial, pruebas sintéticas y logs sin payloads/secretos. Una respuesta de salud no significa estar listo para certificar.
8. Solo después revisar acceso privado VM2→VM4. Las rutas de intercambio público VM1→VM4 se diseñarán para los endpoints DGII cuando existan, con TLS y sus verificaciones; **no publicar `/internal/` bajo el dominio de un cliente**.

La migración ERP de evidencia es un despliegue separado y requiere revisión/aplicación explícita antes de actualizar la API. No se ejecutará por arrancar este contenedor. La persistencia fiscal, outbox y estados en VM3 son otra etapa; escuchar en 5432 no crea ese repositorio.

## Pendientes globales que no oculta este contenedor

Productor transaccional de snapshots completos, autorización/vigencia de identidad, documentos+reservas+outbox, almacenamiento privado de XML/respuestas, reglas fiscales restantes y política coherente de redondeo para nuevos borradores, firma bajo un modelo confirmado, XML auxiliares, comunicación DGII/entre emisores, PDF/QR/contingencia y set oficial RIVNU. Certificados, delegaciones y acceso al portal deben provisionarse por canales seguros. No se afirma certificación ni preparación productiva.

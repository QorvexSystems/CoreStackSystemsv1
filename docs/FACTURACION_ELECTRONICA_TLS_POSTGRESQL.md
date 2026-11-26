# TLS PostgreSQL: diagnóstico y siguiente paso

Estado actual (2026-09-21): certificado nuevo activado por el usuario y TLS estricto verificado desde un contenedor en fiscal-network de VM4. Conexión nueva del ERP comprobada con TLSv1.3. Base/roles/HBA fiscales pendientes; preflight permanece sin BD. Las secciones iniciales conservan el diagnóstico previo al cambio.

## Evidencia obtenida desde VM4

Destino: 10.0.0.4:5432, negociando PostgreSQL STARTTLS. Certificado presentado:

- Subject e issuer: CN=VM3-SQLDB (autofirmado).
- SAN: DNS:VM3-SQLDB; no incluye IP:10.0.0.4.
- Basic Constraints: CA:FALSE.
- Vigencia observada: 2026-06-09 a 2036-06-06; el fallo observado no es caducidad.
- Huella SHA-256: `72:5C:21:D0:15:C2:A3:ED:EB:6D:7D:72:24:8C:79:E0:D6:9F:79:3C:24:1E:90:6E:84:97:F2:45:49:71:58:F0`.

La huella obtenida de la red **no se toma automáticamente como confianza**. Ya se contrastó con la auditoría ejecutada por el usuario en VM3 y con una lectura directa del certificado público a través de SSH autenticado; coincide. La clave SSH dedicada fue autorizada posteriormente para luismel@10.0.0.4 y el acceso funciona. Sudo sigue requiriendo contraseña; el usuario ejecutará las acciones administrativas. La coincidencia de huellas no implica haber instalado confianza ni resolver la identidad por IP.

Auditoría aportada por el usuario: PostgreSQL 17.10, cluster 17/main online, escucha localhost/10.0.0.4, ssl=on, TLS mínimo 1.2. Usa `/etc/ssl/certs/ssl-cert-snakeoil.pem` y `/etc/ssl/private/ssl-cert-snakeoil.key`; no se reemplazarán estos archivos compartidos a ciegas. No hay regla HBA para VM4 (10.0.0.1): la regla productiva observada permite rivnu_runtime/rivnu_production desde VM2 (10.0.0.3). La apertura TCP no concede autorización a la base fiscal. No se ampliaron las reglas existentes.

No se encontraron archivos `.crt` en `/usr/local/share/ca-certificates` de VM3 mediante lectura sin sudo. Eso no demuestra que CoreStack carezca de CA: puede estar gestionada en otro servidor o fuera de línea. `ssl_ca_file` vacío tampoco lo demuestra, pues ese ajuste del servidor se usa para verificar certificados de clientes, no para expresar quién emitió su propio certificado.

Hay dos aspectos independientes: confianza en el certificado y correspondencia del nombre/IP. Confiar en un certificado no corrige una identidad IP ausente. Es posible usar un nombre DNS coincidente y resoluble, o emitir un certificado con SAN apropiados para el destino elegido. `verify-full` valida confianza e identidad, mientras `require` no ofrece por sí solo esas mismas garantías. [PostgreSQL 17: verificación del cliente](https://www.postgresql.org/docs/17/libpq-ssl.html).

## Acción inmediata del administrador en VM3

La auditoría `deploy/admin/vm3-fiscal-tls-audit.sh` ya fue ejecutada con sudo por el usuario **en VM3** y se recibió su salida. Es de solo lectura: recoge versión, SSL, rutas y permisos, metadatos del certificado público y reglas HBA sin contraseñas ni opciones. No lee la clave privada, no emite certificados ni recarga/reinicia PostgreSQL.

El script se prepara también en `/opt/corestack/scripts/vm3-fiscal-tls-audit.sh` de VM4 para transferirlo desde una sesión autorizada a VM3. No debe ejecutarse en VM4: allí no está el PostgreSQL que se audita. No es necesario habilitar sudo sin contraseña al asistente.

Con el resultado, confirmar además si CoreStack ya dispone de una CA interna y quién custodia su clave. No crear otra CA ni sustituir el certificado activo sin decidir esto y revisar los clientes existentes.

## Perfil de solicitud preparado

`deploy/tls/vm3-postgresql-request.cnf` define una CSR con CN/DNS VM3-SQLDB, SAN IP 10.0.0.4, CA:FALSE y uso serverAuth. La autoridad emisora deberá comprobar y autorizar esos datos; una CSR no obliga a la CA a conservar sus extensiones. El perfil no contiene claves ni crea certificados por sí solo. Se verificó la generación de una CSR RSA de 3072 bits y su firma en contenedor aislado, con clave sintética modo 0600 en tmpfs eliminada al finalizar. No se generó clave nueva en VM3 ni se emitió un certificado real. Referencia: [OpenSSL req](https://docs.openssl.org/3.0/man1/openssl-req/).

El usuario autorizó crear una CA interna inicial aunque posteriormente se migre a otra. Se preparó `deploy/admin/create-corestack-internal-ca.sh`, copiado a `/opt/corestack/scripts/create-corestack-internal-ca.sh` en VM3. No se necesita ni debe enviarse ninguna clave privada por chat.

## CA creada por el usuario; certificado público verificado

El usuario confirmó la ejecución real del bootstrap. Se verificó por SSH en VM3 el certificado público `/usr/local/share/corestack-pki/internal-root-2026.crt`, root:root 0444. Subject/issuer: CoreStack Infrastructure Root CA 2026; vigencia UTC 2026-09-21 02:14:59 a 2031-09-20 02:14:59. CA:TRUE/pathlen:0 y usos críticos keyCertSign/cRLSign. `openssl verify -check_ss_sig` aprobó su autofirma. Huella SHA-256 real: `AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37`.

El agente no leyó la clave privada ni recibió la contraseña. El usuario confirmó el respaldo externo en Windows y aportó el resultado satisfactorio de la recuperación el 2026-09-21: certificado idéntico al público de VM3 y clave descifrable cuya parte pública coincide. La verificación fue ejecutada por el usuario; el agente no inspeccionó el equipo Windows. No se instaló confianza en clientes ni se sustituyó el certificado activo de PostgreSQL.

Comando que el usuario ya ejecutó en VM3 (no repetir para generar otra CA):

```bash
sudo bash /opt/corestack/scripts/create-corestack-internal-ca.sh
```

El script exige terminal interactiva, sudo y hostname VM3-SQLDB. Solicita dos veces una contraseña única de al menos 20 caracteres, sin eco, que debe guardarse en un gestor de contraseñas. No la recibe por argumentos ni variables de entorno. La generación privada sin cifrar solo atraviesa una tubería entre procesos; se almacena como PKCS#8 cifrado AES-256-CBC/PBKDF2 con 600000 iteraciones. No se escribe clave sin cifrar al disco. El script desactiva trazas y core dumps del proceso; eso no sustituye la seguridad del host.

- CA raíz RSA 4096, SHA-256, vigencia inicial 1825 días, CA:TRUE/pathlen:0 y usos keyCertSign/cRLSign. Firma directa de certificados finales; no permite emitir sub-CAs en este perfil.
- Clave privada cifrada: `/var/lib/corestack-pki/internal-root-2026/private/ca.key.pem`, root:root 0400, dentro de directorios root-only 0700. Ubicación temporal para emisión inicial, **no custodia permanente recomendada en el servidor de base de datos**.
- Certificado público exportado: `/usr/local/share/corestack-pki/internal-root-2026.crt`, root:root 0444. No se instala automáticamente en ningún almacén de confianza.
- Lock contra ejecuciones concurrentes, rechazo de rutas inesperadas o permisos inseguros y negativa a sobrescribir CA/certificado público existentes. Los fallos conservan staging protegido para revisión, no eliminan material criptográfico silenciosamente.
- Sin emisión de certificado PostgreSQL, cambios de HBA, conexión del ERP, recargas ni reinicios. Una CA creada no resuelve por sí sola TLS.

Prueba previa realizada en contenedor desechable sin red, con contraseña sintética: generación, autofirma verificable, clave cifrada/permisos, extensiones de CA y segunda ejecución rechazada conservando el hash de la clave. Material de prueba eliminado al finalizar; no se debe confiar en él ni reutilizar su huella. La CA real es la creada por el usuario y verificada arriba.

### Custodia, respaldo y cambio futuro

Respaldo externo y prueba de recuperación confirmados por el usuario. Debe custodiarse la contraseña separadamente. Después de la emisión inicial, trasladar la custodia de la clave a un equipo/almacenamiento administrativo offline; VM3 solo necesita su propia clave de servidor, y VM4 solo certificados públicos de confianza. No montar la clave de CA en contenedores, ni guardarla en Git, imágenes, logs o chats. La retirada de la custodia temporal de VM3 sigue pendiente, así como la limpieza controlada de las copias de transferencia/recuperación. El usuario informó el directorio temporal `/home/luismel/ca-restore-check.qaRz76`; no fue eliminado por el agente.

Este bootstrap no es una plataforma PKI automatizada: faltan inventario de certificados emitidos, renovación/alertas, responsable de custodia y procedimiento de revocación/compromiso. Si aparece otra CA, la migración requiere distribuir primero su confianza, sustituir certificados, comprobar los consumidores y retirar la confianza anterior cuando sea seguro; no basta con reemplazar un archivo. No borrar la CA inicial mientras haya certificados o procesos que dependan de ella.

Referencia de cifrado/formato: [OpenSSL genpkey](https://docs.openssl.org/3.0/man1/openssl-genpkey/) y [OpenSSL pkcs8](https://docs.openssl.org/3.0/man1/openssl-pkcs8/).

## Implementación propuesta después del diagnóstico administrativo

1. Elegir identidad estable del servidor (DNS interno y/o IP SAN) y CA gestionada. Preferir la CA existente, si existe; su clave privada no se copia a VM4 ni se incluye en imágenes/repositorio. PostgreSQL recomienda certificados emitidos por CA para producción. [PostgreSQL 17: TLS del servidor](https://www.postgresql.org/docs/17/ssl-tcp.html).
2. Preparar certificado/clave del servidor con permisos correctos, copia de configuración previa, estrategia de renovación y rollback. Inspeccionar primero la configuración real y todos los consumidores; no reemplazar archivos compartidos del sistema a ciegas.
3. Administrador aplica cambios acotados y recarga cuando corresponda. Verificar el certificado realmente servido en nuevas conexiones: PostgreSQL puede conservar el SSL anterior si la recarga encuentra errores. [Comportamiento de recarga](https://www.postgresql.org/docs/17/ssl-tcp.html).
4. Provisionar únicamente confianza pública en el cliente fiscal, autenticada por huella/canal administrativo; montar de solo lectura. Configurar el driver real con verificación estricta de cadena e identidad, sin `rejectUnauthorized:false` ni degradar a `sslmode=require` para silenciar fallos.
5. Probar desde contenedor VM4: caso válido aceptado, CA incorrecta rechazada, nombre/IP incorrecto rechazado. La autenticación de BD y permisos son pruebas separadas; ni un handshake válido ni el puerto abierto las demuestran.
6. Separar rol/base fiscal de pruebas de ERP productivo; reglas `hostssl` y permisos mínimos. No migrar ni cambiar la conexión del ERP como efecto de resolver TLS fiscal.

La CA real ya existe y su recuperación fue confirmada por el usuario. El certificado nuevo está activo. La CA pública se copió a VM4 por SSH autenticado y se verificó su huella. Driver fiscal final, credenciales, base/roles/HBA e integración persistente siguen pendientes.

## Registro de emisión y auditoría previas a la activación

El usuario ejecutó el script y aportó `CERTIFICATE_ISSUED_NOT_ACTIVATED`. Se verificó independientemente por SSH el certificado público: cadena contra la CA aprobada, propósito sslserver e IP 10.0.0.4 válidos. Vigencia UTC: 2026-09-21 06:01:18 a 2027-09-21 06:01:18. Serial: `05C91BB052374F68FEA5390CBAD4B11E`. Huella SHA-256: `A5:31:CD:3B:F7:65:58:7B:7D:9E:6E:6A:CE:DD:16:84:CF:6F:EC:01:16:5F:4A:AA:B5:68:FF:4E:C9:4B:C4:EB`.

Se inspeccionaron exclusivamente los parámetros TLS de DATABASE_URL/DIRECT_URL dentro del contenedor real `rivnu-api`, sin imprimir URLs ni contraseñas: destino 10.0.0.4:5432, sslmode=require, sin sslaccept explícito ni sslrootcert/sslcert en la URL. Esto no equivale a verificación estricta ni inventaría otros consumidores. No se modificó el ERP.

El usuario ejecutó `/opt/corestack/scripts/vm3-fiscal-tls-activation-audit.sh` en VM3 y aportó el resultado: cero errores de configuración; ssl/cert/key proceden de postgresql.conf (líneas 107/109/112), sin override TLS observado. Nueve conexiones de rivnu_runtime/rivnu_production desde VM2 usan TLSv1.3. Solo existen postgres, rivnu_production y rivnu_rehearsal; no hay base/rol fiscal ni regla VM4. Permisos del paquete emitido correctos. La fotografía de conexiones activas no incluye necesariamente tareas programadas o clientes desconectados. El agente comprobó además una conexión nueva desde Prisma en el contenedor real rivnu-api: ssl=true/TLSv1.3, mediante consulta de solo lectura a pg_stat_ssl y sin mostrar credenciales. El certificado nuevo todavía no está activo.

`deploy/admin/issue-vm3-postgresql-certificate.sh` se ejecuta personalmente con sudo en VM3. Comprueba la huella exacta de la CA aprobada, permisos y vigencia; solicita su contraseña sin eco. Emite un certificado RSA 3072/SHA-256 por 365 días con SAN DNS:VM3-SQLDB e IP:10.0.0.4, CA:FALSE y serverAuth. Guarda CSR, certificado, clave y registro de emisión (serial, huella, vigencia). No acepta extensiones arbitrarias ni sobrescribe una emisión previa. Es una emisión inicial controlada, no un servicio PKI ni un sistema de revocación automatizado.

- Paquete protegido: `/var/lib/corestack-pki/issued/vm3-postgresql-2026` (root:root 0700).
- Clave de servidor: `server.key.pem`, root:root 0400. Esta clave de servidor se guarda sin contraseña para operación no interactiva; no es la clave de CA, que continúa cifrada. Todavía no es accesible por PostgreSQL; el paso de instalación deberá colocarla en una ruta dedicada con permisos apropiados.
- Certificado público exportado: `/usr/local/share/corestack-pki/vm3-postgresql-2026.crt`.
- Sin cambios a configuración PostgreSQL/HBA, sin recarga/reinicio, sin instalación de confianza ni acceso nuevo a BD.
- Prueba reproducible: `deploy/tls/test-vm3-certificate-issuance.sh`, solamente en contenedor desechable sin red con directorios PKI en tmpfs y CA ficticia. Aprobó emisión, correspondencia clave/certificado, SAN IP/DNS, permisos, rechazo de CA distinta, IP incorrecta y segunda emisión sin sobrescritura. Las claves ficticias fueron eliminadas al terminar el contenedor.

Después de ejecutar el script real: verificar certificado público emitido, inventariar consumidores actuales, preparar instalación y rollback, distribuir confianza pública y probar conexiones nuevas antes de dar TLS por resuelto. La recarga fallida puede conservar el certificado anterior: hay que comprobar lo servido por la red. [PostgreSQL 17](https://www.postgresql.org/docs/17/ssl-tcp.html). Extensiones explícitas y número de serie en emisión: [OpenSSL x509](https://docs.openssl.org/3.0/man1/openssl-x509/).

### Acceso fiscal mínimo: diseño, no aplicado

Preparar una base exclusiva de precertificación de RIVNU, separada de `rivnu_production` y `rivnu_rehearsal`. Separar propietario NOLOGIN, migrador administrativo y runtime sin SUPERUSER, CREATEDB, CREATEROLE, REPLICATION ni BYPASSRLS. No reutilizar credenciales del ERP ni conceder administración al contenedor.

La futura regla HBA debe limitar base/rol runtime a VM4 `10.0.0.1/32`, exigir `hostssl` y SCRAM; comprobar que ninguna regla previa la amplíe o permita conexión sin TLS. El migrador no necesita acceso remoto permanente. Revocar privilegios públicos de la base dedicada y conceder únicamente CONNECT, USAGE del esquema y operaciones expresamente necesarias; las funciones SECURITY DEFINER requieren revisión de propietario, search_path y ámbito tenant/RNC/ambiente. La función de reservas existente recibe ese ámbito como argumentos: no basta con conceder EXECUTE para garantizar aislamiento entre empresas. No se conectarán otros tenants a esa base/rol ni se expondrá esa función sin validar el ámbito confiable.

Este diseño se implementará y probará junto al repositorio transaccional; no hay roles, credenciales, reglas ni migraciones reales nuevos por esta preparación.

## Activación ejecutada y comprobaciones posteriores

El usuario ejecutó `activate` y aportó `TLS_ACTIVATED_LOCAL_VERIFIED`. Después, el agente verificó una conexión nueva real de Prisma desde rivnu-api: ssl=true/version=TLSv1.3. Se transfirió únicamente la CA pública desde VM3 a `/opt/corestack/fe/config/internal-root-2026.crt` en VM4 (0444), comprobando la huella aprobada. No se transfirieron claves privadas ni se cambió el almacén de confianza global.

Se ejecutó `deploy/scripts/verify-fiscal-postgresql-tls.mjs` en un contenedor desechable de la misma imagen del preflight, dentro de fiscal-network, usuario 1000:1000, raíz y montajes de solo lectura, sin capacidades. Resultados reales:

- CA aprobada + IP 10.0.0.4: TLSv1.3 y huella del certificado nuevo correctas.
- CA aprobada + IP incorrecta: rechazo ERR_TLS_CERT_ALTNAME_INVALID.
- CA no confiable: rechazo UNABLE_TO_VERIFY_LEAF_SIGNATURE.
- Sin autenticación de BD ni SQL: únicamente negociación PostgreSQL STARTTLS. No demuestra permisos de acceso a ninguna base.

El preflight existente continúa healthy y sin BD; no se modificó su Compose ni se montó aún la CA en ese servicio persistente. No se cambió la URL TLS del ERP (sigue sslmode=require); la comprobación del ERP demuestra continuidad, no que su driver haya quedado configurado con verificación estricta. El certificado y respaldo se conservan y sigue pendiente acceso fiscal mínimo.

Script preparado, probado y transferido con hash coincidente a VM3:

```bash
sudo bash /opt/corestack/scripts/activate-vm3-postgresql-tls.sh activate
```

Comprueba cluster/versión, estado previo, huellas exactas de CA/certificado nuevo/anterior, cadena/identidad, vigencia y correspondencia de clave. Rechaza rutas de activación existentes. Copia la configuración original bajo `/var/lib/corestack-pki/postgresql-tls-activation-2026` (root-only), instala archivos dedicados en `/etc/corestack-postgresql-tls-2026` (root:postgres 0750, clave 0640) y añade únicamente ssl_cert_file/ssl_key_file al final de postgresql.conf. No reemplaza los archivos snakeoil compartidos ni toca ssl_ca_file, HBA, usuarios o bases.

Valida configuración parseada y precedencia antes de solicitar pg_reload_conf(). Comprueba el certificado realmente servido por una conexión local STARTTLS PostgreSQL, con CA e identidad IP estrictas y huella esperada. No reinicia PostgreSQL; conexiones remotas nuevas del ERP y VM4 todavía deberán verificarse después. La señal de éxito es `TLS_ACTIVATED_LOCAL_VERIFIED`, no una declaración de finalización del punto 1.

Si falla después de sustituir la configuración, intenta restaurar la copia y recargar, verificando que vuelva a servirse el certificado anterior. También existe reversión explícita:

```bash
sudo bash /opt/corestack/scripts/activate-vm3-postgresql-tls.sh rollback
```

La reversión se niega a sobrescribir cambios posteriores ajenos: compara el hash completo de configuración y del respaldo. Si la reversión no se puede verificar, informa el fallo y exige revisión antes de reiniciar. Respaldo, archivos TLS y staging se conservan; no se debe repetir la activación ciegamente ni borrarlos para forzarla.

Pruebas con PostgreSQL 17 desechable sin red y certificados ficticios: activación real/handshake, permisos, reversión y comprobación del certificado anterior; negativa a sobrescribir ediciones posteriores, ejecución repetida rechazada; conflicto de precedencia simulado vía postgresql.auto.conf provoca rechazo y restauración automática. Ambas pruebas finalizaron satisfactoriamente. Se corrigieron permisos del certificado ficticio del fixture tras el primer fallo de arranque; ninguna prueba alteró VM3. Scripts: `deploy/tls/test-vm3-tls-activation.sh` y `deploy/tls/Dockerfile.activation-test`.

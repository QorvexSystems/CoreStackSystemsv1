# Acceso fiscal de RIVNU: precertificación

## Estado actual verificado

El usuario ejecutó la habilitación y aportó `FISCAL_RUNTIME_LOGIN_ENABLED`. Después se verificó desde un contenedor desechable en fiscal-network de VM4 la conexión real con libpq `sslmode=verify-full` y el secreto montado como archivo individual. Coinciden base, usuario, origen 10.0.0.1 y ámbito RIVNU/precertificación. No se mostró ni exportó la contraseña en argumentos/variables: se preparó pgpass temporal 0600 en tmpfs, eliminado al terminar.

Se rechazaron con SQLSTATE 42501 CREATE SCHEMA, CREATE TEMP TABLE, CREATE TABLE, UPDATE/DELETE del ámbito y SET ROLE a owner/migrator. Los intentos mutantes se rodearon de BEGIN/ROLLBACK y UPDATE/DELETE usaron WHERE false; ningún dato fiscal cambió. HBA rechazó conexiones a rivnu_production, rivnu_rehearsal y postgres, y la conexión sin TLS. Nueva conexión del ERP comprobada después: TLSv1.3.

Script reproducible: `deploy/scripts/verify-fiscal-db-access.sh`; imagen cliente postgres:17-alpine transferida a VM4 con ID comprobado, no se instaló servidor nuevo. Se corrigió una comparación del probe: inet_client_addr()::text incluye máscara; host(inet_client_addr()) devuelve la IP esperada. El primer intento ya autenticaba, no fue un fallo de credencial.

**Punto 1 completado para el acceso inicial:** TLS, base/roles/HBA, credencial y pruebas de aislamiento. No significa que la aplicación ya persista ni que esté certificada por DGII. Los párrafos siguientes conservan el procedimiento y sus estados previos.

Estado 2026-09-21: el administrador ejecutó el bootstrap en VM3 y aportó `FISCAL_DB_PREPARED_RUNTIME_LOCKED`: base creada y tres roles NOLOGIN/sin privilegios elevados. Se comprobó después una conexión nueva real del ERP con TLSv1.3. El usuario confirmó haber asignado la contraseña runtime mediante psql/\password con password_encryption=scram-sha-256, sin error. Custodia del secreto en VM4, habilitación LOGIN y autenticación real pendientes; preflight sigue sin BD.

## Alcance y relación con DGII

La guía oficial distingue pruebas previas en precertificación del proceso de certificación, que incluye datos, simulación y comunicación. El set de datos oficial sirve para generar los XML; la infraestructura por sí sola no aprueba esas pruebas. La CA interna de PostgreSQL no sustituye el certificado digital para Procedimiento Tributario requerido para el proceso. [DGII: Proceso de Certificación para ser Emisor Electrónico](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaciones%20Proceso%20de%20Certificaci%C3%B3n%20FE/Proceso%20de%20Certificacion%20para%20ser%20Emisor%20Electronico.pdf).

La separación de base/roles y el acceso mínimo son decisiones de seguridad de CoreStack, no nombres o topología exigidos por DGII. Los XSD, formatos y descripciones oficiales seguirán siendo las referencias funcionales; no se descargan automáticamente versiones nuevas sobre los esquemas versionados del repositorio. [DGII: documentación técnica e-CF](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Paginas/documentacionSobreE-CF.aspx).

Se mantiene pendiente contrastar cada caso oficial y conservar su resultado. No se registran rangos inventados ni se consumen e-NCF en este bootstrap. Los diez tipos siguen en el alcance del desarrollo; la certificación concreta se validará contra el set asignado a RIVNU. No se modifica B01/B02 ni el modo LOCAL_NCF del ERP.

## Objetos y permisos preparados

| Objeto | Propósito y límites |
| --- | --- |
| `rivnu_fiscal_pre` | Base exclusiva de RIVNU/precertificación, sin privilegios públicos CONNECT/CREATE/TEMP |
| `rivnu_fe_pre_owner` | Propietario NOLOGIN; no superusuario ni administración de roles/bases |
| `rivnu_fe_pre_migrator` | NOLOGIN/NOINHERIT; puede asumir owner para migraciones locales revisadas, sin credencial remota |
| `rivnu_fe_pre_runtime` | NOLOGIN inicialmente, sin pertenencia a owner/migrator ni permisos elevados; límite 10 conexiones |
| `fiscal_meta.issuer_scope` | Una fila con tenant/RNC/ambiente confirmados; runtime solo SELECT |

Ámbito fijado: tenant `cmqn0r66a0002lit0vxbzq5l4`, RNC `40220429126`, ambiente `precertification`. No se transforma esta base en certificación/producción actualizando esa fila; se provisionará un ámbito separado.

Runtime no obtiene DDL, TEMP, DML ni funciones fiscales. Las futuras migraciones deben crear objetos como owner, mantener las revocaciones por defecto y conceder únicamente las operaciones revisadas. El SQL de secuencias existente **no se aplica** en este paso. La persistencia transaccional y la validación del ámbito de funciones SECURITY DEFINER siguen pendientes.

HBA antepone: administración local postgres/peer, rechazo de otros usuarios locales a esta base, permiso hostssl exclusivamente para runtime/base desde VM4 `10.0.0.1/32` con SCRAM, seguido de rechazos IPv4/IPv6 que impiden usar runtime para otras bases o entrar a esta base por otro origen. Se conservan las reglas anteriores del ERP sin cambios. El NOLOGIN impide todavía autenticar, aunque la regla de red ya exista.

## Ejecución del administrador

Archivos preparados en `/opt/corestack/scripts` de VM3: `prepare-vm3-fiscal-database.sh` y `bootstrap-rivnu-fiscal-pre.sql`. El script copia SQL a directorio root-only y comprueba su hash antes de ejecutarlo, valida estado previo y rechaza objetos/rutas existentes. No requiere contraseña de la CA.

```bash
sudo bash /opt/corestack/scripts/prepare-vm3-fiscal-database.sh
```

Resultado esperado: `FISCAL_DB_PREPARED_RUNTIME_LOCKED`.

Ese resultado ya fue recibido del usuario. No repetir el bootstrap ni la asignación de contraseña: el usuario ya aportó salida de `psql`/`\password rivnu_fe_pre_runtime` sin error, con password_encryption=scram-sha-256. No se inspeccionó ni mostró el verificador almacenado. Mantener NOLOGIN hasta custodiar el secreto en VM4. No usar ALTER ROLE con contraseña literal en terminal, argumentos, documentación o chat. La contraseña no es la de la CA ni la del ERP.

### Custodia en VM4 confirmada por el usuario

El usuario ejecutó el script en VM4 y aportó `FISCAL_DB_SECRET_STORED`. No se leyó el archivo secreto ni se recibió su contraseña. Coincidencia con PostgreSQL aún pendiente de prueba de autenticación; no volver a ejecutar ni rotar la contraseña.

Script `/opt/corestack/scripts/prepare-vm4-fiscal-db-secret.sh`: solicita dos veces sin eco la contraseña **ya asignada**, no genera una nueva ni modifica PostgreSQL. Guarda bytes sin salto de línea en `/opt/corestack/secrets/rivnu-fe-pre-postgresql.password`, UID/GID 1000, modo 0400, padre root:root 0700. Es un archivo secreto protegido por permisos, no cifrado en disco por el script. No montar el directorio completo ni incluirlo en Git, imágenes, logs o URLs. Rechaza sobrescrituras y publica atómicamente. No cambia contenedores ni habilita LOGIN.

```bash
sudo bash /opt/corestack/scripts/prepare-vm4-fiscal-db-secret.sh
```

Resultado esperado: `FISCAL_DB_SECRET_STORED`. Prueba aislada sin red y secretos ficticios en tmpfs: longitud exacta sin salto, permisos y rechazo de sobrescritura conservando hash aprobados; material ficticio eliminado al terminar. El agente no conoce ni recibe la contraseña real. Después de confirmar este paso, verificar SCRAM/roles y habilitar LOGIN de forma acotada antes de la prueba real desde VM4.

### Habilitación de LOGIN preparada; ejecución real pendiente

`enable-rivnu-fiscal-runtime.sql` comprueba dentro de una transacción: ámbito exacto, runtime bloqueado/restringido con verificador SCRAM vigente, ausencia de membresías, atributos de owner/migrator, permisos iniciales, TLS configurado y primeras ocho reglas HBA idénticas a las aprobadas. Solo habilita LOGIN de runtime. No cambia la contraseña, HBA ni los permisos. No imprime contraseña ni verificador SCRAM.

```bash
sudo -u postgres psql -X -h /var/run/postgresql -p 5432 \
  -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 \
  -f /opt/corestack/scripts/enable-rivnu-fiscal-runtime.sql
```

Resultado esperado: `FISCAL_RUNTIME_LOGIN_ENABLED`. Prueba en PostgreSQL 17 desechable: rechaza contraseña ausente y repetición; acepta estado correcto con credencial ficticia. Suite de restricciones del bootstrap también aprobada. La autenticación real desde VM4 y denegaciones siguen pendientes hasta que el usuario ejecute este paso. No declara lista la persistencia fiscal ni autoriza emisiones.

Respaldo HBA: `/var/lib/corestack-pki/fiscal-db-bootstrap-2026`, root-only. Se valida sintaxis HBA antes de solicitar recarga, sin reinicio. Ante error tras sustituir HBA, intenta restaurar el original si no hubo cambios concurrentes; no elimina bases o roles creados. CREATE DATABASE no es transaccional: si falla a mitad, se conserva estado con roles NOLOGIN para revisión. No repetir a ciegas ni borrar objetos para forzar una segunda ejecución.

Después: verificar estado real y continuidad ERP, provisionar contraseña SCRAM fuera del chat, custodiarla como secreto individual en VM4, habilitar LOGIN solo para runtime y probar desde su red TLS estricto/autenticación/denegaciones. No se declara el punto 1 terminado hasta esas comprobaciones. Ninguna credencial fiscal se ha creado por este paso.

## Pruebas realizadas

Contenedor desechable, sin red, PostgreSQL 17 y certificados ficticios. Fixture `deploy/tls/test-vm3-tls-activation.sh fiscal`, con imagen `corestack/tls-activation-test:local` y `/var/lib/corestack-pki` en tmpfs. Pruebas: bootstrap completo, NOLOGIN/atributos restringidos, lectura del ámbito, denegación CREATE SCHEMA/TABLE/TEMP, DELETE/UPDATE y escalada a owner; funciones nuevas no ejecutables vía PUBLIC; HBA parseada, reglas originales preservadas y origen/base incorrectos rechazados incluso habilitando temporalmente una contraseña ficticia en el contenedor. Reejecución rechazada sin sobrescritura.

Se corrigió el fixture de escalada: SET ROLE conservaba session_user=postgres; se usa SET SESSION AUTHORIZATION para probar con identidad no privilegiada. La suite completa pasó después. La conexión válida real desde VM4 se probará cuando exista la credencial; no se infiere de estas pruebas locales.

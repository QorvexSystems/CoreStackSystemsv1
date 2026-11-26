# Registro automático de rangos e-NCF

El módulo **Secuencias fiscales** permite que un administrador de cada cliente registre los rangos
e-NCF autorizados por DGII. El rango se guarda primero en la base de la aplicación y una bandeja
durable lo registra posteriormente en el núcleo fiscal correspondiente al mismo cliente.

Este flujo registra autorizaciones únicamente. No activa emisión electrónica, no firma ni envía
e-CF, no reserva numeración y no modifica el próximo número de un rango ya registrado.

## Aislamiento por cliente

La API selecciona el destino mediante el `tenantId` autenticado. Cada entrada del archivo de rutas
fija conjuntamente:

- `tenantId` y RNC emisor;
- endpoint HTTPS del núcleo fiscal;
- token de servicio exclusivo;
- CA usada para verificar el endpoint.

El núcleo fiscal vuelve a validar `tenantId`, RNC y ambiente productivo. Su rol PostgreSQL solo puede
ejecutar `corestack_fiscal.register_authorized_range`; no tiene DML directo sobre las tablas. Para un
nuevo cliente, como ALLPA, se crea una instancia/identidad fiscal aislada y se agrega una ruta. Un
cliente nunca puede escoger el destino ni enviar rangos al núcleo de otro cliente.

El ejemplo versionado está en
`deploy/env/fiscal-range-registration.routes.example.json`. En producción se copia como:

`/opt/corestack/apps/rivnu/secrets/fiscal-range-registration/routes.json`

Los tokens y CA referidos por ese archivo se colocan en el mismo directorio con propietario `root`,
directorio `0700` y archivos `0400`. En `api.env` se configura:

```text
FISCAL_RANGE_REGISTRATION_ROUTES_FILE=/run/secrets/fiscal-range-registration/routes.json
```

El contenedor API monta ese directorio como solo lectura. Cambiar las rutas requiere reiniciar la API
para que valide y cargue nuevamente toda la configuración.

## Persistencia y reintentos

La migración de la aplicación crea `ElectronicFiscalRange` y evita rangos solapados bajo bloqueo
transaccional. Los números se almacenan como `BIGINT` y se transportan como texto, por lo que no se
pierden rangos e-NCF de diez dígitos.

- `PENDING`: pendiente o con comunicación no confirmada; se reintenta con espera incremental.
- `SYNCING`: tomado por un worker; una toma abandonada se recupera después de dos minutos.
- `SYNCED`: el núcleo fiscal devolvió una confirmación exacta e idempotente.
- `FAILED`: el núcleo rechazó los datos; requiere revisión y reintento manual.

El `registrationId` hace idempotente una repetición idéntica. Reusar ese identificador con datos
distintos falla de forma cerrada. VM3 conserva el rango fiscal autorizado y su evento inmutable; VM4
solo expone el servicio restringido y no mantiene una segunda fuente de numeración.

## Preparación del núcleo fiscal

`packages/fiscal/sql/006_production_authorized_ranges.sql` se instala únicamente en una base fiscal
productiva nueva y dedicada. Antes de habilitar una ruta deben existir:

1. base fiscal del cliente y propietarios/migradores `NOLOGIN`;
2. rol de registro `LOGIN` sin privilegios administrativos ni DML;
3. una sola fila `fiscal_meta.issuer_scope` para el tenant/RNC productivo;
4. vínculo del rol en `fiscal_meta.range_registration_identity`;
5. `USAGE` del esquema y `EXECUTE` exclusivo sobre la función revisada;
6. conexión PostgreSQL TLS limitada desde VM4 y endpoint HTTPS limitado desde VM2.

El servicio de VM4 se construye con `packages/fiscal/Dockerfile.range-registration` y se ejecuta con
`deploy/docker/compose.fiscal-range-registration.yml`. El archivo JSON de esa instancia fija una sola
identidad fiscal. Para otro cliente se usa configuración, credenciales y puerto propios.

La promoción de emisión productiva es un procedimiento separado. Tener un rango con estado
`SYNCED` no significa que el emisor, las colas o los envíos a DGII estén habilitados.

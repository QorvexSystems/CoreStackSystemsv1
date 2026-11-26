# Soluciones Automotriz C&R — despliegue CoreStack

## Direcciones y puertos

- Web pública: `https://solucionesautomotrizcyr.corestack-systems.com`.
- API pública: `https://solucionesautomotrizcyr-api.corestack-systems.com`.
- VM1 (`10.0.0.2`) → VM2 (`10.0.0.3`): web `3003`, API `4003`.
- VM2 → VM3 (`10.0.0.4`): PostgreSQL `5432`.
- Los contenedores son `solucionesautomotrizcyr-web` y `solucionesautomotrizcyr-api`, en la red `solucionesautomotrizcyr-network`.
- Base actual: `solucionesautomotrizcyr_production`, con roles `solucionesautomotrizcyr_migrator` y `solucionesautomotrizcyr_runtime`.
- Carpeta de VM2: `/opt/corestack/apps/solucionesautomotrizcyr/`.

## Estado de instalación

La base de VM3 está aprovisionada con 60 migraciones. Hay un único tenant y administrador iniciales; la base Supabase anterior contenía datos de prueba y no se migró. El respaldo posterior al cambio de nombre se restauró correctamente en una base temporal. El `crontab` de VM2 ejecuta `deploy/backup-vm2.sh` diariamente a las 02:20 AST; conserva los archivos durante 30 días.

Las imágenes Docker se construyen con `NEXT_PUBLIC_API_URL` y `NEXT_PUBLIC_APP_URL`; tras cambiar cualquiera de esos valores, reconstruir la web. La API toma `CORS_ORIGIN` de `/opt/corestack/apps/solucionesautomotrizcyr/secrets/api.env` al arrancar. Los secretos `api.env`, `migrator.env`, `deploy.env` y `bootstrap.env` permanecen fuera de Git, con permisos `600`.

El administrador inicial usa `admin@solucionesautomotrizcyr.local`. La empresa usa el slug `solucionesautomotrizcyr`. Los nombres de la base, roles, bloque HBA, carpeta, cron y contenedores ya fueron actualizados; se preservaron los datos y el identificador interno del tenant. Los respaldos y archivos históricos anteriores al cambio se conservan para recuperación y auditoría.

Fabio administra la configuración de Nginx y los certificados en VM1. HTTPS envía la web a `http://10.0.0.3:3003` y la API a `http://10.0.0.3:4003`, con certificados válidos para ambos nombres.

## Comprobación posterior a HTTPS

1. `https://solucionesautomotrizcyr.corestack-systems.com/login` responde `200`.
2. `https://solucionesautomotrizcyr-api.corestack-systems.com/health` responde `200`.
3. El inicio de sesión desde la web carga el dashboard sin error CORS.
4. La clave inicial elegida para el administrador debe cambiarse antes del uso real.

No ejecutar `pnpm db:seed`: borra registros y crea operaciones ficticias. RNC, rangos fiscales, correo y almacenamiento de imágenes requieren la configuración real del taller antes de usar esas funciones.

## Imágenes de recepción

La API guarda hasta 3 imágenes JPG/PNG/WEBP de 5 MB por recepción en
`/opt/corestack/apps/solucionesautomotrizcyr/uploads/<empresa en hexadecimal>/workshop-receptions/<YYYY-MM-DD>/<UUID>.<ext>`.
Crear el directorio antes de iniciar: `sudo install -d -o 1000 -g 1000 -m 750 /opt/corestack/apps/solucionesautomotrizcyr/uploads`.
Compose monta esa carpeta con escritura aunque el resto del contenedor sea de solo lectura.
Las URLs se sirven desde la API por `/uploads/`; son accesibles mediante su URL, igual que las evidencias anteriores de Supabase.
`backup-vm2.sh` respalda también esta carpeta en un archivo `-images.tar.gz` con retención de 30 días; los dumps PostgreSQL solo contienen las URLs.
Configurar en el proxy Nginx de la API `client_max_body_size 20m;` para permitir tres fotos de 5 MB más el multipart.
El proveedor anterior sigue disponible con `IMAGE_STORAGE_DRIVER=supabase`; las URLs ya guardadas no cambian.

## Firma de recepción

Al cerrar la recepción desde la agenda se presenta el resumen y una pizarra compatible con lápiz, dedo o ratón.
El cliente puede borrar y repetir la firma; confirmar guarda la firma PNG y la fecha del servidor cuando se firma; también se puede guardar sin firma.
La firma se guarda separada de las tres evidencias y se muestra en la OT, en el historial y en la copia imprimible. Tras guardar, se ofrece imprimir o continuar a OT. La sección Recepción de la OT permite reimprimir por `/workshop/<id>/reception/print`.
La firma es opcional. Se requiere una recepción registrada para continuar a OT, con o sin firma.
Editar una recepción sin proporcionar una firma nueva invalida la firma anterior.
Aplicar la migración `20261106220000_workshop_reception_signature` antes de arrancar la nueva API.


## Avisos automáticos de vehículo listo (WhatsApp Business)

Aplicar la migración con el archivo privado `secrets/migrator.env`; el rol de
`api.env` tiene permisos de ejecución y no debe usarse para crear tablas.

La API registra una notificación por OT cuando cambia a `READY_FOR_DELIVERY`.
El trabajador comprueba cada 30 segundos que la OT siga lista para entrega y que
su factura esté `PAID` con saldo cero. Si falta pago o teléfono válido, espera.
No crea avisos retroactivos para órdenes anteriores a esta versión.

Para activar, conectar el número del taller a WhatsApp Business Platform / Cloud API
y configurar las variables `WHATSAPP_*` de `.env.example` en el archivo privado
`/opt/corestack/apps/solucionesautomotrizcyr/secrets/api.env`. El token debe permanecer
en ese archivo privado; no incluirlo en Git ni enviarlo por el chat. El alcance por
`WHATSAPP_TENANT_SLUG` impide enviar avisos de otra empresa.

Crear y aprobar en Meta una plantilla de utilidad con cuatro parámetros de cuerpo,
en este orden: cliente, vehículo con placa, número de OT, dirección del taller.
Texto propuesto:

> Hola {{1}}, su vehículo {{2}} (orden {{3}}) ya está listo y pagado. Puede recogerlo en {{4}}. Gracias por confiar en Soluciones Automotriz CyR.

Una vez aprobada la plantilla, confirmar que su nombre e idioma coincidan con
`WHATSAPP_READY_TEMPLATE` y `WHATSAPP_TEMPLATE_LANGUAGE`, y activar
`WHATSAPP_AUTOMATIC_READY_ENABLED=true`. Reiniciar la API para cargar las variables.
No hace falta esta integración para abrir un chat manual dirigido a un teléfono.

`GET /notifications/whatsapp/status` permite consultar configuración y conteos para
la empresa autenticada sin exponer credenciales. `SENT` indica aceptación por Meta,
no lectura ni entrega confirmada. Un envío interrumpido o de resultado ambiguo queda
`UNCERTAIN` y no se reenvía automáticamente. Los rechazos 429 se reintentan hasta
cinco intentos; otros rechazos requieren revisión. Antes de reenviar un caso incierto,
comprobar su resultado en Meta para evitar duplicados.

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

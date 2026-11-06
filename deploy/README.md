# Soluciones Automotriz C&R — despliegue CoreStack

## Destino

- VM1 `10.0.0.2`: Nginx, TLS y `solucionesautomotriz.corestack-systems.com`.
- VM2 `10.0.0.3`: web `3003`, API `4003`, imágenes y secretos exclusivos.
- VM3 `10.0.0.4`: PostgreSQL `solucionesautomotriz_production`, roles separados para migración y ejecución.
- El navegador usa `https://solucionesautomotriz.corestack-systems.com/api` para la API.

## Alta inicial

El origen Supabase contenía datos de prueba. Esta instalación parte de una base nueva. No ejecutar `pnpm db:seed`: elimina registros y crea usuarios y operaciones ficticias.

1. Crear en Cloudflare un registro A `solucionesautomotriz` hacia `185.187.235.29`, con proxy como los demás clientes.
2. En VM3, ejecutar `sudo /opt/corestack/scripts/vm3-provision.sh`. El archivo de credenciales ya está en `/opt/corestack/secrets/solucionesautomotriz-db-provision.env` con modo `600`. El script rechaza una base o roles existentes.
3. En VM2, aplicar las migraciones usando la imagen del taller y `/opt/corestack/apps/solucionesautomotriz/secrets/migrator.env`.
4. En VM2, ejecutar `deploy/bootstrap-admin.cjs` una sola vez con el rol de migración y `/opt/corestack/apps/solucionesautomotriz/secrets/bootstrap.env`. Crea únicamente empresa, administrador y secuencia de notas de venta. No configura RNC ni rangos fiscales.
5. Arrancar los contenedores con `docker compose --env-file /opt/corestack/apps/solucionesautomotriz/secrets/deploy.env -f deploy/compose.production.yml up -d --no-build`.
6. Comprobar desde VM1 `http://10.0.0.3:3003/login` y `http://10.0.0.3:4003/health`. Si UFW bloquea, permitir solo VM1 hacia `3003/tcp` y `4003/tcp` en VM2.
7. En VM1, ejecutar `sudo /opt/corestack/scripts/vm1-install.sh`. Instala la configuración ya preparada, obtiene el certificado y verifica web y API por HTTPS.
8. Ejecutar `deploy/backup-vm2.sh` para el primer respaldo y programarlo a diario en el `crontab` de VM2. Conserva respaldos con suma SHA-256 por 30 días, en una carpeta privada.

Los archivos `api.env`, `migrator.env`, `deploy.env` y `bootstrap.env` viven fuera de Git, en `/opt/corestack/apps/solucionesautomotriz/secrets/`, con modo `600`.

Antes de recibir usuarios reales, sustituir la clave inicial elegida para el administrador. Configurar RNC, rangos fiscales, almacenamiento de imágenes y correo con los datos reales del taller. Comprobar que un respaldo se restaura correctamente en un entorno aislado.

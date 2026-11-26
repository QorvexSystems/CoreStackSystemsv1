# Hotel Ancla — operación en CoreStack

Estado al 25 de noviembre de 2026 (AST): ERP, API y sitio de reservas desplegados y saludables en VM2; base PostgreSQL migrada de Supabase a VM3. La publicación pública por DNS, Nginx y HTTPS en VM1 está pendiente de Fabio. No dar por finalizado el cambio de dominio hasta comprobar los tres HTTPS.

## Rutas y puertos

| Servicio | Contenedor | VM2 (solo red privada) | Dominio público previsto |
| --- | --- | --- | --- |
| ERP | `hotelancla-web` | `10.0.0.3:3004` | `hotelancla.corestack-systems.com` |
| API | `hotelancla-api` | `10.0.0.3:4004` | `hotelancla-api.corestack-systems.com` |
| Reservas | `hotelancla-website` | `10.0.0.3:3005` | `hotelancla-reservas.corestack-systems.com` |

Nginx de VM1 debe enviar cada dominio al puerto de su fila, conservar el encabezado `Host` y `X-Forwarded-*`, y obtener certificados HTTPS. El ERP está compilado para consumir la API pública HTTPS. Los tres puertos de VM2 están ligados a `10.0.0.3`, no a todas las interfaces.

## Base y datos

- Base destino: `hotelancla_production` en VM3 `10.0.0.4:5432`, con roles exclusivos `hotelancla_migrator` y `hotelancla_runtime`, acceso TLS desde VM2.
- Corte final: dump privado de Supabase `backups/hotelancla-supabase-20261126T010844Z.dump`, restaurado en VM3. Se cotejaron 5 usuarios, 12 habitaciones, 69 huéspedes, 62 reservas y 56 migraciones Prisma aplicadas. El origen seguía con esos conteos en la comprobación posterior.
- Se conservaron los usuarios y hashes de contraseña existentes; no se crearon ni reiniciaron cuentas.
- La base ya no depende de Supabase. **Las imágenes de productos/catálogo aún usan Supabase Storage** mediante las claves privadas de `secrets/api.env`; no eliminar ese proyecto ni sus buckets sin migrar los archivos.
- El origen Supabase sigue intacto como respaldo temporal. Mantener pausadas sus escrituras hasta validar el corte público; si alguien escribe allí después del dump, esos cambios no aparecerán en VM3.

## Operación en VM2

Directorio: `/opt/corestack/apps/hotelancla/repo/Hotel`. El ZIP original está en `/opt/corestack/apps/hotelancla/Hotel.zip`. Secretos: `/opt/corestack/apps/hotelancla/secrets` (privado). Backups: `/opt/corestack/apps/hotelancla/backups` (privado). No copiar `.env` ni secretos a Git.

```bash
cd /opt/corestack/apps/hotelancla/repo/Hotel
docker compose --env-file /opt/corestack/apps/hotelancla/secrets/deploy.env -f deploy/compose.production.yml ps
docker compose --env-file /opt/corestack/apps/hotelancla/secrets/deploy.env -f deploy/compose.production.yml logs --tail=100 api web website
```

Backups VM3 automáticos: cron diario a las 02:40 AST ejecuta `deploy/backup-vm2.sh`, crea dump con SHA-256 y retiene 30 días. Se verificó un backup manual. `deploy/restore-vm3.sh` **solo admite una base vacía**; no usarlo para restaurar encima de producción. La restauración de emergencia requiere procedimiento separado y ventana de mantenimiento.

Límites Docker: API 0.65 CPU/512 MiB, ERP 0.35 CPU/512 MiB, reservas 0.35 CPU/512 MiB; todos con límite de PIDs, sistema de archivos de solo lectura y reinicio automático.

## Verificación de publicación

Tras la configuración de Fabio, confirmar DNS de los tres nombres, certificados válidos, `GET /health` de la API, `/login` del ERP y `/` y `/api/availability` del sitio de reservas. Confirmar también que el login y la creación de una reserva de prueba funcionan por los dominios públicos antes de comunicar el lanzamiento. La creación de prueba escribe datos en VM3: usar una reserva identificable y cancelarla por el flujo normal si corresponde.

Si falla el corte público, retirar/ajustar las rutas de VM1 para no enviar tráfico al hotel mientras se corrige. Supabase no fue borrado; no reactivar escrituras en dos bases simultáneamente. Antes de volver a Supabase, verificar si ya hubo escrituras nuevas en VM3 y planificar su conciliación.

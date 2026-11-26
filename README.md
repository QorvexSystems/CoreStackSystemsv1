# Hotel Ancla · ERP hotelero

ERP multiempresa para la operación diaria de Hotel Ancla, desarrollado sobre la plataforma CoreStack.

## Módulos hoteleros

- Panel ejecutivo con ocupación, ingresos, cobros, llegadas y prioridades.
- Cola de reservaciones multicanal con asignación y confirmación.
- Check-in y check-out.
- Inventario y estado de habitaciones.
- Perfiles e historial de huéspedes.
- Facturación y cobros en RD$.
- Canales directos y OTA.
- Reportes de ocupación, ADR, RevPAR e ingresos.
- Configuración por tenant.

## Arquitectura

- `apps/web`: Next.js 15, React 19 y Tailwind CSS.
- `apps/api`: NestJS.
- `packages/database`: Prisma y PostgreSQL.
- `packages/types`, `packages/utils`, `packages/config`: paquetes compartidos.

El tenant operativo usa el slug `hotel-ancla`. CoreStack conserva un tenant separado para soporte de plataforma.

## Puesta en marcha

1. Copia `.env.example` a `.env` y configura las credenciales.
2. Instala dependencias con `pnpm install`.
3. Genera Prisma con `pnpm db:generate`.
4. Ejecuta migraciones con `pnpm db:migrate:deploy`.
5. Crea el tenant y administrador con `pnpm db:seed`.
6. Opcionalmente carga habitaciones y reservas demo con `pnpm db:seed:demo`.
7. Inicia el proyecto con `pnpm dev`.

## Variables de datos demo

- `SEED_HOTEL_ADMIN_EMAIL`
- `SEED_HOTEL_ADMIN_PASSWORD`
- `SEED_HOTEL_DEMO_PASSWORD`
- `SEED_CORESTACK_ADMIN_EMAIL`
- `SEED_CORESTACK_ADMIN_PASSWORD`

Las contraseñas deben tener al menos 16 caracteres y cambiarse antes de producción.

## Sitio web de reservas (`apps/website`)

Sitio público (Next.js, puerto 3001) donde los huéspedes reservan sin registro. Lee tipos de habitación, tarifas,
capacidad y disponibilidad directamente del ERP y crea la solicitud en el canal **Sitio Web** (`DIRECT_WEB`).

- El navegador solo habla con `/api/*` del sitio; el servidor del sitio firma cada llamada al ERP con HMAC
  (`/channel/hotel/catalog`, `availability`, `calendar`, `reservations`). El secreto nunca llega al navegador.
- La reserva entra como `PENDING_REVIEW` sin habitación asignada; recepción la confirma y asigna en el ERP.
- El inventario se cuenta por tipo y por noche (llegada 15:00, salida 11:00, hora de Santo Domingo). Las
  solicitudes pendientes ya bloquean cupo. La verificación y la inserción ocurren bajo un bloqueo de PostgreSQL,
  así que dos solicitudes simultáneas nunca pueden tomar la última habitación (aplica también a reservas creadas
  desde el ERP). Habitaciones en mantenimiento o fuera de servicio no se venden.
- El precio lo calcula el ERP (tarifa × noches + `HOTEL_WEB_TAX_RATE`); el cliente no puede enviarlo.
- Reintentos con la misma referencia no duplican la reserva.

Configura `CHANNEL_API_KEY_ID`, `CHANNEL_API_SECRET`, `CHANNEL_TENANT_SLUG` y `ERP_API_URL` en `.env` y ejecuta
`pnpm dev:website`. Pruebas: `pnpm --filter @qorvex/api test:hotel` (unitarias) y
`node apps/api/test/hotel-web-channel-integration.cjs` (E2E contra una base local desechable; ver cabecera).
Las fotos del sitio son de ejemplo (Unsplash) y se configuran en `apps/website/lib/content.ts`.

## Marca

La identidad de Hotel Ancla se centraliza en `apps/web/lib/brand.ts` y sus recursos están en `apps/web/public/brand`. CoreStack aparece únicamente como proveedor tecnológico.

## Verificación

```bash
pnpm --filter @qorvex/database lint
pnpm --filter @qorvex/api build
pnpm --filter @qorvex/web build
```

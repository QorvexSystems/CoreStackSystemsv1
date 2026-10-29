# CoreStack · Unique Personalizado

ERP interno de Unique Personalizado, desarrollado sobre la plataforma CoreStack. Centraliza catálogo, inventario, ventas, facturación y la cola de producción entre la tienda, Shopify y la fábrica.

## Alcance

- Catálogo e inventario administrados desde CoreStack.
- Inventario separado para tienda y fábrica.
- Órdenes unificadas de Shopify y POS.
- Kanban de producción: en espera, en fábrica, lista para entregar y entregada.
- Productos normales, personalizados y órdenes empresariales.
- Cotizaciones, anticipos, balances, crédito y devoluciones.
- NCF/e-CF preparado para integrar un proveedor autorizado.
- Notificaciones por correo.
- Operación multiusuario con permisos por rol.

## Arquitectura

- `apps/web`: Next.js 15 y React 19.
- `apps/api`: NestJS.
- `packages/database`: Prisma y PostgreSQL administrado en Supabase.
- `packages/types`, `packages/utils`, `packages/config`: paquetes compartidos.

La aplicación mantiene separación por tenant. `Unique Personalizado` es el tenant operativo y `CoreStack` conserva acceso de soporte de plataforma.

## Requisitos

- Node.js 20 o superior.
- pnpm 10.12.4.
- Acceso al proyecto Supabase de Unique Personalizado.
- Archivo `.env` basado en `.env.example`.

## Instalación local

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @qorvex/database build
pnpm dev
```

Servicios locales:

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- Salud de API: `http://localhost:4000/health`

## Base de datos

Aplicar migraciones existentes:

```bash
pnpm db:migrate:deploy
```

Crear o actualizar los tenants y accesos administrativos iniciales:

```bash
pnpm db:seed
```

El seed es idempotente. No elimina información operativa ni crea productos, clientes, facturas o secuencias fiscales ficticias. Las contraseñas se leen de las variables `SEED_*` del `.env` y nunca se imprimen.

### Datos de prueba

Para crear o actualizar el conjunto demo reducido y verificarlo:

```bash
pnpm db:seed:demo
pnpm db:verify:demo
```

El conjunto incluye tres productos con existencia separada entre tienda y fábrica, un cliente empresarial con crédito, secuencias B01/B02 y estos accesos:

- `admin@uniquepersonalizado.com`: administración.
- `contabilidad@uniquepersonalizado.com`: contabilidad.
- `ordenes@uniquepersonalizado.com`: toma de órdenes y POS.
- `fabrica@uniquepersonalizado.com`: producción y despacho.

Las tres cuentas operativas usan `SEED_UNIQUE_DEMO_PASSWORD`; si esa variable no está definida, el seed demo local usa `UniqueDemo#2026!`. El administrador conserva `SEED_UNIQUE_ADMIN_PASSWORD`. Estos accesos deben cambiarse antes de producción.

### Recorrido de prueba

1. Ingresa como toma de órdenes, abre la caja y crea una orden con `Collar Personalizado Niños`, fecha prometida y datos de personalización.
2. Cobra la orden en el POS. La factura pendiente creada junto con la orden se completa sin duplicarse.
3. Ingresa como fábrica: aprueba el diseño, mueve la tarjeta a fábrica, registra control de calidad y márcala lista.
4. Confirma que fábrica no vea precios ni pagos y que el correo de orden lista quede registrado.
5. Entrega la orden desde tienda o fábrica y verifica el historial de la tarjeta.
6. Busca la factura en Devoluciones por número, nombre, RNC o cédula y genera una solicitud.
7. Crea una cotización empresarial para `Empresa Demo SRL`, agrega sus unidades y comprueba el contador pendiente/en progreso/terminado dentro de una sola tarjeta.
8. Prueba inventario de tienda y de fábrica por separado y confirma el descuento desde el origen elegido.

La pantalla Importaciones también acepta órdenes abiertas en Excel. Cada fila representa un producto y las filas con el mismo `numero orden` se agrupan en una sola orden. El archivo [ordenes-abiertas-ejemplo.csv](examples/ordenes-abiertas-ejemplo.csv) documenta las columnas; ábrelo en Excel y guárdalo como `.xlsx` antes de cargarlo.

## Variables sensibles

`.env` está excluido de Git. Nunca deben versionarse:

- contraseñas de PostgreSQL;
- claves secretas de Supabase;
- `JWT_SECRET`;
- credenciales de Shopify, AZUL o correo;
- contraseñas administrativas del seed.

Las variables y ejemplos seguros están documentados en `.env.example`.

## Comandos de validación

```bash
pnpm lint
pnpm build
git diff --check
```

Validaciones individuales:

```bash
pnpm --filter @qorvex/database lint
pnpm --filter @qorvex/api build
pnpm --filter @qorvex/web build
```

## Identidad visual

Los recursos de Unique Personalizado se encuentran en `apps/web/public/brand`. El recurso principal fue convertido en los iconos de navegador, Apple Home Screen y PWA. CoreStack permanece visible como proveedor tecnológico.

## Flujo operativo objetivo

Orden normal:

```text
Orden creada → En espera → Lista para entregar → Entregada
```

Orden personalizada:

```text
Orden creada → Aprobación manual → En espera → En fábrica → Control de calidad → Lista para entregar → Entregada
```

Orden empresarial:

```text
Cotización → Aprobada → Orden → Producción agrupada → Entrega
```

Las órdenes empresariales mantienen una sola tarjeta y muestran unidades pendientes, en progreso y terminadas. Solamente este tipo de orden admite entregas parciales.

## Decisiones de producto

- CoreStack será la fuente principal de catálogo, precios e inventario.
- Shopify enviará órdenes y pagos al ERP y recibirá catálogo e inventario.
- Toda orden tendrá fecha prometida y reservará inventario al crearse.
- Las órdenes normales también aparecerán en el Kanban, pero omitirán fábrica.
- La fábrica no verá precios ni información financiera.
- La primera versión notificará por correo; WhatsApp queda fuera del alcance.
- La selección del proveedor e-CF se mantiene pendiente.



## Mejoras y pruebas de la demo

Ver [mejoras implementadas, comandos y pendientes](MEJORAS_DEMO.md). Los cambios de seguridad de Supabase/cuentas entre empresas están fuera de esta iteración. Correo real y proveedor e-CF permanecen pendientes.

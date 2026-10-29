# Catálogo web (ERP → e-commerce)

Administra productos agrupados para el e-commerce y los publica por una API de lectura. **Apagado por defecto**: sin `CHANNEL_*` el canal responde 404.

## Administración (usuarios del ERP con rol ADMIN / SUPER_ADMIN / QORVEX_SUPER_ADMIN, cabecera `x-tenant-id`)
| Método | Ruta | Función |
|---|---|---|
| GET | `/web-products` , `/web-products/:id` | Listar / ver (incluye `blockers` y disponibilidad comercial) |
| POST | `/web-products` | Crear grupo con variantes (precio y SKU por variante, opciones, imagen https) |
| PATCH | `/web-products/:id` | Nombre, slug, descripción, categoría, imagen principal, opciones, `addImages` |
| POST | `/web-products/:id/variants` | Agregar variante |
| PATCH | `/web-products/:id/variants/:variantId` | Precio, SKU, título, opciones, estado, `webAvailability`, `trackInventory` |
| POST | `/web-products/:id/publish` · `/unpublish` | Publicar (409 con `BLOCKER:*` si falta algo) / despublicar |

Reglas: no se publica con descripción, categoría o imagen faltantes, sin variantes activas, con SKU repetido o con alguna variante activa en `UNDECIDED`. Un grupo publicado debe seguir siendo publicable: un cambio que lo rompa se rechaza (409). Nunca toca existencias, reservas, movimientos ni `InventorySyncJob`, y no usa `ProductsService` (que sincroniza con Shopify). Precios tal cual: sin ITBIS añadido.

## API de canal (servidor a servidor)
`GET /channel/catalog?limit&cursor` y `POST /channel/availability` `{ items: [{ variantId, quantity? }] }`.
Solo grupos publicados, variantes `ACTIVE` con política `STOCKED`/`MADE_TO_ORDER`. Devuelve un **estado** (`in_stock`, `out_of_stock`, `made_to_order`), nunca cantidades, costos ni datos de clientes. El tenant lo fija la credencial, no el cliente.

Firma: cabeceras `x-channel-key-id`, `x-channel-timestamp` (s), `x-channel-nonce`, `x-channel-signature` = HMAC-SHA256 hex de `v1\n{ts}\n{nonce}\n{MÉTODO}\n{ruta+query}\n{sha256(cuerpo)}`. Ventana ±120 s (configurable) y nonce de un solo uso, registrado en la base compartida (`ChannelNonce`). `/channel/*` es la única ruta fuera del filtro `INTERNAL_ALLOWED_IPS` (el e-commerce no tiene IP fija); compensa con la firma, el límite de solicitudes y el apagado por defecto.

## Variables (solo servidor; nunca en el repositorio)
`CHANNEL_API_KEY_ID`, `CHANNEL_API_SECRET` (≥32 caracteres), `CHANNEL_TENANT_SLUG`; opcional `CHANNEL_REVALIDATE_URL` (https; http solo localhost) para avisar al e-commerce.

## Pruebas
`pnpm --filter @qorvex/api test:web-catalog` (unitarias). Recorrido completo contra API real y PostgreSQL local: `npm run erp:demo` en el e-commerce.

## Preparación masiva del catálogo importado (Fase 7)
Solo sobre los grupos que la persona selecciona (máx. 100 por llamada; publicar, máx. 25). No cambian precios ni existencias, no sobrescriben decisiones y cada llamada devuelve qué se aplicó y qué se omitió.

| Método | Ruta | Función |
|---|---|---|
| GET | `/web-products/review` | Resumen y conteo por código de bloqueo |
| GET | `/web-products?blocker=<CÓDIGO\|NONE>` | Filtrar por bloqueo (`NONE` = publicables) |
| GET | `/web-products/sku-review` | SKU propuestos pendientes: original → propuesto → regla |
| POST | `/web-products/bulk/category` | Asignar categoría (no sobrescribe sin `overwrite:true`) |
| POST | `/web-products/bulk/sku-approve` | Aprobar los SKU actuales (decisión humana) |
| POST | `/web-products/bulk/availability` | Política `STOCKED`/`MADE_TO_ORDER` solo donde está sin decidir |
| POST | `/web-products/bulk/activate` | Activar variantes con SKU aprobado + política + precio válido |
| POST | `/web-products/bulk/publish` | Publicar lo seleccionado (`confirm:true`, máx. 25) con los mismos bloqueos |
| POST | `/web-products/:id/images` | Subir imagen (JPG/PNG/WEBP ≤ 5 MB, tipo verificado por firma) a Supabase Storage |

Bloqueo nuevo: `VARIANT_SKU_PENDING_APPROVAL` (`Product.skuApprovedAt` nulo). Los SKU escritos por una persona en el ERP nacen aprobados; los candidatos del importador quedan pendientes.

## Nonces del canal
`ChannelNonce` (base compartida) impide repetir una solicitud firmada entre instancias (el API corre en Vercel serverless). Costo: 1 INSERT por lectura; filas ≈ solicitudes/min × 4; purga cada ≥ 60 s por instancia. Un fallo de la base rechaza la solicitud (503): sin ella no se puede garantizar la no repetición.

## Variables nuevas
`SUPABASE_WEB_CATALOG_BUCKET` (por defecto `web-catalog`; el bucket debe existir, el código no lo crea), `CHANNEL_RATE_LIMIT_MAX` (120/min), `CHANNEL_TIMESTAMP_TOLERANCE_SECONDS` (120), `SHOPIFY_SYNC_DISABLED` (solo `true` aísla), `WEB_CATALOG_DEV_IMAGE_HOSTS` (solo desarrollo).

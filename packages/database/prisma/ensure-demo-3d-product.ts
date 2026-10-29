// Crea o actualiza (idempotente) el producto de demostración «test» con un modelo 3D de Sketchfab.
// Escribe solo: 1 WebProduct, 1 Product (variante), 1 InventoryMovement INITIAL_STOCK. No toca otros productos.
// Uso: pnpm --filter @qorvex/database ensure:demo-3d-product
import { InventoryMovementType, PrismaClient } from '../generated/client';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

const TENANT_SLUG = 'unique-personalizado';
const GROUP_ID = 'UP-W-demo3d001';
const SKU = 'DEMO-3D-001';
const STOCK = 5;
const MODEL_ID = '11196cac4baf485a84dfd11d511b9aa0';
const SOURCE_URL = `https://sketchfab.com/models/${MODEL_ID}`;
const CATEGORY = 'Cadena';

async function thumbnail(): Promise<string> {
  // oEmbed oficial de Sketchfab: miniatura https pública, necesaria para que el grupo sea publicable.
  const res = await fetch(`https://sketchfab.com/oembed?url=${encodeURIComponent(SOURCE_URL)}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`oEmbed de Sketchfab respondió ${res.status}`);
  const url = (await res.json()).thumbnail_url;
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('oEmbed sin miniatura https');
  return url;
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: TENANT_SLUG } });
  const tenantId = tenant.id;
  const clash = await prisma.webProduct.findFirst({ where: { tenantId, slug: 'test', NOT: { legacyEcommerceId: GROUP_ID } } });
  if (clash) throw new Error(`Ya existe otro producto con slug «test» (${clash.legacyEcommerceId}); no se duplica.`);
  const skuOwner = await prisma.product.findFirst({ where: { tenantId, sku: SKU }, select: { webProduct: { select: { legacyEcommerceId: true } } } });
  if (skuOwner && skuOwner.webProduct?.legacyEcommerceId !== GROUP_ID) throw new Error(`El SKU ${SKU} ya pertenece a otro producto.`);

  const imageUrl = await thumbnail();
  const data = {
    name: 'test',
    slug: 'test',
    description: 'Producto de demostración para visualizar una joya en 3D de forma interactiva',
    categoryLabel: CATEGORY,
    imageUrl,
    options: [{ name: 'Title', values: ['Default Title'] }],
    imageManifest: [{ id: `${GROUP_ID}-I01`, position: 0, url: imageUrl, src: null, alt: 'Joya en 3D (miniatura de Sketchfab)', variantIds: [] }],
    media3d: [{ kind: 'SKETCHFAB', modelId: MODEL_ID, sourceUrl: SOURCE_URL }],
    publicationIntent: 'active',
  };

  await prisma.$transaction(async (tx) => {
    const existing = await tx.webProduct.findFirst({ where: { tenantId, legacyEcommerceId: GROUP_ID } });
    const group = existing
      ? await tx.webProduct.update({ where: { id: existing.id }, data: { ...data, published: true, publishedAt: existing.publishedAt ?? new Date() } })
      : await tx.webProduct.create({ data: { tenantId, legacyEcommerceId: GROUP_ID, ...data, published: true, publishedAt: new Date() } });

    const variantData = {
      name: 'test - Default Title',
      price: '1500.00', // valor nominal de demostración
      status: 'ACTIVE' as const,
      webAvailability: 'STOCKED' as const,
      trackInventory: true,
      webOptions: { title: 'Default Title', options: [{ name: 'Title', value: 'Default Title' }], compareAtPrice: null, primaryImageId: null },
    };
    const variant = await tx.product.findFirst({ where: { tenantId, sku: SKU } });
    if (variant) {
      await tx.product.update({ where: { id: variant.id }, data: { ...variantData, webProductId: group.id } });
    } else {
      const created = await tx.product.create({
        data: { tenantId, webProductId: group.id, sku: SKU, skuApprovedAt: new Date(), kind: 'STANDARD', stock: STOCK, reservedStock: 0, legacyEcommerceVariantId: `${GROUP_ID}-V01`, ...variantData },
      });
      await tx.inventoryMovement.create({
        data: { tenantId, productId: created.id, type: InventoryMovementType.INITIAL_STOCK, quantity: STOCK, previousStock: 0, newStock: STOCK, reason: 'Inventario inicial de demostración (producto test 3D)', reference: `PRODUCT-${SKU}`, createdById: null },
      });
    }
  });
  console.log('Producto test listo:', GROUP_ID, SKU);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

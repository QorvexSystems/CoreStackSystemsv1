import assert from 'node:assert/strict';
import test from 'node:test';
import { channelCredentialsFromEnv, NonceStore, signChannelRequest, verifyChannelRequest } from './channel-auth';
import { computeAvailability, isPublicImageUrl, parseSketchfabUrl, publishBlockers, toChannelProduct, type GroupRow, type VariantRow } from './web-catalog.rules';

const now = new Date('2026-10-28T12:00:00Z');
const group = (o: Partial<GroupRow> = {}): GroupRow => ({
  id: 'g1', legacyEcommerceId: 'UP-W-test0001', slug: 'collar-prueba', name: 'Collar de prueba', description: 'Descripción', descriptionHtml: null,
  categoryLabel: 'Collares', options: [{ name: 'Color', values: ['Dorado', 'Plateado'] }], personalizationOptions: null,
  imageUrl: 'https://img.example.test/a.jpg', imageManifest: [], published: true, publishedAt: now, updatedAt: now, ...o,
});
const variant = (o: Partial<VariantRow> = {}): VariantRow => ({
  id: 'p1', sku: 'COLLAR-DOR', name: 'Collar de prueba - Dorado', price: '950.00', status: 'ACTIVE', stock: 5, reservedStock: 2, trackInventory: true,
  webAvailability: 'STOCKED', webOptions: { title: 'Dorado', options: [{ name: 'Color', value: 'Dorado' }], compareAtPrice: null, primaryImageId: null },
  legacyEcommerceVariantId: 'UP-W-test0001-V01', skuApprovedAt: now, updatedAt: now, ...o,
});
const reason = (r: unknown) => (r as { reason: string }).reason;

test('disponibilidad: política decidida; UNDECIDED o contradictoria no produce estado', () => {
  assert.deepEqual(computeAvailability(variant()), { state: 'in_stock', purchasable: true });
  assert.deepEqual(computeAvailability(variant({ stock: 2, reservedStock: 2 })), { state: 'out_of_stock', purchasable: false });
  assert.deepEqual(computeAvailability(variant({ webAvailability: 'MADE_TO_ORDER', trackInventory: false, stock: 0 })), { state: 'made_to_order', purchasable: true });
  assert.equal(computeAvailability(variant({ webAvailability: 'UNDECIDED' })), null);
  assert.equal(computeAvailability(variant({ webAvailability: null })), null);
  assert.equal(computeAvailability(variant({ webAvailability: 'STOCKED', trackInventory: false })), null);
});

test('publicación: requisitos mínimos', () => {
  assert.deepEqual(publishBlockers(group(), [variant()]), []);
  assert.ok(publishBlockers(group(), [variant({ webAvailability: 'UNDECIDED' })]).some((b) => b.startsWith('VARIANT_AVAILABILITY_UNDECIDED')));
  assert.ok(publishBlockers(group({ imageUrl: null }), [variant()]).includes('GROUP_IMAGE_MISSING'));
  assert.ok(publishBlockers(group({ imageUrl: 'http://x.test/a.jpg' }), [variant()]).includes('GROUP_IMAGE_MISSING'), 'solo https');
  assert.ok(publishBlockers(group({ categoryLabel: null }), [variant()]).includes('GROUP_CATEGORY_MISSING'));
  assert.ok(publishBlockers(group({ description: ' ' }), [variant()]).includes('GROUP_DESCRIPTION_MISSING'));
  assert.ok(publishBlockers(group(), [variant({ status: 'INACTIVE' })]).includes('NO_ACTIVE_VARIANTS'));
  assert.ok(publishBlockers(group(), [variant({ skuApprovedAt: null })]).some((b) => b.startsWith('VARIANT_SKU_PENDING_APPROVAL')), 'un SKU candidato sin aprobar bloquea la publicación');
  assert.ok(publishBlockers(group(), [variant({ price: '0.00' })]).some((b) => b.startsWith('VARIANT_PRICE_INVALID')));
  assert.ok(publishBlockers(group(), [variant(), variant({ id: 'p2', legacyEcommerceVariantId: 'UP-W-test0001-V02' })]).some((b) => b.startsWith('VARIANT_SKU_REPEATED')));
  assert.ok(publishBlockers(group(), [variant({ webOptions: { options: [{ name: 'Color', value: 'Verde' }] } })]).some((b) => b.startsWith('VARIANT_OPTION_NOT_DECLARED')));
  const imported = group({ imageUrl: null, imageManifest: [{ id: 'I1', position: 0, src: '/catalog/products/UP-P-0001/a.webp' }] });
  assert.deepEqual(publishBlockers(imported, [variant()]), [], 'las imágenes importadas (ruta propia) cuentan');
});

test('proyección pública: solo publicado, activo y decidido; sin datos internos; precio exacto', () => {
  const hidden = [
    variant({ id: 'p2', sku: 'X2', legacyEcommerceVariantId: 'V2', webAvailability: 'UNDECIDED' }),
    variant({ id: 'p3', sku: 'X3', legacyEcommerceVariantId: 'V3', status: 'INACTIVE' }),
    variant({ id: 'p4', sku: 'X4', legacyEcommerceVariantId: 'V4', status: 'DISCONTINUED' }),
  ];
  const item = toChannelProduct(group(), [variant(), ...hidden])!;
  assert.deepEqual(item.variants.map((v) => v.id), ['UP-W-test0001-V01']);
  assert.equal(item.variants[0].price, '950.00');
  assert.equal(item.id, 'UP-W-test0001');
  assert.equal(toChannelProduct(group({ published: false }), [variant()]), null);
  assert.equal(toChannelProduct(group(), hidden), null, 'sin variantes públicas no hay producto');
  const text = JSON.stringify(item);
  for (const internal of ['"stock"', 'reservedStock', 'cost', 'margin', 'barcode', 'tenantId', 'supplier']) assert.ok(!text.includes(internal), `no debe exponer ${internal}`);
  assert.ok(!/"(?:quantity|available|units)"/i.test(text), 'sin cantidades');
});

test('HMAC del canal: firma válida, manipulación, vencimiento, repetición y clave desconocida', () => {
  const credentials = { keyId: 'key-1', secret: 'x'.repeat(40), tenantSlug: 'hotel-ancla' };
  const nowMs = 1_800_000_000_000;
  const timestamp = String(nowMs / 1000);
  const request = { method: 'POST', pathAndQuery: '/channel/availability', body: '{"items":[]}' };
  const sign = (nonce = 'nonce-nonce-nonce-1') => ({ keyId: 'key-1', timestamp, nonce, signature: signChannelRequest(credentials.secret, { ...request, timestamp, nonce }) });
  const check = (headers: ReturnType<typeof sign>, r = request, nonces = new NonceStore(), at = nowMs) => verifyChannelRequest(credentials, headers, r, { nowMs: at, nonces });
  assert.deepEqual(check(sign()), { ok: true });
  assert.equal(reason(check(sign(), { ...request, body: '{"items":[1]}' })), 'bad-signature');
  assert.equal(reason(check(sign(), { ...request, pathAndQuery: '/channel/catalog' })), 'bad-signature');
  assert.equal(reason(check(sign(), { ...request, method: 'GET' })), 'bad-signature');
  assert.equal(reason(check(sign(), request, new NonceStore(), nowMs + 301_000)), 'stale-timestamp');
  assert.equal(reason(check({ ...sign(), keyId: 'otra' })), 'unknown-key');
  assert.equal(reason(check({ ...sign(), signature: '' })), 'missing-headers');
  const nonces = new NonceStore();
  assert.deepEqual(check(sign(), request, nonces), { ok: true });
  assert.equal(reason(check(sign(), request, nonces)), 'replayed-nonce');
  const wrong = { ...sign(), signature: signChannelRequest('y'.repeat(40), { ...request, timestamp, nonce: 'nonce-nonce-nonce-1' }) };
  assert.equal(reason(check(wrong)), 'bad-signature');
});

test('configuración del canal: apagada por defecto y rechaza secretos cortos', () => {
  assert.equal(channelCredentialsFromEnv({}), null);
  assert.equal(channelCredentialsFromEnv({ CHANNEL_API_KEY_ID: 'k' }), null);
  assert.throws(() => channelCredentialsFromEnv({ CHANNEL_API_KEY_ID: 'k', CHANNEL_API_SECRET: 'corto', CHANNEL_TENANT_SLUG: 't' }), /32 caracteres/);
  assert.ok(channelCredentialsFromEnv({ CHANNEL_API_KEY_ID: 'k', CHANNEL_API_SECRET: 'x'.repeat(32), CHANNEL_TENANT_SLUG: 't' }));
});

test('imágenes: https siempre; http solo en desarrollo y para hosts autorizados explícitamente', () => {
  const dev = { NODE_ENV: 'development', WEB_CATALOG_DEV_IMAGE_HOSTS: '127.0.0.1' };
  assert.equal(isPublicImageUrl('https://cdn.example.test/a.jpg', {}), true);
  assert.equal(isPublicImageUrl('http://127.0.0.1:4030/a.webp', dev), true);
  assert.equal(isPublicImageUrl('http://127.0.0.1:4030/a.webp', {}), false, 'sin la lista de hosts no se admite http');
  assert.equal(isPublicImageUrl('http://127.0.0.1:4030/a.webp', { ...dev, NODE_ENV: 'production' }), false, 'nunca en producción');
  assert.equal(isPublicImageUrl('http://otro.test/a.webp', dev), false);
  assert.equal(isPublicImageUrl('https://user:pw@cdn.example.test/a.jpg', {}), false, 'sin credenciales en la URL');
  assert.equal(isPublicImageUrl('javascript:alert(1)', dev), false);
});

test('Shopify: por defecto el comportamiento no cambia; SHOPIFY_SYNC_DISABLED=true omite cola y sincronización', async () => {
  const { ShopifyService } = await import('../shopify/shopify.service');
  const calls: string[] = [];
  const prisma = { inventorySyncJob: { upsert: async () => { calls.push('upsert'); } } };
  const make = (values: Record<string, string>) => new ShopifyService(prisma as never, { get: (k: string) => values[k] } as never);
  const byDefault = await make({}).syncProductIfConfigured('t', 'p');
  assert.deepEqual(byDefault, { configured: false, synced: false });
  assert.deepEqual(calls, ['upsert'], 'sin la bandera sigue encolando como siempre');
  calls.length = 0;
  const disabled = await make({ SHOPIFY_SYNC_DISABLED: 'true' }).syncProductIfConfigured('t', 'p');
  assert.deepEqual(disabled, { configured: false, synced: false, disabled: true });
  assert.deepEqual(calls, [], 'con la bandera no se encola nada');
  calls.length = 0;
  await make({ SHOPIFY_SYNC_DISABLED: 'false' }).syncProductIfConfigured('t', 'p');
  await make({ SHOPIFY_SYNC_DISABLED: ' TRUE ' }).syncProductIfConfigured('t', 'p');
  assert.deepEqual(calls, ['upsert'], 'solo "true" (sin distinguir mayúsculas ni espacios) activa el aislamiento');
});

test('imágenes: tipo real por firma, límites y ruta estable por contenido', async () => {
  const { MAX_WEB_IMAGE_BYTES, sniffImageType, storageConfigFromEnv, validateImageUpload, webImageObjectPath, publicObjectUrl } = await import('./web-image-storage');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.deepEqual([sniffImageType(jpeg), sniffImageType(png), sniffImageType(webp)], ['image/jpeg', 'image/png', 'image/webp']);
  assert.equal(sniffImageType(Buffer.from('GIF89a')), null);
  assert.equal(sniffImageType(Buffer.from('<svg>')), null, 'SVG no se admite (puede contener scripts)');
  assert.equal(validateImageUpload({ buffer: jpeg, mimetype: 'image/jpeg' }).ok, true);
  assert.deepEqual(validateImageUpload({ buffer: jpeg, mimetype: 'image/png' }), { ok: false, reason: 'TYPE_MISMATCH' });
  assert.deepEqual(validateImageUpload({ buffer: Buffer.alloc(MAX_WEB_IMAGE_BYTES + 1, 0xff) }), { ok: false, reason: 'FILE_TOO_LARGE' });
  assert.deepEqual(validateImageUpload(undefined), { ok: false, reason: 'FILE_REQUIRED' });
  const a = webImageObjectPath({ tenantId: 't-1', groupId: 'UP-W-aa', imageId: 'UP-W-aa-I02', sha256: 'f'.repeat(64), extension: 'webp' });
  assert.equal(a, 'web/t-1/UP-W-aa/UP-W-aa-I02-ffffffffffff.webp');
  assert.equal(webImageObjectPath({ tenantId: '../x', groupId: 'g', imageId: 'i', sha256: 'a'.repeat(64), extension: 'png' }).includes('..'), false, 'sin traversal de rutas');
  assert.equal(storageConfigFromEnv({}), null);
  const cfg = storageConfigFromEnv({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'k' })!;
  assert.equal(cfg.bucket, 'web-catalog');
  assert.equal(publicObjectUrl(cfg, a), 'https://x.supabase.co/storage/v1/object/public/web-catalog/web/t-1/UP-W-aa/UP-W-aa-I02-ffffffffffff.webp');
});

test('SKU: regla deducida de las propuestas', async () => {
  const { skuRuleOf } = await import('./web-catalog-bulk.service');
  assert.equal(skuRuleOf(null, 'UP-0002-01'), 'GENERADO_SIN_SKU');
  assert.equal(skuRuleOf('A-CA-NG13', 'A-CA-NG13'), 'ORIGINAL');
  assert.equal(skuRuleOf('a_b', 'A-B'), 'NORMALIZADO');
  assert.equal(skuRuleOf('A-CA-NG13', 'A-CA-NG13-0041'), 'DESAMBIGUADO_DUPLICADO');
});

test('Shopify aislado: con SHOPIFY_SYNC_DISABLED=true no hay worker, ni reintento, ni sincronización, ni cola; por defecto sigue igual', async () => {
  const { ShopifyService } = await import('../shopify/shopify.service');
  const touched: string[] = [];
  const prisma = new Proxy({}, { get: (_t, name) => new Proxy({}, { get: (_x, method) => async () => { touched.push(`${String(name)}.${String(method)}`); return []; } }) });
  const credentials = { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 't', SHOPIFY_LOCATION_ID: '1' };
  const make = (extra: Record<string, string>) => new ShopifyService(prisma as never, { get: (k: string) => ({ ...credentials, ...extra })[k] } as never);

  const off = make({ SHOPIFY_SYNC_DISABLED: 'true' });
  assert.equal(off.isConfigured(), false, 'con credenciales presentes, el aislamiento gana');
  assert.deepEqual(await off.processPending('t'), { configured: false, processed: 0 });
  await assert.rejects(off.syncProduct('t', 'p'), /desactivada/);
  assert.deepEqual(await off.syncProductIfConfigured('t', 'p'), { configured: false, synced: false, disabled: true });
  assert.deepEqual(touched, [], 'no se tocó ninguna tabla (ni cola ni productos)');

  const on = make({});
  assert.equal(on.isConfigured(), true, 'por defecto, con credenciales, sigue configurado como siempre');
  assert.equal(make({ SHOPIFY_SYNC_DISABLED: 'false' }).isConfigured(), true);
});

test('colecciones del ERP: handles únicos, sin colecciones vacías y relacionadas por ID de grupo', async () => {
  const { WEB_COLLECTIONS } = await import('./web-collections.data');
  assert.ok(WEB_COLLECTIONS.length > 0);
  assert.equal(new Set(WEB_COLLECTIONS.map((c) => c.handle)).size, WEB_COLLECTIONS.length);
  for (const c of WEB_COLLECTIONS) {
    assert.ok(c.title.trim() && c.groupIds.length > 0, c.handle);
    assert.ok(c.groupIds.every((id) => /^UP-P-\d{4}$/.test(id)), c.handle);
    assert.equal(new Set(c.groupIds).size, c.groupIds.length, c.handle);
  }
  const titles = WEB_COLLECTIONS.map((c) => c.title);
  assert.deepEqual([...titles].sort((a, b) => a.localeCompare(b, 'es')), titles);
});

const SK_ID = '11196cac4baf485a84dfd11d511b9aa0';

test('3D: solo URLs de Sketchfab con identificador de 32 hex; todo lo demás se rechaza', () => {
  const ok = { modelId: SK_ID, sourceUrl: `https://sketchfab.com/models/${SK_ID}` };
  assert.deepEqual(parseSketchfabUrl(`https://sketchfab.com/3d-models/joya-vm-${SK_ID}`), ok);
  assert.deepEqual(parseSketchfabUrl(`https://www.sketchfab.com/3d-models/joya-vm-${SK_ID}/?utm=x#a`), ok);
  assert.deepEqual(parseSketchfabUrl(`https://sketchfab.com/models/${SK_ID}/embed`), ok);
  assert.deepEqual(parseSketchfabUrl(`https://sketchfab.com/es/3d-models/${SK_ID}`), ok);
  for (const bad of [
    `http://sketchfab.com/3d-models/joya-${SK_ID}`,
    `https://evil.example/3d-models/joya-${SK_ID}`,
    `https://sketchfab.com.evil.example/models/${SK_ID}`,
    `https://user:pw@sketchfab.com/models/${SK_ID}`,
    'https://sketchfab.com/3d-models/joya-corta-1234',
    `<iframe src="https://sketchfab.com/models/${SK_ID}/embed"></iframe>`,
    `javascript:alert(1)//sketchfab.com/models/${SK_ID}`,
    '', null, 42,
  ]) assert.equal(parseSketchfabUrl(bad), null, String(bad));
});

test('3D: el canal expone models3d solo si el producto lo tiene (contrato intacto sin 3D)', () => {
  const plain = toChannelProduct(group(), [variant()])!;
  assert.equal('models3d' in plain, false);
  const withModel = toChannelProduct(group({ media3d: [{ kind: 'SKETCHFAB', modelId: SK_ID, sourceUrl: `https://sketchfab.com/models/${SK_ID}` }] }), [variant()])!;
  assert.deepEqual(withModel.models3d, [{ kind: 'sketchfab', modelId: SK_ID, sourceUrl: `https://sketchfab.com/models/${SK_ID}`, embedUrl: `https://sketchfab.com/models/${SK_ID}/embed` }]);
  assert.equal('models3d' in toChannelProduct(group({ media3d: [{ kind: 'SKETCHFAB', modelId: 'x', sourceUrl: 'y' }] }), [variant()])!, false, 'entradas corruptas se ignoran');
});

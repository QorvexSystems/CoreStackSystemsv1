const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PrismaClient } = require('@qorvex/database');
const { ConfigService } = require('@nestjs/config');
const { WorkshopService } = require('../dist/modules/workshop/workshop.service');
const { AuditService } = require('../dist/modules/audit/audit.service');

// Run against a disposable, migrated local database only.
const url = process.env.WORKSHOP_SIGNATURE_DATABASE_URL;
test('signed reception persists separately from three photos and advances to OT', { skip: !url }, async () => {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname));
  assert.equal(parsed.pathname, '/signature_test');
  const db = new PrismaClient({ datasourceUrl: url });
  const root = await mkdtemp(join(tmpdir(), 'signed-reception-'));
  const service = new WorkshopService(db, new AuditService(db), new ConfigService({
    IMAGE_STORAGE_DIR: root, IMAGE_STORAGE_PUBLIC_URL: 'https://api.test',
  }));
  try {
    const tenant = await db.tenant.create({ data: { name: 'Taller de pruebas', slug: randomUUID() } });
    const user = await db.user.create({ data: { name: 'Asesor', email: `${randomUUID()}@example.test` } });
    const customer = await db.customer.create({ data: { tenantId: tenant.id, name: 'Cliente de prueba', documentType: 'CONSUMER_FINAL' } });
    const vehicle = await service.createVehicle(tenant.id, user.id, { customerId: customer.id, make: 'Toyota', model: 'Corolla', mileage: 1000 });
    const ticket = await service.createTicket(tenant.id, user.id, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Revisión' });
    await assert.rejects(service.updateTicket(tenant.id, user.id, ticket.id, { status: 'DIAGNOSIS' }), /Completa la recepción/);
    const unsigned = await service.createReception(tenant.id, user.id, ticket.id, { mileage: 1000 });
    assert.equal(unsigned.signatureUrl, null);
    const signatureDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const buffer = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
    const file = { buffer, size: buffer.length, mimetype: 'image/png' };
    const { imageUrls } = await service.uploadReceptionImages(tenant.id, user.id, [file, file, file]);
    let receipt = await service.updateReception(tenant.id, user.id, ticket.id, { imageUrls, signatureDataUrl });
    assert.equal(receipt.imageUrls.length, 3);
    assert.ok(receipt.signatureUrl);
    assert.ok(receipt.signedAt instanceof Date);
    assert.ok(!imageUrls.includes(receipt.signatureUrl));
    assert.deepEqual(await readFile(join(root, receipt.signatureUrl.split('/uploads/')[1])), buffer);
    // Editing the reception requires a new confirmation of its contents.
    receipt = await service.updateReception(tenant.id, user.id, ticket.id, { mileage: 1001 });
    assert.equal(receipt.signatureUrl, null);
    assert.equal(receipt.signedAt, null);
    receipt = await service.updateReception(tenant.id, user.id, ticket.id, { signatureDataUrl });
    await service.saveInspection(tenant.id, user.id, ticket.id, { items: [{ code: 'INITIAL_REVIEW', label: 'Revisión', result: 'GOOD' }] });
    const order = await service.updateTicket(tenant.id, user.id, ticket.id, { status: 'DIAGNOSIS', diagnosis: 'Revisado' });
    assert.equal(order.status, 'DIAGNOSIS');
    assert.equal(order.reception.signatureUrl, receipt.signatureUrl);
    assert.equal(order.reception.imageUrls.length, 3);
    await assert.rejects(service.updateReception(tenant.id, user.id, ticket.id, { signatureDataUrl }), /después de iniciar/);
    const second = await service.createTicket(tenant.id, user.id, { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Recepción sin firma' });
    await service.createReception(tenant.id, user.id, second.id, { mileage: 1001 });
    const unsignedOrder = await service.updateTicket(tenant.id, user.id, second.id, { status: 'DIAGNOSIS' });
    assert.equal(unsignedOrder.status, 'DIAGNOSIS');
    assert.equal(unsignedOrder.reception.signatureUrl, null);
    assert.equal(unsignedOrder.reception.signedAt, null);
  } finally {
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

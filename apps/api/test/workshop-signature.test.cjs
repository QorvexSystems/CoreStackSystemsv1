const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkshopService } = require('../dist/modules/workshop/workshop.service');
const { CreateWorkshopReceptionDto } = require('../dist/modules/workshop/dto/workshop.dto');
const { validate } = require('class-validator');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('signature uses a separate image and a server timestamp', async () => {
  const service = new WorkshopService({}, {}, {});
  let uploads;
  service.uploadReceptionImages = async (tenant, user, files) => {
    uploads = { tenant, user, files };
    return { imageUrls: ['https://api.test/uploads/signature.png'] };
  };
  const signature = await service.saveReceptionSignature('tenant', 'actor', png);
  assert.equal(signature.signatureUrl, 'https://api.test/uploads/signature.png');
  assert.ok(signature.signedAt instanceof Date);
  assert.equal(uploads.files.length, 1);
  assert.equal(uploads.files[0].mimetype, 'image/png');
  assert.equal(uploads.tenant, 'tenant');
  await assert.rejects(service.saveReceptionSignature('tenant', 'actor', 'data:image/png;base64,YWJjZA=='), /PNG válida/);
  await assert.rejects(service.saveReceptionSignature('tenant', 'actor', 'https://external.test/sign.png'), /PNG válida/);
});

test('missing reception cannot transition or create an automatic reception', async () => {
  for (const reception of [null]) {
    const service = new WorkshopService({ $transaction: async (fn) => fn({}) }, {}, {});
    service.lockTicket = async () => ({ status: 'RECEIVED', reception });
    await assert.rejects(service.updateTicket('tenant', 'actor', 'ticket', { status: 'DIAGNOSIS' }), /Completa la recepción/);
  }
});

test('reception DTO rejects invalid or oversized signature data', async () => {
  const dto = Object.assign(new CreateWorkshopReceptionDto(), { mileage: 100, signatureDataUrl: png });
  assert.equal((await validate(dto)).length, 0);
  dto.signatureDataUrl = 'https://external.test/sign.png';
  assert.ok((await validate(dto)).some((error) => error.property === 'signatureDataUrl'));
  dto.signatureDataUrl = 'data:image/png;base64,' + 'A'.repeat(350001);
  assert.ok((await validate(dto)).some((error) => error.property === 'signatureDataUrl'));
});

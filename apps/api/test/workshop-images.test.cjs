const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validate } = require('class-validator');
const { WorkshopService } = require('../dist/modules/workshop/workshop.service');
const { CreateWorkshopReceptionDto } = require('../dist/modules/workshop/dto/workshop.dto');

test('local reception images persist with isolated paths and enforce three-image limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workshop-images-'));
  try {
    const config = { get: (key, fallback) => ({
      IMAGE_STORAGE_DIR: root,
      IMAGE_STORAGE_PUBLIC_URL: 'https://api.example.test',
    }[key] ?? fallback) };
    const service = new WorkshopService({}, { log: async () => {} }, config);
    const file = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), size: 4, mimetype: 'image/jpeg' };
    const { imageUrls } = await service.uploadReceptionImages('../tenant', 'user', [file, file, file]);
    assert.equal(new Set(imageUrls).size, 3);
    for (const url of imageUrls) {
      const path = url.split('/uploads/')[1];
      assert.match(path, /^[a-f0-9]+\/workshop-receptions\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]+\.jpg$/);
      assert.deepEqual(await readFile(join(root, path)), file.buffer);
    }
    await assert.rejects(service.uploadReceptionImages('tenant', 'user', [file, file, file, file]), /tres/);
    await assert.rejects(service.uploadReceptionImages('tenant', 'user', [{ ...file, size: 6 * 1024 * 1024 }]), /5 MB/);
    await assert.rejects(service.uploadReceptionImages('tenant', 'user', [{ ...file, mimetype: 'text/html' }]), /JPG/);
    const dto = Object.assign(new CreateWorkshopReceptionDto(), { mileage: 1, imageUrls });
    assert.equal((await validate(dto)).length, 0);
    dto.imageUrls.push('fourth');
    assert.ok((await validate(dto)).some((error) => error.property === 'imageUrls'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

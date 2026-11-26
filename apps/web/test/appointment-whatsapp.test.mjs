import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const transpile = (path) =>
  ts.transpile(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  });
const brandModule = { exports: {} };
vm.runInNewContext(transpile('../lib/brand.ts'), brandModule);
const module = {
  exports: {},
  Intl,
  Date,
  require: (path) => {
    assert.equal(path, './brand');
    return brandModule.exports;
  },
};
vm.runInNewContext(transpile('../lib/appointment-whatsapp.ts'), module);
const { appointmentWhatsappMessage } = module.exports;
const appointment = {
  startsAt: '2026-11-16T13:15:00.000Z',
  reason: 'Revisión eléctrica',
  customer: { name: 'Cliente' },
  vehicle: { make: 'Toyota', model: 'Corolla', licensePlate: 'A123456' },
};
test('appointment confirmation includes the Dominican local date, time, car and workshop contact', () => {
  const message = appointmentWhatsappMessage(appointment);
  assert.match(message, /lunes,? 16 de noviembre de 2026/);
  assert.match(message, /9:15/);
  for (const value of [
    'Cliente',
    'Toyota',
    'Corolla',
    'A123456',
    'Revisión eléctrica',
    brandModule.exports.brand.address,
    brandModule.exports.brand.phone,
  ])
    assert.ok(message.includes(value));
});
test('appointment near UTC midnight keeps the previous Dominican calendar day', () => {
  const message = appointmentWhatsappMessage({
    ...appointment,
    startsAt: '2026-11-16T00:30:00.000Z',
  });
  assert.match(message, /domingo,? 15 de noviembre de 2026/);
  assert.match(message, /8:30/);
});

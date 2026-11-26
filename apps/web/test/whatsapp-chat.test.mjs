import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhatsappPhone, whatsappChatUrl } from '../lib/whatsapp.ts';

test('WhatsApp chat targets the typed Dominican or international phone number', () => {
  for (const value of ['829 995 1128', '+1 (829) 995-1128', '0018299951128'])
    assert.equal(normalizeWhatsappPhone(value), '18299951128');
  assert.equal(normalizeWhatsappPhone('+34 612 345 678'), '34612345678');
  const url = new URL(whatsappChatUrl('829 995 1128', 'Hola, su vehículo está listo.'));
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/18299951128');
  assert.equal(url.searchParams.get('text'), 'Hola, su vehículo está listo.');
});
test('invalid or missing phones do not generate a generic contact picker link', () => {
  for (const value of ['', '809555', '1234567890123456', '00000000000'])
    assert.equal(whatsappChatUrl(value, 'Hola'), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAllowedPosDocumentTypes, normalizePosDocumentType } from '../lib/pos-document-type.ts';

test('efectivo solo ofrece Nota de venta y Fiscal E31', () => {
  assert.deepEqual(
    getAllowedPosDocumentTypes('CASH').map((option) => option.value),
    ['SALE_NOTE', 'FISCAL_CREDIT_ELECTRONIC_31'],
  );
});

test('tarjeta y medios no efectivos solo ofrecen Consumo E32 y Fiscal E31', () => {
  for (const method of ['CARD', 'MIXED']) {
    assert.deepEqual(
      getAllowedPosDocumentTypes(method).map((option) => option.value),
      ['CONSUMER_ELECTRONIC_32', 'FISCAL_CREDIT_ELECTRONIC_31'],
    );
  }
});

test('al cambiar el método se reemplaza un comprobante incompatible', () => {
  assert.equal(normalizePosDocumentType('CARD', 'SALE_NOTE'), 'CONSUMER_ELECTRONIC_32');
  assert.equal(normalizePosDocumentType('CASH', 'CONSUMER_ELECTRONIC_32'), 'SALE_NOTE');
  assert.equal(
    normalizePosDocumentType('CARD', 'FISCAL_CREDIT_ELECTRONIC_31'),
    'FISCAL_CREDIT_ELECTRONIC_31',
  );
});

test('transferencia permite Nota de venta y E31', () => { assert.deepEqual(getAllowedPosDocumentTypes('TRANSFER').map(option => option.value), ['SALE_NOTE', 'FISCAL_CREDIT_ELECTRONIC_31']); });

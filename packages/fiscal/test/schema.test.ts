import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ECF_TYPES } from '../src/catalog.ts';
import { prepareEcfDraft } from '../src/draft.ts';
import { child, children, element, serializeXml } from '../src/xml.ts';
import { normalizeSchemaForValidator } from '../src/schema-compatibility.ts';
import { XmllintDraftValidator, SchemaValidationError } from '../src/xsd-validator.ts';
import { fixture, replaceField, scope } from './fixtures.ts';

const validator = new XmllintDraftValidator();

test('all 15 official schemas match the source manifest', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../schemas/manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(Object.keys(manifest.files).length, 15);
  for (const [file, entry] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(`../schemas/${file}`, import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      (entry as { sha256: string }).sha256,
    );
  }
});

for (const type of ECF_TYPES) {
  test(`E${type}: synthetic unsigned fixture validates against official structure`, async () => {
    const draft = await prepareEcfDraft(scope, type, fixture(type), validator);
    assert.equal(draft.sendable, false);
    assert.equal(draft.stage, 'SCHEMA_VALIDATED_UNSIGNED');
    assert.equal(draft.filename, `${scope.issuerRnc}E${type}0000000001.xml`);
    assert.equal(draft.sha256.length, 64);
    assert.ok(draft.outstandingChecks.includes('FISCAL_BUSINESS_RULES'));
    assert.ok(!draft.xml.includes('Signature'));
  });
  test(`E${type}: schema rejects missing totals and malformed line amounts`, async () => {
    const missing = fixture(type).map((node) =>
      node.name === 'Encabezado' && Array.isArray(node.value)
        ? element(
            node.name,
            node.value.filter((field) => field.name !== 'Totales'),
          )
        : node,
    );
    await assert.rejects(
      validator.validateUnsignedEcf(type, serializeXml(element('ECF', missing))),
      SchemaValidationError,
    );
    const bad = replaceField(fixture(type), 'MontoItem', '100,00');
    await assert.rejects(
      validator.validateUnsignedEcf(type, serializeXml(element('ECF', bad))),
      SchemaValidationError,
    );
  });
}

test('E31: compatibility adjusts only the reviewed type name in memory', async () => {
  const source = await readFile(new URL('../schemas/ecf-31.xsd', import.meta.url), 'utf8');
  const normalized = normalizeSchemaForValidator(31, source);
  assert.notEqual(normalized, source);
  assert.equal(
    normalized,
    source.replace(
      '<xs:simpleType name=" IndicadorServicioTodoIncluidoType">',
      '<xs:simpleType name="IndicadorServicioTodoIncluidoType">',
    ),
  );
  assert.equal(source.length - normalized.length, 1);
  await prepareEcfDraft(scope, 31, fixture(31), validator);
  assert.equal(await readFile(new URL('../schemas/ecf-31.xsd', import.meta.url), 'utf8'), source);
});

test('E31: changed or already corrected schema requires explicit compatibility review', async () => {
  const source = await readFile(new URL('../schemas/ecf-31.xsd', import.meta.url), 'utf8');
  for (const changed of [
    source + '\n',
    normalizeSchemaForValidator(31, source),
    source.replace('name=" IndicadorServicioTodoIncluidoType"', 'name="OtherType"'),
  ]) {
    assert.throws(() => normalizeSchemaForValidator(31, changed), /requires review/);
  }
});

test('E31 compatibility never modifies the other nine schema types', async () => {
  for (const type of ECF_TYPES.filter((type) => type !== 31)) {
    const source = await readFile(new URL(`../schemas/ecf-${type}.xsd`, import.meta.url), 'utf8');
    assert.equal(normalizeSchemaForValidator(type, source), source);
  }
});

test('E31: optional all-inclusive indicator accepts 1 and rejects invalid values', async () => {
  for (const value of ['1', '0', '2', 'text']) {
    const sections = fixture(31);
    const header = sections[0];
    const idDoc = child(header, 'IdDoc');
    sections[0] = element(
      'Encabezado',
      children(header).map((node) =>
        node === idDoc
          ? element(
              'IdDoc',
              children(idDoc).flatMap((field) =>
                field.name === 'TipoIngresos'
                  ? [element('IndicadorServicioTodoIncluido', value), field]
                  : [field],
              ),
            )
          : node,
      ),
    );
    const validation = prepareEcfDraft(scope, 31, sections, validator);
    if (value === '1') {
      assert.equal((await validation).sendable, false);
    } else {
      await assert.rejects(validation, SchemaValidationError);
    }
  }
});

test('strict schema ordering and unknown fields are rejected', async () => {
  const sections = fixture(32);
  [sections[0], sections[1]] = [sections[1], sections[0]];
  await assert.rejects(
    validator.validateUnsignedEcf(32, serializeXml(element('ECF', sections))),
    SchemaValidationError,
  );
  await assert.rejects(
    validator.validateUnsignedEcf(
      32,
      serializeXml(element('ECF', [...fixture(32), element('Unexpected', '1')])),
    ),
    SchemaValidationError,
  );
});

test('DTD/external entities and XML size abuse fail before parsing', async () => {
  await assert.rejects(
    validator.validateUnsignedEcf(
      31,
      '<!DOCTYPE ECF [<!ENTITY x SYSTEM "file:///etc/passwd">]><ECF>&x;</ECF>',
    ),
    SchemaValidationError,
  );
  await assert.rejects(
    validator.validateUnsignedEcf(31, 'x'.repeat(2 * 1024 * 1024 + 1)),
    SchemaValidationError,
  );
});

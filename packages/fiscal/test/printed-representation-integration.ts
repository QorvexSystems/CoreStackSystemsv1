// Real cryptography for synthetic documents only. No DGII or production access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { ECF_TYPES } from '../src/catalog.ts';
import { element, serializeXml, type XmlElement } from '../src/xml.ts';
import {
  preparePrintedRepresentation,
  preparePrintedHtml,
  renderPrintedRepresentation,
} from '../src/printed-representation.ts';
import { syntheticSigner } from './synthetic-signer.ts';
import { fixture } from './fixtures.ts';
const scope = {
  tenantId: 'offline-delivery',
  issuerRnc: '101010632',
  environment: 'precertification' as const,
};
const leaves = (node: XmlElement): number =>
  typeof node.value === 'string' ? 1 : node.value.reduce((n, child) => n + leaves(child), 0);
test('signed RI projection covers all ten types without losing fiscal scalar fields', async () => {
  const signer = await syntheticSigner(scope);
  try {
    for (const type of ECF_TYPES) {
      const root = element('ECF', fixture(type));
      const signed = await signer.sign('ECF', serializeXml(root));
      const model = await preparePrintedRepresentation(scope, root, signed, signer.printVerify);
      assert.equal(model.encf, `E${type}0000000001`);
      assert.equal(
        model.securityCode,
        signed
          .match(/<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/)![1]!
          .replace(/\s/g, '')
          .slice(0, 6),
      );
      assert.equal(
        model.sections.reduce((n, section) => n + section.fields.length, 0) +
          model.lines.reduce((n, line) => n + line.length, 0) +
          1,
        leaves(root),
      );
      assert.ok(Object.isFrozen(model.lines[0]));
      // Rendering contract only: placeholder SVG is NOT an encoding test.
      const matrix = model.qrVersion === 8 ? 57 : 61;
      const html = renderPrintedRepresentation(model, `<svg viewBox="0 0 ${matrix} ${matrix}"></svg>`);
      assert.ok(html.includes('SIN VALIDEZ FISCAL'));
      assert.ok(html.includes('Producto &amp; servicio &lt;prueba&gt;'));
      assert.ok(html.includes(model.securityCode));
      if (type === 33 || type === 34) assert.ok(html.includes('E310000000001'));
      if (type === 47) assert.ok(html.includes('27.00'));
      await assert.rejects(
        preparePrintedRepresentation(
          scope,
          root,
          signed.replace('100.00', '100.01'),
          signer.printVerify,
        ),
      );
      await assert.rejects(
        preparePrintedRepresentation(
          { ...scope, environment: 'production' },
          root,
          signed,
          signer.printVerify,
        ),
        /PRODUCTION_ACTIVATION_REQUIRED/,
      );
      await assert.rejects(
        preparePrintedHtml(scope, root, signed, signer.printVerify, () => {
          throw Error('QR_CAPACITY_EXCEEDED');
        }),
        /CAPACITY/,
      );
      const wrongMatrix = model.qrVersion === 8 ? 61 : 57;
      assert.throws(() => renderPrintedRepresentation(model, `<svg viewBox="0 0 ${wrongMatrix} ${wrongMatrix}"></svg>`));
      assert.throws(() =>
        renderPrintedRepresentation(
          model,
          `<svg viewBox="0 0 ${matrix} ${matrix}"><script>alert(1)</script></svg>`,
        ),
      );
      if (type === 32 && process.env.EXPORT_SYNTHETIC_RI === 'true')
        await writeFile('/output/synthetic-ri-model.json', JSON.stringify(model), { mode: 0o600 });
    }
  } finally {
    await signer.close();
  }
});

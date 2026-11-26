// Run only in Dockerfile.signing-test with --network none and tmpfs /tmp.
// Certificates/keys are ephemeral, unrelated to RIVNU and NOT valid for DGII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, scope } from './fixtures.ts';
import { serializeXml, element } from '../src/xml.ts';
import { XmllintDraftValidator } from '../src/xsd-validator.ts';
import { ECF_TYPES } from '../src/catalog.ts';
import {
  prepareAreCf,
  prepareAceCf,
  prepareAnEcf,
  prepareSeed,
  prepareRfce,
} from '../src/auxiliary.ts';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
async function run(command: string, args: string[]) {
  try {
    return await execute(command, args, {
      timeout: 15000,
      maxBuffer: 2097152,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', XML_CATALOG_FILES: '' },
    });
  } catch {
    throw new Error('SYNTHETIC_CRYPTO_COMMAND_FAILED');
  } // never dump key/XML diagnostics
}
const signature =
  '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue/></Reference></SignedInfo><SignatureValue/><KeyInfo><X509Data><X509Certificate/></X509Data></KeyInfo></Signature>';

test('offline real XMLDSig roundtrip: ten eCF types, five auxiliaries, tamper and wrong-key rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corestack-synthetic-signature-'));
  try {
    const key = join(directory, 'synthetic.key.pem'),
      cert = join(directory, 'synthetic.crt.pem');
    const wrongKey = join(directory, 'wrong.key.pem'),
      wrongCert = join(directory, 'wrong.crt.pem');
    for (const [k, c, cn] of [
      [key, cert, 'SYNTHETIC-NOT-DGII'],
      [wrongKey, wrongCert, 'WRONG-SYNTHETIC'],
    ]) {
      await run('openssl', [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-x509',
        '-days',
        '1',
        '-subj',
        `/CN=${cn}`,
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature',
        '-keyout',
        k,
        '-out',
        c,
      ]);
      await chmod(k, 0o400);
    }
    const unsigned = join(directory, 'template.xml'),
      signed = join(directory, 'signed.xml');
    const verify = async (file: string, certificate = cert) => {
      const input = await readFile(file, 'utf8');
      assert.ok(!/<!|RetrievalMethod/.test(input)); // generated test profile only
      return run('xmlsec1', [
        '--verify',
        '--enabled-reference-uris',
        'empty',
        '--enabled-key-data',
        'x509',
        '--trusted-pem',
        certificate,
        file,
      ]);
    };
    async function sign(xml: string) {
      assert.ok(!/<!|<Signature\b/.test(xml));
      const closing = xml.match(/<\/([A-Za-z][A-Za-z0-9]*)>$/);
      assert.ok(closing);
      await writeFile(unsigned, xml.slice(0, -closing[0].length) + signature + closing[0], {
        mode: 0o600,
      });
      await run('xmlsec1', [
        '--sign',
        '--enabled-reference-uris',
        'empty',
        '--enabled-key-data',
        'x509',
        '--privkey-pem',
        `${key},${cert}`,
        '--output',
        signed,
        unsigned,
      ]);
      await verify(signed);
      const bytes = await readFile(signed, 'utf8');
      assert.match(bytes, /<Reference URI="">/);
      assert.match(bytes, /rsa-sha256/);
      const signatureValue = bytes
        .match(/<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/)?.[1]
        .replace(/\s/g, '');
      assert.ok(signatureValue && Buffer.from(signatureValue, 'base64').length === 256);
      return bytes;
    }
    for (const type of ECF_TYPES) {
      const xml = serializeXml(element('ECF', fixture(type)));
      await new XmllintDraftValidator().validateUnsignedEcf(type, xml);
      const bytes = await sign(xml);
      // Changes to identity or amounts invalidate the signature over the whole doc.
      const tampered = join(directory, 'tampered.xml');
      await writeFile(
        tampered,
        bytes.replace('<MontoTotal>100.00</MontoTotal>', '<MontoTotal>100.01</MontoTotal>'),
        { mode: 0o600 },
      );
      await assert.rejects(verify(tampered), /CRYPTO_COMMAND_FAILED/);
    }
    await assert.rejects(verify(signed, wrongCert), /CRYPTO_COMMAND_FAILED/);
    const receipt = {
      issuerRnc: '101010641',
      buyerRnc: scope.issuerRnc,
      encf: 'E310000000001',
      at: '2026-09-23T10:00:00-04:00',
    };
    for (const auxiliary of [
      await prepareAreCf(scope, { ...receipt, state: 0 }),
      await prepareAceCf(scope, { ...receipt, state: 1, issuedOn: '2026-09-22', total: '100.00' }),
      await prepareAnEcf(scope, {
        at: receipt.at,
        groups: [{ type: 31, ranges: [{ from: 'E310000000002', to: 'E310000000003' }] }],
      }),
      await prepareSeed(scope, 'synthetic-challenge', '2026-09-23T14:00:00Z'),
    ])
      await sign(auxiliary.xml);
    // A complete E32 is signed first; its security code feeds the summary.
    const sections = fixture(32);
    const header = sections[0]!;
    sections[0] = element(
      'Encabezado',
      (header.value as ReturnType<typeof element>[]).map((n) =>
        n.name === 'Totales'
          ? element('Totales', [element('MontoExento', '100.00'), element('MontoTotal', '100.00')])
          : n,
      ),
    );
    const source = element('ECF', sections),
      xml = serializeXml(source);
    const fullE32 = await sign(xml);
    const code = fullE32
      .match(/<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/)![1]
      .replace(/\s/g, '')
      .slice(0, 6);
    const rfce = await prepareRfce(scope, source, {
      unsignedEcfSha256: createHash('sha256').update(xml).digest('hex'),
      securityCode: code,
    });
    assert.ok(rfce.xml.includes(`<CodigoSeguridadeCF>${code}</CodigoSeguridadeCF>`));
    await sign(rfce.xml);
    // Reference retrieval is explicitly disabled, including local files.
    const changed = (await readFile(signed, 'utf8')).replace(
      'Reference URI=""',
      'Reference URI="file:///etc/passwd"',
    );
    const external = join(directory, 'external-reference.xml');
    await writeFile(external, changed, { mode: 0o600 });
    await assert.rejects(verify(external), /CRYPTO_COMMAND_FAILED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

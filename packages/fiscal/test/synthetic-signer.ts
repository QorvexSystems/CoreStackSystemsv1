// TEST ONLY. Ephemeral identity pinned to generated documents, never fiscal delegation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, X509Certificate } from 'node:crypto';
import type { FiscalScope } from '../src/catalog.ts';
import type { SignedXmlVerifier } from '../src/dgii-client.ts';
import type { DeliveryBundleVerifier } from '../src/delivery-enqueue.ts';
import type { PrintedEvidenceVerifier } from '../src/printed-representation.ts';
import { prepareRfce } from '../src/auxiliary.ts';
import { serializeXml, type XmlElement } from '../src/xml.ts';
const exec = promisify(execFile);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const template =
  '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue/></Reference></SignedInfo><SignatureValue/><KeyInfo><X509Data><X509Certificate/></X509Data></KeyInfo></Signature>';
export async function syntheticSigner(scope: FiscalScope, persistentPreview = false) {
  if (persistentPreview) {
    assert.equal(process.env.FISCAL_SYNTHETIC_PREVIEW, 'NO_FISCAL_VALIDITY');
    assert.equal(scope.tenantId, 'cmt397emm0002nm0ogb50l2q6');
    assert.equal(scope.issuerRnc, '40220429126');
  } else assert.equal(scope.tenantId, 'offline-delivery');
  assert.equal(scope.environment, 'precertification');
  const directory = persistentPreview
    ? '/run/synthetic-state/identity'
    : await mkdtemp(join(tmpdir(), 'synthetic-delivery-'));
  if (persistentPreview) await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = join(directory, 'key.pem'),
    cert = join(directory, 'cert.pem');
  async function run(command: string, args: string[]) {
    try {
      return await exec(command, args, {
        timeout: 15000,
        maxBuffer: 4194304,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', XML_CATALOG_FILES: '' },
      });
    } catch {
      throw Error('SYNTHETIC_CRYPTO_FAILED');
    }
  }
  let existing = false;
  if (persistentPreview) {
    const present = await Promise.all(
      [cert, key, join(directory, 'journal.json')].map(async (path) => {
        try {
          await stat(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }),
    );
    if (present.some(Boolean) && !present.every(Boolean))
      throw Error('SYNTHETIC_IDENTITY_INCOMPLETE');
    existing = present.every(Boolean);
  }
  try {
    if (!existing)
      await run('openssl', [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-x509',
        '-days',
        persistentPreview ? '30' : '1',
        '-subj',
        '/CN=SYNTHETIC-NOT-DGII',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'keyUsage=critical,digitalSignature',
        '-keyout',
        key,
        '-out',
        cert,
      ]);
    await chmod(key, 0o400);
  } catch (error) {
    if (!persistentPreview) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const certificateSha256 = createHash('sha256')
    .update(new X509Certificate(await readFile(cert)).raw)
    .digest('hex');
  const sources = new Map<string, { xml: string; kind: Parameters<SignedXmlVerifier>[1] }>();
  const summaries = new Map<string, string>();
  const signedBySource = new Map<string, string>();
  if (existing) {
    const journal = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'));
    assert.equal(journal.certificateSha256, certificateSha256);
    for (const [key, value] of journal.sources) sources.set(key, value);
    for (const [key, value] of journal.summaries) summaries.set(key, value);
    for (const [key, value] of journal.signedBySource) signedBySource.set(key, value);
  }
  async function persist() {
    if (!persistentPreview) return;
    assert.ok(sources.size <= 1000, 'SYNTHETIC_JOURNAL_LIMIT');
    await writeFile(
      join(directory, 'journal.next'),
      JSON.stringify({
        certificateSha256,
        sources: [...sources],
        summaries: [...summaries],
        signedBySource: [...signedBySource],
      }),
      { mode: 0o600 },
    );
    await rename(join(directory, 'journal.next'), join(directory, 'journal.json'));
  }
  if (persistentPreview && !existing) await persist();
  let serial = 0;
  async function cryptographicCheck(xml: string) {
    assert.ok(Buffer.byteLength(xml) <= 2097152 && !/<!|RetrievalMethod/.test(xml));
    assert.equal((xml.match(/<Signature xmlns=/g) ?? []).length, 1);
    assert.equal((xml.match(/<Reference URI="">/g) ?? []).length, 1);
    const file = join(directory, `verify-${++serial}.xml`);
    await writeFile(file, xml, { mode: 0o600 });
    try {
      await run('xmlsec1', [
        '--verify',
        '--enabled-reference-uris',
        'empty',
        '--enabled-key-data',
        'x509',
        '--trusted-pem',
        cert,
        file,
      ]);
    } finally {
      await rm(file);
    }
  }
  async function sign(kind: Parameters<SignedXmlVerifier>[1], xml: string) {
    assert.ok(!/<!|<Signature\b/.test(xml));
    const cached = signedBySource.get(kind + ':' + hash(xml));
    if (cached) {
      await cryptographicCheck(cached);
      return cached;
    }
    const closing = xml.match(/<\/([A-Za-z][A-Za-z0-9]*)>$/);
    assert.ok(closing);
    const input = join(directory, `in-${++serial}.xml`),
      output = join(directory, `out-${serial}.xml`);
    await writeFile(input, xml.slice(0, -closing[0].length) + template + closing[0], {
      mode: 0o600,
    });
    try {
      await run('xmlsec1', [
        '--sign',
        '--enabled-reference-uris',
        'empty',
        '--enabled-key-data',
        'x509',
        '--privkey-pem',
        `${key},${cert}`,
        '--output',
        output,
        input,
      ]);
      const signed = await readFile(output, 'utf8');
      await cryptographicCheck(signed);
      sources.set(hash(signed), { xml, kind });
      signedBySource.set(kind + ':' + hash(xml), signed);
      await persist();
      return signed;
    } finally {
      await rm(input, { force: true });
      await rm(output, { force: true });
    }
  }
  const verify: SignedXmlVerifier = async (requested, kind, xml) => {
    assert.deepEqual(requested, scope);
    await cryptographicCheck(xml);
    const source = sources.get(hash(xml));
    assert.ok(source && source.kind === kind, 'Only generated synthetic evidence is authorized');
    const one = (tag: string) => {
      const found = [...source.xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
      assert.equal(found.length, 1);
      return found[0]![1]!;
    };
    if (kind === 'SEMILLA') return { sha256: hash(xml), actorRnc: scope.issuerRnc };
    assert.equal(one('RNCEmisor'), scope.issuerRnc);
    return {
      sha256: hash(xml),
      actorRnc: one('RNCEmisor'),
      encf: one('eNCF'),
      total: one('MontoTotal'),
      securityCode: kind === 'RFCE' ? one('CodigoSeguridadeCF') : undefined,
    };
  };
  const bundle: DeliveryBundleVerifier = async (requested, input) => {
    const ecf = await verify(requested, 'ECF', input.signedEcfXml);
    assert.equal(sources.get(hash(input.signedEcfXml))!.xml, input.unsignedEcfXml);
    if (input.route === 'ECF') assert.equal(input.signedEcfXml, input.submissionXml);
    else assert.equal(summaries.get(hash(input.submissionXml)), hash(input.signedEcfXml));
    const submission =
      input.route === 'ECF' ? ecf : await verify(requested, 'RFCE', input.submissionXml);
    return { ecf, submission, certificateSha256, sourceSha256: hash(input.unsignedEcfXml) };
  };
  async function summary(root: XmlElement, signedEcf: string) {
    await verify(scope, 'ECF', signedEcf);
    const unsigned = sources.get(hash(signedEcf))!.xml;
    assert.equal(serializeXml(root), unsigned);
    const securityCode = signedEcf
      .match(/<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/)![1]!
      .replace(/\s/g, '')
      .slice(0, 6);
    const rfce = await prepareRfce(scope, root, {
      unsignedEcfSha256: hash(unsigned),
      securityCode,
    });
    const signed = await sign('RFCE', rfce.xml);
    summaries.set(hash(signed), hash(signedEcf));
    await persist();
    return signed;
  }
  const printVerify: PrintedEvidenceVerifier = async (requested, input) => {
    const ecf = await verify(requested, 'ECF', input.signedXml);
    assert.equal(sources.get(hash(input.signedXml))!.xml, input.unsignedXml);
    const securityCode = input.signedXml
      .match(/<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/)![1]!
      .replace(/\s/g, '')
      .slice(0, 6);
    return {
      sourceSha256: hash(input.unsignedXml),
      signedSha256: ecf.sha256,
      issuerRnc: ecf.actorRnc,
      encf: ecf.encf!,
      securityCode,
    };
  };
  return {
    sign,
    verify,
    bundle,
    summary,
    printVerify,
    close: () =>
      persistentPreview ? Promise.resolve() : rm(directory, { recursive: true, force: true }),
  };
}

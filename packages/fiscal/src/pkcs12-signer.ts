import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertScope, type FiscalScope } from './catalog.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

const XMLDSIG_TEMPLATE =
  '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue/></Reference></SignedInfo><SignatureValue/><KeyInfo><X509Data><X509Certificate/></X509Data></KeyInfo></Signature>';

export type Pkcs12SignerConfig = Readonly<{
  scope: FiscalScope;
  p12Path: string;
  passwordPath: string;
  rootCertificatePath: string;
  subordinateCertificatePath: string;
  crlPath: string;
  expectedCertificateSha256: string;
  workRoot?: string;
}>;

export type Pkcs12Signer = Readonly<{
  certificateSha256: string;
  sign(xml: string): Promise<string>;
  verify(xml: string): Promise<{ sha256: string }>;
  close(): Promise<void>;
}>;

/** DGII verifies XML signatures with PreserveWhitespace=false. Remove only
 * whitespace-only nodes between markup; never normalize fiscal text values. */
export function xmlWithoutInsignificantWhitespace(xml: string): string {
  safeXml(xml, false);
  return xml.replace(/>\s+</g, '><');
}

function safeXml(xml: string, signed: boolean) {
  if (
    typeof xml !== 'string' ||
    Buffer.byteLength(xml, 'utf8') < 1 ||
    Buffer.byteLength(xml, 'utf8') > 2 * 1024 * 1024 ||
    /<!|<\?(?!xml\s)/i.test(xml) ||
    (signed ? (xml.match(/<Signature\s+xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/g) ?? []).length !== 1 : /<Signature\b/.test(xml))
  )
    throw Error('SIGNING_INPUT_REJECTED');
}

export function unsignedXmlFromGeneratedSignature(xml: string): string {
  safeXml(xml, true);
  const opening = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">';
  const start = xml.indexOf(opening);
  const end = xml.indexOf('</Signature>', start + opening.length);
  if (
    start < 0 ||
    end < 0 ||
    xml.indexOf(opening, start + opening.length) >= 0 ||
    /<(?:[A-Za-z][A-Za-z0-9]*:)?(?:Object|RetrievalMethod)\b/.test(xml)
  )
    throw Error('SIGNED_XML_PROFILE_REJECTED');
  const after = end + '</Signature>'.length;
  const closing = /^\s*(<\/([A-Za-z][A-Za-z0-9]*)>)\s*$/.exec(xml.slice(after));
  if (!closing) throw Error('SIGNED_XML_PROFILE_REJECTED');
  // libxml/xmlsec serializes the one XSD-required empty E32 container as
  // <Comprador/> even when our canonical source used
  // <Comprador></Comprador>. Both have the same XML canonical form and signed
  // digest. Normalize only this explicitly allowed empty container back to the
  // internal source representation before enforcing exact source binding.
  const unsigned = (xml.slice(0, start) + closing[1]).replace(
    /<Comprador\/>/g,
    '<Comprador></Comprador>',
  );
  const declaration = '<?xml version="1.0" encoding="utf-8"?>';
  return unsigned.startsWith(`${declaration}\n`)
    ? declaration + unsigned.slice(declaration.length + 1)
    : unsigned;
}

export function securityCodeFromGeneratedSignature(xml: string): string {
  unsignedXmlFromGeneratedSignature(xml);
  const values = [...xml.matchAll(/<SignatureValue>([A-Za-z0-9+/=\s]+)<\/SignatureValue>/g)];
  if (values.length !== 1) throw Error('SIGNED_XML_PROFILE_REJECTED');
  const value = values[0]![1]!.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length < 6)
    throw Error('SIGNED_XML_PROFILE_REJECTED');
  return value.slice(0, 6);
}

async function regularFile(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error('SIGNER_FILE_INVALID');
}

async function command(program: string, args: readonly string[], stage: string, timeout = 15_000) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, [...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', XML_CATALOG_FILES: '' },
    });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('SIGNER_COMMAND_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(Error('SIGNER_COMMAND_TIMEOUT'));
      else if (code === 0) resolve();
      else reject(Error(`SIGNER_COMMAND_FAILED_${stage}`));
    });
  });
}

/** PKCS#12 adapter for a dedicated, non-production signing process. Private key
 * material is extracted only into the configured tmpfs and never returned.
 */
export async function createPkcs12XmlSigner(config: Pkcs12SignerConfig): Promise<Pkcs12Signer> {
  assertScope(config.scope);
  assertFiscalEnvironmentEnabled(config.scope, config.expectedCertificateSha256.toLowerCase());
  if (!/^[a-f0-9]{64}$/.test(config.expectedCertificateSha256))
    throw Error('SIGNER_FINGERPRINT_INVALID');
  for (const path of [
    config.p12Path,
    config.passwordPath,
    config.rootCertificatePath,
    config.subordinateCertificatePath,
    config.crlPath,
  ])
    await regularFile(path);
  const password = await readFile(config.passwordPath);
  if (password.length < 1 || password.length > 1024 || password.includes(0x0a) || password.includes(0x0d))
    throw Error('SIGNER_PASSWORD_FILE_INVALID');

  const directory = await mkdtemp(join(config.workRoot ?? '/tmp', 'corestack-pkcs12-signer-'));
  const privateKey = join(directory, 'private.pem');
  const certificate = join(directory, 'certificate.pem');
  let closed = false;
  try {
    await command('openssl', [
      'pkcs12', '-legacy', '-in', config.p12Path, '-clcerts', '-nokeys', '-out', certificate,
      '-passin', `file:${config.passwordPath}`,
    ], 'CERTIFICATE_EXTRACTION');
    await command('openssl', [
      'pkcs12', '-legacy', '-in', config.p12Path, '-nocerts', '-nodes', '-out', privateKey,
      '-passin', `file:${config.passwordPath}`,
    ], 'PRIVATE_KEY_EXTRACTION');
    await chmod(privateKey, 0o400);
    await chmod(certificate, 0o400);
    const parsedCertificate = new X509Certificate(await readFile(certificate));
    const certificateSha256 = createHash('sha256').update(parsedCertificate.raw).digest('hex');
    if (certificateSha256 !== config.expectedCertificateSha256)
      throw Error('SIGNER_CERTIFICATE_FINGERPRINT_MISMATCH');
    if (!parsedCertificate.subject.includes(`IDCDO-${config.scope.issuerRnc}`))
      throw Error('SIGNER_CERTIFICATE_SCOPE_MISMATCH');
    await command('openssl', ['x509', '-in', certificate, '-checkend', '0', '-noout'], 'CERTIFICATE_VALIDITY');
    await command('openssl', [
      'verify', '-purpose', 'any', '-crl_check', '-CAfile', config.rootCertificatePath,
      '-untrusted', config.subordinateCertificatePath, '-CRLfile', config.crlPath, certificate,
    ], 'CERTIFICATE_TRUST');

    let sequence = 0;
    async function verify(xml: string) {
      if (closed) throw Error('SIGNER_CLOSED');
      safeXml(xml, true);
      const signedPath = join(directory, `verify-${++sequence}.xml`);
      await writeFile(signedPath, xml, { mode: 0o600 });
      try {
        await command('xmlsec1', [
          '--verify', '--enabled-reference-uris', 'empty', '--enabled-key-data', 'x509',
          '--pubkey-cert-pem', certificate, signedPath,
        ], 'XML_SIGNATURE_VERIFICATION');
      } finally {
        await rm(signedPath, { force: true });
      }
      return { sha256: createHash('sha256').update(xml).digest('hex') };
    }

    async function sign(xml: string) {
      if (closed) throw Error('SIGNER_CLOSED');
      const normalizedXml = xmlWithoutInsignificantWhitespace(xml);
      const closing = normalizedXml.match(/<\/([A-Za-z][A-Za-z0-9]*)>$/);
      if (!closing) throw Error('SIGNING_INPUT_REJECTED');
      const id = ++sequence;
      const inputPath = join(directory, `unsigned-${id}.xml`);
      const outputPath = join(directory, `signed-${id}.xml`);
      await writeFile(
        inputPath,
        normalizedXml.slice(0, -closing[0].length) + XMLDSIG_TEMPLATE + closing[0],
        { mode: 0o600 },
      );
      try {
        await command('xmlsec1', [
          '--sign', '--enabled-reference-uris', 'empty', '--enabled-key-data', 'x509',
          '--privkey-pem', `${privateKey},${certificate}`, '--output', outputPath, inputPath,
        ], 'XML_SIGNATURE_CREATION');
        const signed = await readFile(outputPath, 'utf8');
        await verify(signed);
        return signed;
      } finally {
        await rm(inputPath, { force: true });
        await rm(outputPath, { force: true });
      }
    }

    return Object.freeze({
      certificateSha256,
      sign,
      verify,
      async close() {
        if (closed) return;
        closed = true;
        await rm(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    password.fill(0);
  }
}

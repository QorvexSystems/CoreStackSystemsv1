import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import {
  createPkcs12XmlSigner,
  unsignedXmlFromGeneratedSignature,
  xmlWithoutInsignificantWhitespace,
} from './pkcs12-signer.ts';

const inputPath = '/input/declaracion-jurada.xml';
const outputPath = '/output/declaracion-jurada-firmada.xml';
const expectedInputSha256 = '98e27b87ff9219c490c748a2e0f579ac1bcddae0b43cc15d061cc15ff7764164';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});

let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
try {
  const metadata = await lstat(inputPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 100 || metadata.size > 524288)
    throw Error('DECLARATION_FILE_INVALID');
  const input = await readFile(inputPath);
  if (createHash('sha256').update(input).digest('hex') !== expectedInputSha256)
    throw Error('DECLARATION_SOURCE_HASH_MISMATCH');
  const xml = input.toString('utf8');
  if (!Buffer.from(xml, 'utf8').equals(input)) throw Error('DECLARATION_ENCODING_INVALID');
  if (
    /<!|<Signature\b/.test(xml) ||
    (xml.match(/<DeclaracionJurada\b/g) ?? []).length !== 1 ||
    (xml.match(/<DetalleGeneral>/g) ?? []).length !== 1 ||
    !/<DeclaracionJurada\s[^>]*>[\s\S]*<DetalleGeneral>[^<]+<\/DetalleGeneral>\s*<\/DeclaracionJurada>\s*$/.test(xml)
  ) throw Error('DECLARATION_STRUCTURE_INVALID');

  signer = await createPkcs12XmlSigner({
    scope,
    p12Path: '/run/secrets/signing/certificate.p12',
    passwordPath: '/run/secrets/signing/password',
    rootCertificatePath: '/run/trust/digifirma/root.crt',
    subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
    crlPath: '/run/trust/digifirma/subordinate.crl.pem',
    expectedCertificateSha256: 'a4348bad3005f70073f5d048d7789a9f9289addb3004ca84319feb1e5f41012d',
    workRoot: '/run/signing-work',
  });
  const signed = await signer.sign(xml);
  await signer.verify(signed);
  if (unsignedXmlFromGeneratedSignature(signed) !== xmlWithoutInsignificantWhitespace(xml))
    throw Error('SIGNED_DECLARATION_CONTENT_MISMATCH');
  if ((signed.match(/<SignatureValue>/g) ?? []).length !== 1)
    throw Error('SIGNED_DECLARATION_INVALID');
  await writeFile(outputPath, signed, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log('RIVNU_SWORN_DECLARATION_SIGNED_AND_VERIFIED');
  console.log(`Unsigned SHA-256: ${expectedInputSha256}`);
  console.log(`Signed SHA-256: ${createHash('sha256').update(signed).digest('hex')}`);
} catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
    ? error.message : 'DECLARATION_SIGNING_FAILED';
  console.error(code);
  process.exitCode = 1;
} finally {
  await signer?.close();
}

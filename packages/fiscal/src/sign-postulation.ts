import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createPkcs12XmlSigner } from './pkcs12-signer.ts';

const inputPath = '/input/postulacion.xml';
const outputPath = '/output/postulacion-firmada.xml';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'precertification' as const,
});
let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
try {
  const metadata = await lstat(inputPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 100 || metadata.size > 524288)
    throw Error('POSTULATION_FILE_INVALID');
  const xml = await readFile(inputPath, 'utf8');
  const exact = (value: string) => xml.split(value).length === 2;
  if (
    /<!|<Signature\b/.test(xml) ||
    !exact('<PostulacionID>84014</PostulacionID>') ||
    !exact('<RNCContribuyente>40220429126</RNCContribuyente>') ||
    !exact('<RNCRepresentante>40220429126</RNCRepresentante>') ||
    !exact('<GrupoComprobante>31,32,33,34,41,43,44,45,46,47</GrupoComprobante>') ||
    !exact('<NombreSoftware>CoreStack</NombreSoftware>') ||
    !exact('<VersionSoftware>1.0</VersionSoftware>') ||
    !['UrlRecepcion', 'UrlAprobacionComercial', 'UrlAutenticacion'].every((name) =>
      exact(`<${name}>rivnu.corestack-systems.com</${name}>`),
    ) ||
    !/<Postulacion\s[^>]*>[\s\S]*<\/Postulacion>$/.test(xml)
  ) throw Error('POSTULATION_SCOPE_MISMATCH');
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
  if (!signed.includes('<PostulacionID>84014</PostulacionID>') || !signed.includes('<SignatureValue>'))
    throw Error('SIGNED_POSTULATION_INVALID');
  await writeFile(outputPath, signed, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log('RIVNU_POSTULATION_84014_SIGNED_AND_VERIFIED');
  console.log(`Unsigned SHA-256: ${createHash('sha256').update(xml).digest('hex')}`);
  console.log(`Signed SHA-256: ${createHash('sha256').update(signed).digest('hex')}`);
} catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
    ? error.message : 'POSTULATION_SIGNING_FAILED';
  console.error(code);
  process.exitCode = 1;
} finally {
  await signer?.close();
}

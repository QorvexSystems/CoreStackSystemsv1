import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createPkcs12XmlSigner, unsignedXmlFromGeneratedSignature } from './pkcs12-signer.ts';
import { XmllintDraftValidator } from './xsd-validator.ts';

const inputRoot = '/input';
const outputRoot = '/output';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const expectedSource = '63e6a64d5b014294651cce76dc5933b7b5838e20df55621a10f0e28dbe02bad1';
const expectedIssuer = '131880681';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};
const one = (xml: string, tag: string) => {
  const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
  ensure(matches.length === 1, 'COMMERCIAL_APPROVAL_IDENTITY_INVALID');
  return matches[0]![1]!;
};

type Entry = {
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
  state: number;
  sha256: string;
  bytes: number;
};
type Manifest = {
  sourceSha256: string;
  buyerRnc: string;
  environment: string;
  approvals: Entry[];
};

let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
try {
  const manifest = JSON.parse(await readFile(`${inputRoot}/manifest.json`, 'utf8')) as Manifest;
  ensure(
    manifest.sourceSha256 === expectedSource &&
      manifest.buyerRnc === scope.issuerRnc &&
      manifest.environment === scope.environment &&
      manifest.approvals.length === 11,
    'COMMERCIAL_APPROVAL_MANIFEST_SCOPE_INVALID',
  );
  const names = (await readdir(`${inputRoot}/acecf-unsigned`)).sort();
  const expectedNames = manifest.approvals.map((entry) => `ACECF-${entry.encf}.xml`).sort();
  ensure(JSON.stringify(names) === JSON.stringify(expectedNames), 'COMMERCIAL_APPROVAL_INPUT_FILES_INVALID');

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
  const validator = new XmllintDraftValidator();
  await mkdir(`${outputRoot}/acecf-signed`, { mode: 0o700 });
  const report: Record<string, unknown> = {
    sourceSha256: expectedSource,
    scope,
    certificateSha256: signer.certificateSha256,
    createdAt: new Date().toISOString(),
    approvals: [],
  };
  for (const entry of manifest.approvals) {
    ensure(
      entry.issuerRnc === expectedIssuer &&
        entry.buyerRnc === scope.issuerRnc &&
        entry.state === 1,
      'COMMERCIAL_APPROVAL_ENTRY_SCOPE_INVALID',
    );
    const draft = await readFile(`${inputRoot}/acecf-unsigned/ACECF-${entry.encf}.xml`, 'utf8');
    ensure(hash(draft) === entry.sha256 && Buffer.byteLength(draft) === entry.bytes,
      'COMMERCIAL_APPROVAL_DRAFT_HASH_MISMATCH');
    ensure(
      !draft.includes('<Signature') &&
        one(draft, 'RNCEmisor') === expectedIssuer &&
        one(draft, 'RNCComprador') === scope.issuerRnc &&
        one(draft, 'eNCF') === entry.encf &&
        one(draft, 'Estado') === '1',
      'COMMERCIAL_APPROVAL_DRAFT_IDENTITY_INVALID',
    );
    await validator.validateUnsignedAuxiliary('ACECF', draft);
    const signed = await signer.sign(draft);
    await signer.verify(signed);
    ensure(unsignedXmlFromGeneratedSignature(signed) === draft,
      'COMMERCIAL_APPROVAL_SIGNED_SOURCE_MISMATCH');
    const signedSha256 = hash(signed);
    await writeFile(`${outputRoot}/acecf-signed/ACECF-${entry.encf}.xml`, signed, {
      mode: 0o600,
      flag: 'wx',
    });
    (report.approvals as unknown[]).push({ encf: entry.encf, signedSha256 });
  }
  await writeFile(
    `${outputRoot}/signing-report.json`,
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log('RIVNU_COMMERCIAL_APPROVAL_SET_SIGNED_AND_VERIFIED_COUNT=11');
  console.log('No DGII request, database operation or queue activation was performed.');
} catch (error) {
  const message = error instanceof Error && /^[A-Z][A-Z0-9_]{2,120}$/.test(error.message)
    ? error.message
    : 'COMMERCIAL_APPROVAL_SET_SIGNING_FAILED';
  console.error(message);
  process.exitCode = 1;
} finally {
  await signer?.close();
}

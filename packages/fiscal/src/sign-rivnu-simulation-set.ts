import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';

const inputRoot = '/input';
const outputRoot = '/output';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};
type Entry = {
  phase: 1 | 2 | 3;
  route: 'ECF' | 'RFCE';
  type: number;
  encf: string;
  sha256: string;
  bytes: number;
  dependsOn: string[];
};
type Manifest = {
  profile: string;
  scope: typeof scope;
  issuedOn: string;
  signatureAt: string;
  validUntil: string;
  sequenceStart: number;
  documents: Entry[];
  portalUploads: string[];
};

let fiscal: Awaited<ReturnType<typeof createPkcs12FiscalSigning>> | undefined;
let stage = 'INITIALIZATION';
let currentEncf = 'NONE';
try {
  stage = 'MANIFEST';
  const manifestText = await readFile(`${inputRoot}/manifest.json`, 'utf8');
  const manifest = JSON.parse(manifestText) as Manifest;
  ensure(
    manifest.profile === 'RIVNU_SIMULATION_20261019_ATTEMPT3_V1' &&
      JSON.stringify(manifest.scope) === JSON.stringify(scope) &&
      manifest.issuedOn === '2026-10-19' &&
      manifest.sequenceStart === 300001 &&
      manifest.documents.length === 25 &&
      manifest.portalUploads.length === 4 &&
      manifest.documents.filter((entry) => entry.route === 'ECF').length === 21 &&
      manifest.documents.filter((entry) => entry.route === 'RFCE').length === 4,
    'SIMULATION_MANIFEST_INVALID',
  );
  const expectedNames = manifest.documents.map((entry) => `${entry.encf}.xml`).sort();
  ensure(
    JSON.stringify((await readdir(`${inputRoot}/ecf-unsigned`)).sort()) === JSON.stringify(expectedNames),
    'SIMULATION_INPUT_FILES_INVALID',
  );

  stage = 'SIGNER_INITIALIZATION';
  fiscal = await createPkcs12FiscalSigning({
    scope,
    p12Path: '/run/secrets/signing/certificate.p12',
    passwordPath: '/run/secrets/signing/password',
    rootCertificatePath: '/run/trust/digifirma/root.crt',
    subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
    crlPath: '/run/trust/digifirma/subordinate.crl.pem',
    expectedCertificateSha256: 'a4348bad3005f70073f5d048d7789a9f9289addb3004ca84319feb1e5f41012d',
    workRoot: '/run/signing-work',
  });
  await mkdir(`${outputRoot}/ecf-signed`, { mode: 0o700 });
  await mkdir(`${outputRoot}/rfce-signed`, { mode: 0o700 });
  const report: Record<string, unknown> = {
    profile: manifest.profile,
    manifestSha256: hash(manifestText),
    scope,
    certificateSha256: fiscal.certificateSha256,
    createdAt: new Date().toISOString(),
    ecf: [],
    rfce: [],
    portalUploads: manifest.portalUploads,
  };
  for (const entry of manifest.documents) {
    currentEncf = entry.encf;
    stage = 'READ_UNSIGNED_ECF';
    const draft = await readFile(`${inputRoot}/ecf-unsigned/${entry.encf}.xml`, 'utf8');
    ensure(
      hash(draft) === entry.sha256 &&
        Buffer.byteLength(draft) === entry.bytes &&
        draft.includes('<FechaHoraFirma>') &&
        !draft.includes('<Signature'),
      'SIMULATION_DRAFT_INVALID',
    );
    stage = 'SIGN_ECF';
    const signedEcf = await fiscal.signing.signEcf(scope, draft);
    stage = 'VERIFY_ECF';
    const ecfEvidence = await fiscal.verify(scope, 'ECF', signedEcf);
    ensure(ecfEvidence.encf === entry.encf, 'SIMULATION_SIGNED_IDENTITY_INVALID');
    await writeFile(`${outputRoot}/ecf-signed/${entry.encf}.xml`, signedEcf, { mode: 0o600, flag: 'wx' });
    (report.ecf as unknown[]).push({
      phase: entry.phase,
      route: entry.route,
      type: entry.type,
      encf: entry.encf,
      dependsOn: entry.dependsOn,
      unsignedSha256: entry.sha256,
      signedSha256: ecfEvidence.sha256,
      securityCode: ecfEvidence.securityCode,
      total: ecfEvidence.total,
    });
    if (entry.route === 'RFCE') {
      stage = 'SIGN_RFCE';
      const signedRfce = await fiscal.signing.signConsumptionSummary(scope, draft, signedEcf);
      stage = 'VERIFY_RFCE';
      const rfceEvidence = await fiscal.verify(scope, 'RFCE', signedRfce);
      ensure(rfceEvidence.encf === entry.encf, 'SIMULATION_RFCE_IDENTITY_INVALID');
      await writeFile(`${outputRoot}/rfce-signed/RFCE-${entry.encf}.xml`, signedRfce, { mode: 0o600, flag: 'wx' });
      (report.rfce as unknown[]).push({
        phase: entry.phase,
        encf: entry.encf,
        signedSha256: rfceEvidence.sha256,
        securityCode: ecfEvidence.securityCode,
      });
    }
  }
  stage = 'WRITE_REPORT';
  ensure((report.rfce as unknown[]).length === 4, 'SIMULATION_RFCE_COUNT_INVALID');
  await writeFile(`${outputRoot}/signing-report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('RIVNU_SIMULATION_SET_SIGNED_AND_VERIFIED_ECF_25_RFCE_4');
  console.log('No DGII request, database operation or queue activation was performed.');
} catch (error) {
  const message = error instanceof Error && /^[A-Z][A-Z0-9_]{2,120}$/.test(error.message)
    ? error.message
    : 'SIMULATION_SET_SIGNING_FAILED';
  console.error(`SIMULATION_SET_SIGNING_FAILED stage=${stage} encf=${currentEncf} code=${message}`);
  process.exitCode = 1;
} finally {
  await fiscal?.close();
}

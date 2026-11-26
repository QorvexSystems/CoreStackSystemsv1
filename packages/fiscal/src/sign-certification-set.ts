import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createPkcs12FiscalSigning } from './pkcs12-fiscal-signing.ts';
import { securityCodeFromGeneratedSignature, unsignedXmlFromGeneratedSignature } from './pkcs12-signer.ts';

const inputRoot = '/input';
const outputRoot = '/output';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const expectedSource = '35a6a606c9d95d093c38b3562a1284d2738eb295dbc538440a1a1bb4c6552457';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};
function dominicanTimestamp() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Santo_Domingo', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

type Entry = { case: string; type: number; encf: string; sha256: string; bytes: number };
type RfceTemplate = { case: string; encf: string; normalizedSecurityCode: string; sha256: string };
type Manifest = {
  sourceSha256: string; issuerRnc: string; environment: string;
  ecf: Entry[]; rfceTemplates: RfceTemplate[];
};

let fiscal: Awaited<ReturnType<typeof createPkcs12FiscalSigning>> | undefined;
try {
  const manifest = JSON.parse(await readFile(`${inputRoot}/manifest.json`, 'utf8')) as Manifest;
  ensure(
    manifest.sourceSha256 === expectedSource && manifest.issuerRnc === scope.issuerRnc &&
    manifest.environment === scope.environment && manifest.ecf.length === 25 &&
    manifest.rfceTemplates.length === 4,
    'CERTIFICATION_MANIFEST_SCOPE_INVALID',
  );
  const names = (await readdir(`${inputRoot}/ecf-unsigned`)).sort();
  const expectedNames = manifest.ecf.map((entry) => `${entry.encf}.xml`).sort();
  ensure(JSON.stringify(names) === JSON.stringify(expectedNames), 'CERTIFICATION_INPUT_FILES_INVALID');
  const rfceTemplates = new Map(manifest.rfceTemplates.map((entry) => [entry.encf, entry]));
  ensure(rfceTemplates.size === 4, 'CERTIFICATION_RFCE_TEMPLATES_INVALID');

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
    sourceSha256: expectedSource,
    scope,
    certificateSha256: fiscal.certificateSha256,
    createdAt: new Date().toISOString(),
    ecf: [],
    rfce: [],
  };
  const summaries = new Map<string, { unsigned: string; signed: string }>();
  for (const entry of manifest.ecf) {
    ensure(entry.case === `${scope.issuerRnc}${entry.encf}`, 'CERTIFICATION_CASE_IDENTITY_INVALID');
    const draft = await readFile(`${inputRoot}/ecf-unsigned/${entry.encf}.xml`, 'utf8');
    ensure(hash(draft) === entry.sha256 && Buffer.byteLength(draft) === entry.bytes, 'CERTIFICATION_DRAFT_HASH_MISMATCH');
    ensure(!draft.includes('<FechaHoraFirma>') && !draft.includes('<Signature'), 'CERTIFICATION_DRAFT_ALREADY_FINALIZED');
    const closing = '</ECF>';
    ensure(draft.endsWith(closing), 'CERTIFICATION_DRAFT_ROOT_INVALID');
    const signatureTime = dominicanTimestamp();
    const unsigned = draft.slice(0, -closing.length) + `<FechaHoraFirma>${signatureTime}</FechaHoraFirma>` + closing;
    const signed = await fiscal.signing.signEcf(scope, unsigned);
    const evidence = await fiscal.verify(scope, 'ECF', signed);
    ensure(evidence.encf === entry.encf && evidence.actorRnc === scope.issuerRnc, 'CERTIFICATION_SIGNED_IDENTITY_INVALID');
    await writeFile(`${outputRoot}/ecf-signed/${entry.encf}.xml`, signed, { mode: 0o600, flag: 'wx' });
    (report.ecf as unknown[]).push({
      encf: entry.encf, type: entry.type, signatureTime,
      unsignedSha256: hash(unsigned), signedSha256: evidence.sha256,
      securityCode: evidence.securityCode, total: evidence.total,
    });
    if (rfceTemplates.has(entry.encf)) summaries.set(entry.encf, { unsigned, signed });
  }
  ensure(summaries.size === 4, 'CERTIFICATION_RFCE_SOURCE_MISSING');
  for (const [encf, source] of summaries) {
    const signed = await fiscal.signing.signConsumptionSummary(scope, source.unsigned, source.signed);
    const evidence = await fiscal.verify(scope, 'RFCE', signed);
    ensure(evidence.encf === encf && evidence.actorRnc === scope.issuerRnc, 'CERTIFICATION_RFCE_IDENTITY_INVALID');
    const unsigned = unsignedXmlFromGeneratedSignature(signed);
    const securityCode = securityCodeFromGeneratedSignature(source.signed);
    const normalized = unsigned.replace(
      `<CodigoSeguridadeCF>${securityCode}</CodigoSeguridadeCF>`,
      '<CodigoSeguridadeCF>ABC123</CodigoSeguridadeCF>',
    );
    ensure(hash(normalized) === rfceTemplates.get(encf)!.sha256, 'CERTIFICATION_RFCE_WORKBOOK_MISMATCH');
    await writeFile(`${outputRoot}/rfce-signed/RFCE-${encf}.xml`, signed, { mode: 0o600, flag: 'wx' });
    (report.rfce as unknown[]).push({ encf, signedSha256: evidence.sha256, securityCode });
  }
  await writeFile(`${outputRoot}/signing-report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('RIVNU_CERTIFICATION_SET_SIGNED_AND_VERIFIED_ECF_25_RFCE_4');
  console.log('No DGII request, database operation or queue activation was performed.');
} catch (error) {
  const message = error instanceof Error && /^[A-Z][A-Z0-9_]{2,120}$/.test(error.message)
    ? error.message : 'CERTIFICATION_SET_SIGNING_FAILED';
  console.error(message);
  process.exitCode = 1;
} finally {
  await fiscal?.close();
}

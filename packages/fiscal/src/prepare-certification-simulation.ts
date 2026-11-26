/** Offline conversion of reviewed client operations. No RIVNU identity, sample
 * customer, invented operations, signature, reservation or DGII HTTP request. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FiscalScope } from './catalog.ts';
import { type FiscalRequestV1 } from './contract.ts';
import { analyzeFiscalRequest, prepareMappedEcfDraft } from './mapper.ts';
import { parseEncf } from './encf.ts';
import { submissionRoute } from './draft.ts';
import { XmllintDraftValidator } from './xsd-validator.ts';
import {
  certificationHash,
  validateCertificationPlan,
  type CertificationPlan,
  type CertificationDocument,
} from './certification-automation.ts';

const [sourcePath, expectedSha256, output] = process.argv.slice(2);
if (!sourcePath || !output || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? ''))
  throw Error('USAGE_SOURCE_PATH_SHA256_OUTPUT_DIRECTORY');
const raw = await readFile(sourcePath, 'utf8');
if (Buffer.byteLength(raw) > 16 * 1024 * 1024 || certificationHash(raw) !== expectedSha256)
  throw Error('SIMULATION_SOURCE_HASH_MISMATCH');
const source = JSON.parse(raw) as {
  version: 1;
  caseId: string;
  scope: FiscalScope;
  certificateSha256: string;
  signatureAt: string;
  documents: Array<{ encf: string; validUntil: string | null; request: FiscalRequestV1 }>;
};
if (
  source.version !== 1 ||
  source.scope.environment !== 'certification' ||
  !/^[A-Za-z0-9_-]{1,100}$/.test(source.caseId) ||
  !/^[a-f0-9]{64}$/.test(source.certificateSha256) ||
  !Array.isArray(source.documents) ||
  source.documents.length < 1 ||
  source.documents.length > 1000
)
  throw Error('SIMULATION_SOURCE_INVALID');
const entries = new Map<string, { document: CertificationDocument; xml: string }>();
const validator = new XmllintDraftValidator();
for (const entry of source.documents) {
  const parsed = parseEncf(entry.encf);
  if (
    parsed.type !== entry.request.type ||
    BigInt(parsed.sequence) > 10_000_000n ||
    entries.has(entry.encf)
  )
    throw Error('SIMULATION_SEQUENCE_INVALID');
  const analysis = analyzeFiscalRequest(source.scope, entry.request);
  const draft = await prepareMappedEcfDraft(
    source.scope,
    entry.request,
    {
      scope: source.scope,
      operationId: entry.request.operationId,
      payloadSha256: analysis.payloadSha256,
      encf: entry.encf,
      businessDate: entry.request.issuedOn,
      validUntil: entry.validUntil,
    },
    source.signatureAt,
    validator,
  );
  const route = submissionRoute(parsed.type, entry.request.expectedTotals.total);
  // The simulation's RFCE is generated directly from its verified original E32.
  // No workbook template exists at this stage, so pin the generated unsigned
  // summary template with the same library rather than inventing security data.
  let rfceTemplateSha256: string | undefined;
  if (route === 'RFCE') {
    const { prepareRfce } = await import('./auxiliary.ts');
    const { parseSerializedXml } = await import('./xml.ts');
    const summary = await prepareRfce(source.scope, parseSerializedXml(draft.xml), {
      unsignedEcfSha256: certificationHash(draft.xml),
      securityCode: 'ABC123',
    });
    rfceTemplateSha256 = certificationHash(summary.xml);
  }
  entries.set(entry.encf, {
    xml: draft.xml,
    document: {
      id: entry.encf,
      encf: entry.encf,
      route,
      file: `${entry.encf}.xml`,
      sha256: certificationHash(draft.xml),
      ...(rfceTemplateSha256 ? { rfceTemplateSha256 } : {}),
      dependsOn: entry.request.reference ? [entry.request.reference.encf] : [],
    },
  });
}
const documents: CertificationDocument[] = [];
const pending = new Map(entries);
while (pending.size) {
  const next = [...pending].find(
    ([, value]) =>
      value.document.dependsOn.every((id) => entries.has(id) && !pending.has(id)) &&
      (value.document.route !== 'RFCE' ||
        [...pending.values()].every((item) => item.document.route === 'RFCE')),
  );
  if (!next) throw Error('SIMULATION_REFERENCE_MISSING_OR_CYCLIC');
  documents.push(next[1].document);
  pending.delete(next[0]);
}
const plan: CertificationPlan = {
  version: 1,
  caseId: source.caseId,
  scope: source.scope,
  stepNumber: 4,
  sourceSha256: expectedSha256,
  certificateSha256: source.certificateSha256,
  documents,
};
validateCertificationPlan(plan, { ...source, stepNumber: 4 });
await mkdir(output, { mode: 0o700 });
for (const [encf, entry] of entries)
  await writeFile(join(output, `${encf}.xml`), entry.xml, { mode: 0o600, flag: 'wx' });
const manifest = JSON.stringify(plan, null, 2) + '\n';
await writeFile(join(output, 'manifest.json'), manifest, { mode: 0o600, flag: 'wx' });
console.log('CERTIFICATION_SIMULATION_PREPARED_NOT_SIGNED_NOT_SENT');
console.log(`ManifestSHA256=${certificationHash(manifest)}`);

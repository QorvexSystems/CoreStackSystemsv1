import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createPkcs12XmlSigner, unsignedXmlFromGeneratedSignature } from './pkcs12-signer.ts';
import { createDgiiClient, createDgiiHttpsTransport } from './dgii-client.ts';
import { XmllintDraftValidator } from './xsd-validator.ts';

const signedRoot = '/signed';
const evidenceRoot = '/evidence';
const configPath = '/run/config/fiscal-signer.json';
const scope = Object.freeze({
  tenantId: 'cmt397emm0002nm0ogb50l2q6',
  issuerRnc: '40220429126',
  environment: 'certification' as const,
});
const expectedSourceSha256 = '63e6a64d5b014294651cce76dc5933b7b5838e20df55621a10f0e28dbe02bad1';
const expectedReportSha256 = '1e040117d49277459de2c411f64fcd8bccd3f4df9bb607a46679f5ad185cc5ec';
const expectedIssuer = '131880681';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ensure: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw Error(code);
};
const one = (xml: string, tag: string) => {
  const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
  ensure(matches.length === 1, 'COMMERCIAL_APPROVAL_IDENTITY_INVALID');
  return matches[0]![1]!;
};
type Approval = { encf: string; signedSha256: string };
type Report = {
  sourceSha256: string;
  scope: typeof scope;
  certificateSha256: string;
  approvals: Approval[];
};
type State = {
  encf: string;
  xmlSha256: string;
  status: 'SUBMISSION_INTENT' | 'ACCEPTED' | 'REJECTED';
  responseCode?: string;
  updatedAt: string;
};

const statePath = (encf: string) => `${evidenceRoot}/state/ACECF-${encf}.json`;
async function readState(encf: string): Promise<State | null> {
  try {
    const state = JSON.parse(await readFile(statePath(encf), 'utf8')) as State;
    ensure(
      state.encf === encf &&
        /^[a-f0-9]{64}$/.test(state.xmlSha256) &&
        ['SUBMISSION_INTENT', 'ACCEPTED', 'REJECTED'].includes(state.status) &&
        (state.responseCode === undefined || /^(?:01|02|1|2)$/.test(state.responseCode)) &&
        Number.isFinite(Date.parse(state.updatedAt)),
      'COMMERCIAL_APPROVAL_EVIDENCE_INVALID',
    );
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function saveState(state: State): Promise<void> {
  const body = JSON.stringify(state, null, 2) + '\n';
  const target = statePath(state.encf);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  const event = `${evidenceRoot}/events/${new Date().toISOString().replace(/[:.]/g, '-')}-ACECF-${state.encf}-${randomUUID()}.json`;
  await writeFile(event, body, { mode: 0o600, flag: 'wx' });
}
function responseCode(response: Record<string, unknown>): string {
  ensure(
    typeof response.codigo === 'string' && /^(?:01|02|1|2)$/.test(response.codigo) &&
      typeof response.estado === 'string' && response.estado.length > 0 && response.estado.length <= 500 &&
      Array.isArray(response.mensaje) && response.mensaje.length <= 100 &&
      response.mensaje.every((item) => item === null || (typeof item === 'string' && item.length <= 1000)),
    'COMMERCIAL_APPROVAL_RESPONSE_INVALID',
  );
  return response.codigo;
}
function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,120}$/.test(message)
    ? message
    : 'COMMERCIAL_APPROVAL_DELIVERY_FAILED';
}

let signer: Awaited<ReturnType<typeof createPkcs12XmlSigner>> | undefined;
let lockCreated = false;
let stage = 'INITIALIZATION';
try {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    scope: typeof scope;
    expectedCertificateSha256: string;
  };
  ensure(JSON.stringify(config.scope) === JSON.stringify(scope), 'COMMERCIAL_APPROVAL_SCOPE_INVALID');
  const reportText = await readFile(`${signedRoot}/signing-report.json`, 'utf8');
  ensure(digest(reportText) === expectedReportSha256, 'COMMERCIAL_APPROVAL_REPORT_HASH_MISMATCH');
  const report = JSON.parse(reportText) as Report;
  ensure(
    report.sourceSha256 === expectedSourceSha256 &&
      JSON.stringify(report.scope) === JSON.stringify(scope) &&
      report.certificateSha256 === config.expectedCertificateSha256 &&
      report.approvals.length === 11 &&
      new Set(report.approvals.map((item) => item.encf)).size === 11,
    'COMMERCIAL_APPROVAL_REPORT_INVALID',
  );
  await mkdir(`${evidenceRoot}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${evidenceRoot}/events`, { recursive: true, mode: 0o700 });
  await mkdir(`${evidenceRoot}/.run-lock`, { mode: 0o700 });
  lockCreated = true;
  const states = new Map<string, State | null>();
  for (const approval of report.approvals) {
    const state = await readState(approval.encf);
    ensure(!state || state.xmlSha256 === approval.signedSha256,
      'COMMERCIAL_APPROVAL_EVIDENCE_HASH_MISMATCH');
    states.set(approval.encf, state);
  }
  const blocked = [...states.values()].find(
    (state) => state && state.status !== 'ACCEPTED',
  );
  if (blocked) {
    console.error(`COMMERCIAL_APPROVAL_MANUAL_REVIEW_REQUIRED encf=${blocked.encf} state=${blocked.status}`);
    process.exitCode = 2;
  } else {
    const selected = report.approvals.find((approval) => !states.get(approval.encf));
    if (!selected) {
      console.log('RIVNU_COMMERCIAL_APPROVAL_SET_ACCEPTED_COUNT=11');
    } else {
      const xml = await readFile(`${signedRoot}/acecf-signed/ACECF-${selected.encf}.xml`, 'utf8');
      ensure(digest(xml) === selected.signedSha256, 'COMMERCIAL_APPROVAL_SIGNED_XML_HASH_MISMATCH');
      const signerConfig = {
        scope,
        p12Path: '/run/secrets/signing/certificate.p12',
        passwordPath: '/run/secrets/signing/password',
        rootCertificatePath: '/run/trust/digifirma/root.crt',
        subordinateCertificatePath: '/run/trust/digifirma/subordinate.crt',
        crlPath: '/run/trust/digifirma/subordinate.crl.pem',
        expectedCertificateSha256: config.expectedCertificateSha256,
        workRoot: '/run/signing-work',
      } as const;
      signer = await createPkcs12XmlSigner(signerConfig);
      stage = 'LOCAL_DOCUMENT_VERIFICATION';
      await signer.verify(xml);
      const unsigned = unsignedXmlFromGeneratedSignature(xml);
      await new XmllintDraftValidator().validateUnsignedAuxiliary('ACECF', unsigned);
      ensure(
        one(unsigned, 'RNCEmisor') === expectedIssuer &&
          one(unsigned, 'RNCComprador') === scope.issuerRnc &&
          one(unsigned, 'eNCF') === selected.encf &&
          one(unsigned, 'Estado') === '1',
        'COMMERCIAL_APPROVAL_SIGNED_IDENTITY_INVALID',
      );
      const client = createDgiiClient(
        scope,
        createDgiiHttpsTransport(scope, true),
        async (requested, kind, signedXml) => {
          ensure(JSON.stringify(requested) === JSON.stringify(scope), 'COMMERCIAL_APPROVAL_SCOPE_INVALID');
          ensure(kind === 'SEMILLA' || kind === 'ACECF', 'COMMERCIAL_APPROVAL_KIND_INVALID');
          await signer!.verify(signedXml);
          if (kind === 'ACECF') {
            const source = unsignedXmlFromGeneratedSignature(signedXml);
            ensure(one(source, 'RNCComprador') === scope.issuerRnc,
              'COMMERCIAL_APPROVAL_ACTOR_INVALID');
          }
          return { sha256: digest(signedXml), actorRnc: scope.issuerRnc };
        },
      );
      stage = 'AUTHENTICATION';
      const seed = await client.seed();
      await client.authenticate(await signer.sign(seed));
      await saveState({
        encf: selected.encf,
        xmlSha256: selected.signedSha256,
        status: 'SUBMISSION_INTENT',
        updatedAt: new Date().toISOString(),
      });
      stage = 'SUBMISSION';
      const response = await client.submit('ACECF', xml);
      const code = responseCode(response);
      const accepted = code === '1' || code === '01';
      await saveState({
        encf: selected.encf,
        xmlSha256: selected.signedSha256,
        status: accepted ? 'ACCEPTED' : 'REJECTED',
        responseCode: code,
        updatedAt: new Date().toISOString(),
      });
      console.log(
        `RIVNU_COMMERCIAL_APPROVAL_STEP_RECORDED encf=${selected.encf} state=${accepted ? 'ACCEPTED' : 'REJECTED'} code=${code}`,
      );
      if (!accepted) process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(`RIVNU_COMMERCIAL_APPROVAL_DELIVERY_STOPPED stage=${stage} code=${safeCode(error)}`);
  process.exitCode = 1;
} finally {
  await signer?.close();
  if (lockCreated) {
    try { await (await import('node:fs/promises')).rmdir(`${evidenceRoot}/.run-lock`); } catch {}
  }
}

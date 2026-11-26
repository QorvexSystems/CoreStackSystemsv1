import { createHash } from 'node:crypto';
import { assertScope, scopeKey, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import { prepareRfce } from './auxiliary.ts';
import type { DeliveryBundleVerifier } from './delivery-enqueue.ts';
import type { FiscalSigningService } from './delivery-preparation.ts';
import type { SignedXmlVerifier } from './dgii-client.ts';
import type { PrintedEvidenceVerifier } from './printed-representation.ts';
import {
  createPkcs12XmlSigner,
  securityCodeFromGeneratedSignature,
  unsignedXmlFromGeneratedSignature,
  type Pkcs12SignerConfig,
} from './pkcs12-signer.ts';
import { parseSerializedXml, textAt } from './xml.ts';
import { XmllintDraftValidator, type AuxiliaryKind } from './xsd-validator.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ensure = (value: unknown, code = 'INVALID_SIGNED_FISCAL_EVIDENCE') => {
  if (!value) throw Error(code);
};

export async function createPkcs12FiscalSigning(config: Pkcs12SignerConfig) {
  assertScope(config.scope);
  assertFiscalEnvironmentEnabled(config.scope, config.expectedCertificateSha256.toLowerCase());
  const scope = Object.freeze({ ...config.scope });
  const cryptographic = await createPkcs12XmlSigner(config);
  const validator = new XmllintDraftValidator();
  const sameScope = (requested: FiscalScope) => {
    assertScope(requested);
    ensure(scopeKey(requested) === scopeKey(scope), 'SIGNER_SCOPE_MISMATCH');
  };
  const one = (xml: string, tag: string) => {
    const matches = [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
    ensure(matches.length === 1);
    return matches[0]![1]!;
  };
  async function verifyGenerated(
    requested: FiscalScope,
    kind: Parameters<SignedXmlVerifier>[1],
    signedXml: string,
  ) {
    sameScope(requested);
    await cryptographic.verify(signedXml);
    const unsignedXml = unsignedXmlFromGeneratedSignature(signedXml);
    // SEMILLA is supplied by DGII, not serialized by our canonical XML
    // builder. Its declaration casing and insignificant formatting are valid
    // XML/XSD input but intentionally outside parseSerializedXml's narrow,
    // attribute-free internal profile. Keep the cryptographic and pinned-XSD
    // checks while avoiding an invalid internal-canonicalization requirement.
    if (kind === 'SEMILLA') {
      await validator.validateUnsignedAuxiliary('SEMILLA', unsignedXml);
      return {
        unsignedXml,
        root: undefined as never,
        evidence: { sha256: hash(signedXml), actorRnc: scope.issuerRnc },
      };
    }
    const root = parseSerializedXml(unsignedXml);
    let actorRnc = scope.issuerRnc;
    let encf: string | undefined;
    let total: string | undefined;
    if (kind === 'ECF') {
      ensure(root.name === 'ECF');
      encf = textAt(root, 'Encabezado', 'IdDoc', 'eNCF');
      const parsed = parseEncf(encf);
      await validator.validateUnsignedEcf(parsed.type, unsignedXml);
      actorRnc = textAt(root, 'Encabezado', 'Emisor', 'RNCEmisor');
      total = textAt(root, 'Encabezado', 'Totales', 'MontoTotal');
    } else {
      const expectedRoot: Record<Exclude<AuxiliaryKind, 'ARECF'>, string> = {
        RFCE: 'RFCE',
        ACECF: 'ACECF',
        ANECF: 'ANECF',
        SEMILLA: 'SemillaModel',
      };
      ensure(root.name === expectedRoot[kind]);
      await validator.validateUnsignedAuxiliary(kind, unsignedXml);
      if (kind === 'RFCE') {
        actorRnc = textAt(root, 'Encabezado', 'Emisor', 'RNCEmisor');
        encf = textAt(root, 'Encabezado', 'IdDoc', 'eNCF');
        total = textAt(root, 'Encabezado', 'Totales', 'MontoTotal');
      } else if (kind === 'ACECF') {
        actorRnc = one(unsignedXml, 'RNCComprador');
        encf = one(unsignedXml, 'eNCF');
        total = one(unsignedXml, 'MontoTotal');
      } else if (kind === 'ANECF') actorRnc = one(unsignedXml, 'RncEmisor');
    }
    ensure(actorRnc === scope.issuerRnc, 'SIGNED_ACTOR_SCOPE_MISMATCH');
    return {
      unsignedXml,
      root,
      evidence: {
        sha256: hash(signedXml),
        actorRnc,
        ...(encf ? { encf } : {}),
        ...(total ? { total } : {}),
        ...(['ECF', 'RFCE'].includes(kind)
          ? { securityCode: securityCodeFromGeneratedSignature(signedXml) }
          : {}),
      },
    };
  }

  const verify: SignedXmlVerifier = async (requested, kind, signedXml) =>
    (await verifyGenerated(requested, kind, signedXml)).evidence;

  const signing: FiscalSigningService = {
    async signEcf(requested, unsignedXml) {
      sameScope(requested);
      const root = parseSerializedXml(unsignedXml);
      ensure(root.name === 'ECF');
      const encf = textAt(root, 'Encabezado', 'IdDoc', 'eNCF');
      await validator.validateUnsignedEcf(parseEncf(encf).type, unsignedXml);
      ensure(textAt(root, 'Encabezado', 'Emisor', 'RNCEmisor') === scope.issuerRnc);
      return cryptographic.sign(unsignedXml);
    },
    async signConsumptionSummary(requested, unsignedEcfXml, signedEcfXml) {
      sameScope(requested);
      const checked = await verifyGenerated(scope, 'ECF', signedEcfXml);
      ensure(checked.unsignedXml === unsignedEcfXml, 'SIGNED_SOURCE_MISMATCH');
      ensure(parseEncf(checked.evidence.encf!).type === 32, 'RFCE_REQUIRES_E32');
      const summary = await prepareRfce(scope, checked.root, {
        unsignedEcfSha256: hash(unsignedEcfXml),
        securityCode: securityCodeFromGeneratedSignature(signedEcfXml),
      });
      return cryptographic.sign(summary.xml);
    },
  };

  const bundle: DeliveryBundleVerifier = async (requested, input) => {
    sameScope(requested);
    const ecf = await verifyGenerated(scope, 'ECF', input.signedEcfXml);
    ensure(ecf.unsignedXml === input.unsignedEcfXml, 'SIGNED_SOURCE_MISMATCH');
    let submission = ecf;
    if (input.route === 'ECF') ensure(input.submissionXml === input.signedEcfXml);
    else {
      submission = await verifyGenerated(scope, 'RFCE', input.submissionXml);
      const expected = await prepareRfce(scope, ecf.root, {
        unsignedEcfSha256: hash(input.unsignedEcfXml),
        securityCode: securityCodeFromGeneratedSignature(input.signedEcfXml),
      });
      ensure(submission.unsignedXml === expected.xml, 'RFCE_SOURCE_BINDING_MISMATCH');
    }
    return {
      ecf: ecf.evidence,
      submission: submission.evidence,
      certificateSha256: cryptographic.certificateSha256,
      sourceSha256: hash(input.unsignedEcfXml),
    };
  };

  const printVerify: PrintedEvidenceVerifier = async (requested, input) => {
    const checked = await verifyGenerated(requested, 'ECF', input.signedXml);
    ensure(checked.unsignedXml === input.unsignedXml, 'SIGNED_SOURCE_MISMATCH');
    return {
      sourceSha256: hash(input.unsignedXml),
      signedSha256: checked.evidence.sha256,
      issuerRnc: checked.evidence.actorRnc,
      encf: checked.evidence.encf!,
      securityCode: securityCodeFromGeneratedSignature(input.signedXml),
    };
  };

  return Object.freeze({
    signing,
    async signSeed(unsignedSeed: string) {
      await validator.validateUnsignedAuxiliary('SEMILLA', unsignedSeed);
      return cryptographic.sign(unsignedSeed);
    },
    verify,
    bundle,
    printVerify,
    certificateSha256: cryptographic.certificateSha256,
    close: () => cryptographic.close(),
  });
}

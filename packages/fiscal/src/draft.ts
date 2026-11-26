import { createHash } from 'node:crypto';
import { assertEcfType, assertScope } from './catalog.ts';
import type { EcfType, FiscalScope } from './catalog.ts';
import { assertBusinessDate, parseEncf } from './encf.ts';
import { element, serializeXml, textAt } from './xml.ts';
import type { XmlElement } from './xml.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

export interface DraftSchemaValidator {
  validateUnsignedEcf(type: EcfType, xml: string): Promise<void>;
}

export function decimalCents(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('Expected non-negative decimal amount, up to two decimal places.');
  }
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** Strict boundary at MontoTotal, not the B02 pre-ITBIS identification rule. */
export function submissionRoute(type: EcfType, montoTotal: string): 'ECF' | 'RFCE' {
  assertEcfType(type);
  const amount = decimalCents(montoTotal);
  return type === 32 && amount < 25_000_000n ? 'RFCE' : 'ECF';
}

/** Prepares an unsigned draft, NEVER an accepted, signed or sendable fiscal document. */
export async function prepareEcfDraft(
  scope: FiscalScope,
  type: EcfType,
  sections: readonly XmlElement[],
  validator: DraftSchemaValidator,
) {
  assertScope(scope);
  assertEcfType(type);
  assertFiscalEnvironmentEnabled(scope);
  // Snapshot before the asynchronous validation boundary; no caller mutation can change this XML.
  const root = element('ECF', sections);
  const xml = serializeXml(root);
  const encf = textAt(root, 'Encabezado', 'IdDoc', 'eNCF');
  if (
    parseEncf(encf).type !== type ||
    textAt(root, 'Encabezado', 'IdDoc', 'TipoeCF') !== String(type)
  ) {
    throw new Error('e-CF type and e-NCF do not match.');
  }
  if (textAt(root, 'Encabezado', 'Emisor', 'RNCEmisor') !== scope.issuerRnc) {
    throw new Error('XML issuer does not match the authenticated fiscal scope.');
  }
  const emission = textAt(root, 'Encabezado', 'Emisor', 'FechaEmision');
  if (!/^\d{2}-\d{2}-\d{4}$/.test(emission)) throw new Error('Invalid DGII emission date.');
  assertBusinessDate(emission.split('-').reverse().join('-'));
  const route = submissionRoute(type, textAt(root, 'Encabezado', 'Totales', 'MontoTotal'));
  const savedScope = Object.freeze({ ...scope });
  await validator.validateUnsignedEcf(type, xml);
  return Object.freeze({
    stage: 'SCHEMA_VALIDATED_UNSIGNED' as const,
    sendable: false as const,
    scope: savedScope,
    type,
    encf,
    filename: `${savedScope.issuerRnc}${encf}.xml`,
    xml,
    sha256: createHash('sha256').update(xml, 'utf8').digest('hex'),
    plannedSubmissionRoute: route,
    // XSD is NOT business-rule or signature validation, nor DGII acceptance.
    outstandingChecks: [
      'FISCAL_BUSINESS_RULES',
      'AUTHORIZED_SEQUENCE',
      'SIGNATURE',
      'DGII_VALIDATION',
    ] as const,
  });
}

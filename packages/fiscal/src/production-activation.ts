import { readFileSync } from 'node:fs';
import { scopeKey, type FiscalScope } from './catalog.ts';

const activationPath = '/run/config/fiscal-production-activation.json';
const fingerprintPattern = /^[a-f0-9]{64}$/;

type ProductionActivation = Readonly<{
  version: 1;
  mode: 'DGII_PRODUCTION_ISSUANCE';
  tenantId: string;
  issuerRnc: string;
  certificateSha256: string;
}>;

let cached: ProductionActivation | undefined;

function loadProductionActivation(): ProductionActivation {
  if (cached) return cached;
  let value: unknown;
  try {
    const file = readFileSync(activationPath, 'utf8');
    if (Buffer.byteLength(file, 'utf8') > 4096) throw new Error();
    value = JSON.parse(file);
  } catch {
    throw new Error('PRODUCTION_ACTIVATION_REQUIRED');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_PRODUCTION_ACTIVATION');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(',') !==
      ['certificateSha256', 'issuerRnc', 'mode', 'tenantId', 'version'].sort().join(',') ||
    candidate.version !== 1 ||
    candidate.mode !== 'DGII_PRODUCTION_ISSUANCE' ||
    typeof candidate.tenantId !== 'string' ||
    !/^[a-z0-9]{20,32}$/.test(candidate.tenantId) ||
    typeof candidate.issuerRnc !== 'string' ||
    !/^(?:[0-9]{9}|[0-9]{11})$/.test(candidate.issuerRnc) ||
    typeof candidate.certificateSha256 !== 'string' ||
    !fingerprintPattern.test(candidate.certificateSha256)
  ) {
    throw new Error('INVALID_PRODUCTION_ACTIVATION');
  }
  cached = Object.freeze(candidate as ProductionActivation);
  return cached;
}

/** Production remains fail-closed unless a reviewed, read-only manifest is
 * mounted at the fixed path. The manifest is bound to one tenant/RNC and the
 * signing certificate expected by that deployment. */
export function assertFiscalEnvironmentEnabled(
  scope: FiscalScope,
  expectedCertificateSha256?: string,
): void {
  if (scope.environment !== 'production') return;
  const activation = loadProductionActivation();
  if (
    scopeKey(scope) !==
      scopeKey({
        tenantId: activation.tenantId,
        issuerRnc: activation.issuerRnc,
        environment: 'production',
      }) ||
    (expectedCertificateSha256 !== undefined &&
      expectedCertificateSha256.toLowerCase() !== activation.certificateSha256)
  ) {
    throw new Error('PRODUCTION_ACTIVATION_SCOPE_MISMATCH');
  }
}

export function productionCertificateSha256(scope: FiscalScope): string {
  assertFiscalEnvironmentEnabled(scope);
  return loadProductionActivation().certificateSha256;
}

export const ECF_TYPES = [31, 32, 33, 34, 41, 43, 44, 45, 46, 47] as const;
export type EcfType = (typeof ECF_TYPES)[number];
export type FiscalEnvironment = 'precertification' | 'certification' | 'production';
export type FiscalScope = Readonly<{
  tenantId: string;
  issuerRnc: string;
  environment: FiscalEnvironment;
}>;

export const ECF_NAMES: Readonly<Record<EcfType, string>> = Object.freeze({
  31: 'Factura de Crédito Fiscal Electrónica',
  32: 'Factura de Consumo Electrónica',
  33: 'Nota de Débito Electrónica',
  34: 'Nota de Crédito Electrónica',
  41: 'Comprobante Electrónico de Compras',
  43: 'Comprobante Electrónico para Gastos Menores',
  44: 'Comprobante Electrónico para Regímenes Especiales',
  45: 'Comprobante Electrónico Gubernamental',
  46: 'Comprobante Electrónico para Exportaciones',
  47: 'Comprobante Electrónico para Pagos al Exterior',
});

export function assertEcfType(value: unknown): asserts value is EcfType {
  if (!ECF_TYPES.includes(value as EcfType)) throw new Error('Unsupported e-CF type.');
}

export function assertScope(scope: FiscalScope): void {
  if (!scope || typeof scope.tenantId !== 'string' || !scope.tenantId.trim()) {
    throw new Error('A tenant is required.');
  }
  // Structural check only: official registration and delegations are separate gates.
  if (typeof scope.issuerRnc !== 'string' || !/^(?:\d{9}|\d{11})$/.test(scope.issuerRnc))
    throw new Error('Invalid issuer RNC.');
  if (!['precertification', 'certification', 'production'].includes(scope.environment)) {
    throw new Error('Explicit fiscal environment required.');
  }
}

export function scopeKey(scope: FiscalScope): string {
  assertScope(scope);
  return JSON.stringify([scope.tenantId, scope.issuerRnc, scope.environment]);
}

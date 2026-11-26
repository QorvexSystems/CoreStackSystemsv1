import { createHash } from 'node:crypto';
import { assertScope, ECF_NAMES, type FiscalScope } from './catalog.ts';
import { parseEncf } from './encf.ts';
import { child, children, serializeXml, textAt, type XmlElement } from './xml.ts';
import { XmllintDraftValidator } from './xsd-validator.ts';
import { buildTimbrePayload } from './timbre.ts';
import { deepFreeze } from './contract.ts';
import { renderPrintedRepresentation } from './printed-html.ts';
import { assertFiscalEnvironmentEnabled } from './production-activation.ts';

/** Must verify signature/authorization AND bind the unsigned tree to the signed
 * document. Metadata supplied by the browser or a boolean 'signed' is not proof.
 */
export type PrintedEvidenceVerifier = (
  scope: FiscalScope,
  input: { unsignedXml: string; signedXml: string },
) => Promise<{
  sourceSha256: string;
  signedSha256: string;
  issuerRnc: string;
  encf: string;
  securityCode: string;
}>;
import type { PrintField, PrintedRepresentation } from './printed-types.ts';
export type { PrintField, PrintedRepresentation } from './printed-types.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ensure = (ok: unknown) => {
  if (!ok) throw Error('INVALID_PRINTED_EVIDENCE');
};
const labels: Record<string, string> = {
  IdDoc: 'Datos del comprobante',
  Emisor: 'Emisor',
  Comprador: 'Comprador',
  Totales: 'Totales DOP',
  OtraMoneda: 'Otra moneda',
  InformacionReferencia: 'Documento modificado / referencia',
  DescuentosORecargos: 'Descuentos y recargos',
  Subtotales: 'Subtotales',
  FechaVencimientoSecuencia: 'Vencimiento de secuencia',
  FechaLimitePago: 'Fecha límite de pago',
  RazonSocialEmisor: 'Razón social del emisor',
  RNCEmisor: 'RNC emisor',
  RazonSocialComprador: 'Razón social del comprador',
  RNCComprador: 'RNC comprador',
  DireccionEmisor: 'Dirección del emisor',
  DireccionComprador: 'Dirección del comprador',
  NumeroLinea: 'Línea',
  NombreItem: 'Descripción',
  CantidadItem: 'Cantidad',
  PrecioUnitarioItem: 'Precio unitario',
  MontoItem: 'Monto de línea según XML',
  DescuentoMonto: 'Descuento',
  RecargoMonto: 'Recargo',
  MontoGravadoTotal: 'Monto gravado',
  MontoExento: 'Monto exento',
  TotalITBIS: 'Total ITBIS',
  MontoTotal: 'Total',
  TotalITBISRetenido: 'ITBIS retenido',
  TotalISRRetencion: 'ISR retenido',
};
function fields(node: XmlElement, prefix = ''): PrintField[] {
  const name = labels[node.name] ?? node.name;
  const path = prefix ? `${prefix} / ${name}` : name;
  if (typeof node.value === 'string') return [{ label: path, value: node.value }];
  const counts = new Map<string, number>();
  for (const entry of children(node)) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return children(node).flatMap((entry) => {
    const index = (seen.get(entry.name) ?? 0) + 1;
    seen.set(entry.name, index);
    return fields(entry, counts.get(entry.name)! > 1 ? `${path} [${index}]` : path);
  });
}
/** Renders all scalar fiscal evidence, including nested retentions, currency,
 * references and adjustments; never recomputes monetary figures from catalogue.
 * No production activation or assumption of DGII acceptance.
 */
export async function preparePrintedRepresentation(
  scope: FiscalScope,
  unsignedTree: XmlElement,
  signedXml: string,
  verify: PrintedEvidenceVerifier,
): Promise<PrintedRepresentation> {
  assertScope(scope);
  assertFiscalEnvironmentEnabled(scope);
  const savedScope = Object.freeze({ ...scope });
  const unsignedXml = serializeXml(unsignedTree);
  const root = structuredClone(unsignedTree);
  ensure(
    root.name === 'ECF' &&
      typeof signedXml === 'string' &&
      Buffer.byteLength(signedXml) <= 2097152 &&
      !/<!/.test(signedXml),
  );
  const encf = textAt(root, 'Encabezado', 'IdDoc', 'eNCF');
  const { type } = parseEncf(encf);
  ensure(textAt(root, 'Encabezado', 'IdDoc', 'TipoeCF') === String(type));
  ensure(textAt(root, 'Encabezado', 'Emisor', 'RNCEmisor') === savedScope.issuerRnc);
  await new XmllintDraftValidator().validateUnsignedEcf(type, unsignedXml);
  const proof = await verify(savedScope, { unsignedXml, signedXml });
  ensure(
    proof.sourceSha256 === hash(unsignedXml) &&
      proof.signedSha256 === hash(signedXml) &&
      proof.encf === encf &&
      proof.issuerRnc === savedScope.issuerRnc,
  );
  const issuedOn = textAt(root, 'Encabezado', 'Emisor', 'FechaEmision')
    .split('-')
    .reverse()
    .join('-');
  const date = textAt(root, 'FechaHoraFirma');
  ensure(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(date));
  const signedAt = `${date.slice(0, 10).split('-').reverse().join('-')}T${date.slice(11)}-04:00`;
  const total = textAt(root, 'Encabezado', 'Totales', 'MontoTotal');
  const header = child(root, 'Encabezado');
  const buyer = children(header).find((n) => n.name === 'Comprador');
  const buyerRnc = buyer && children(buyer).find((n) => n.name === 'RNCComprador');
  const qr = buildTimbrePayload(savedScope, {
    issuerRnc: savedScope.issuerRnc,
    encf,
    issuedOn,
    total,
    signedAt,
    securityCode: proof.securityCode,
    ...(buyerRnc ? { buyerRnc: buyerRnc.value as string } : {}),
  });
  const sections = children(header).map((node) => ({
    title: labels[node.name] ?? node.name,
    fields: fields(node),
  }));
  for (const node of children(root))
    if (!['Encabezado', 'DetallesItems', 'FechaHoraFirma'].includes(node.name))
      sections.push({ title: labels[node.name] ?? node.name, fields: fields(node) });
  return deepFreeze({
    scope: savedScope,
    title: ECF_NAMES[type],
    encf,
    issuer: textAt(root, 'Encabezado', 'Emisor', 'RazonSocialEmisor'),
    issuerRnc: savedScope.issuerRnc,
    issuedOn,
    signedAt,
    total,
    securityCode: proof.securityCode,
    signedSha256: proof.signedSha256,
    sourceSha256: proof.sourceSha256,
    qrUrl: qr.url,
    qrVersion: qr.qrVersion,
    sections,
    lines: children(child(root, 'DetallesItems')).map((node) => fields(node)),
    notice:
      savedScope.environment === 'production'
        ? 'REPRESENTACIÓN IMPRESA DE COMPROBANTE FISCAL ELECTRÓNICO'
        : 'AMBIENTE DE PRUEBAS — SIN VALIDEZ FISCAL — NO ACREDITA ACEPTACIÓN DGII',
  });
}

export { renderPrintedRepresentation } from './printed-html.ts';

export async function preparePrintedHtml(
  scope: FiscalScope,
  root: XmlElement,
  signedXml: string,
  verify: PrintedEvidenceVerifier,
  encodeQr: (url: string) => string | Promise<string>,
) {
  const model = await preparePrintedRepresentation(scope, root, signedXml, verify);
  return renderPrintedRepresentation(model, await encodeQr(model.qrUrl));
}

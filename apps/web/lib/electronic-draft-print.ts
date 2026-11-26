// Browser-only projection of the persisted unsigned preview XML, not an invoice issuer.
export type DraftPrint = {
  encf: string;
  type: string;
  issuer: string;
  rnc: string;
  address: string;
  buyer: string;
  buyerRnc: string;
  issuedOn: string;
  plannedSignatureAt: string;
  lines: string[][];
  totals: { label: string; value: string }[];
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
export async function readElectronicDraft(
  xml: string,
  encf: string,
  sha256: string,
): Promise<DraftPrint> {
  if (new TextEncoder().encode(xml).length > 2097152 || /<!|<\w*:?(?:Signature)\b/i.test(xml))
    throw Error('XML de prueba no admitido.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(xml));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== sha256) throw Error('El XML no coincide con la evidencia persistida.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (
    root.tagName !== 'ECF' ||
    document.getElementsByTagName('parsererror').length ||
    root.namespaceURI
  )
    throw Error('XML e-CF inválido.');
  const elements = (parent: Element) =>
    Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1);
  const child = (parent: Element, name: string, optional = false) => {
    const matches = elements(parent).filter((node) => node.tagName === name);
    if (matches.length > 1 || (!optional && matches.length !== 1))
      throw Error('Estructura XML ambigua.');
    return matches[0];
  };
  const text = (parent: Element, name: string, optional = false) =>
    child(parent, name, optional)?.textContent ?? '';
  if (
    elements(root).some(
      (node) => !['Encabezado', 'DetallesItems', 'FechaHoraFirma'].includes(node.tagName),
    )
  )
    throw Error('Este perfil requiere una representación especializada.');
  const header = child(root, 'Encabezado')!;
  const id = child(header, 'IdDoc')!;
  const issuer = child(header, 'Emisor')!;
  const buyer = child(header, 'Comprador', true);
  const type = text(id, 'TipoeCF');
  if (
    !['31', '32'].includes(type) ||
    text(id, 'eNCF') !== encf ||
    !new RegExp(`^E${type}[0-9]{10}$`).test(encf)
  )
    throw Error('Comprobante no compatible con esta impresión de prueba.');
  const details = child(root, 'DetallesItems')!;
  const lines = elements(details).map((item) => {
    if (item.tagName !== 'Item') throw Error('Detalle XML no admitido.');
    return [
      'NumeroLinea',
      'NombreItem',
      'CantidadItem',
      'PrecioUnitarioItem',
      'DescuentoMonto',
      'MontoItem',
    ].map((name) => text(item, name, name === 'DescuentoMonto'));
  });
  if (!lines.length || lines.length > 1000) throw Error('Cantidad de líneas no admitida.');
  text(child(header, 'Totales')!, 'MontoTotal');
  const totals = elements(child(header, 'Totales')!).map((node) => {
    // Do not silently flatten/omit nested additional-tax or other advanced profiles.
    if (elements(node).length)
      throw Error('Los impuestos adicionales requieren una representación especializada.');
    return { label: node.tagName, value: node.textContent ?? '' };
  });
  return {
    encf,
    type,
    issuer: text(issuer, 'RazonSocialEmisor'),
    rnc: text(issuer, 'RNCEmisor'),
    address: text(issuer, 'DireccionEmisor'),
    issuedOn: text(issuer, 'FechaEmision'),
    buyer: buyer ? text(buyer, 'RazonSocialComprador', true) : '',
    buyerRnc: buyer ? text(buyer, 'RNCComprador', true) : '',
    plannedSignatureAt: text(root, 'FechaHoraFirma'),
    lines,
    totals,
  };
}
export function renderElectronicDraft(model: DraftPrint) {
  const totals = {
    MontoGravadoTotal: 'Monto gravado total',
    MontoGravadoI1: 'Base ITBIS 18%',
    MontoGravadoI2: 'Base ITBIS 16%',
    MontoGravadoI3: 'Base ITBIS 0%',
    MontoExento: 'Monto exento',
    ITBIS1: 'Tasa ITBIS 1',
    ITBIS2: 'Tasa ITBIS 2',
    ITBIS3: 'Tasa ITBIS 3',
    TotalITBIS: 'Total ITBIS',
    TotalITBIS1: 'ITBIS 18%',
    TotalITBIS2: 'ITBIS 16%',
    TotalITBIS3: 'ITBIS 0%',
    MontoTotal: 'TOTAL DOP',
  };
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Borrador ${escape(model.encf)}</title>
<style>@page{size:A4;margin:16mm}body{font:12px Arial,sans-serif;color:#111;max-width:180mm;margin:20px auto}h1{font-size:20px}header{border-bottom:2px solid #222;padding-bottom:12px}.notice{font-weight:bold;border:2px solid #222;padding:10px;margin:12px 0}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:7px;text-align:left;border-bottom:1px solid #bbb;overflow-wrap:anywhere}td:not(:nth-child(2)){font-variant-numeric:tabular-nums}thead{display:table-header-group}tr{break-inside:avoid}.totals{margin-left:auto;width:65%;break-inside:avoid}footer{margin-top:20px;font-size:11px} @media print{body{margin:0;max-width:none}}</style></head><body>
<header><h1>${escape(model.issuer)}</h1><p>RNC: ${escape(model.rnc)} · ${escape(model.address)}</p><h2>Borrador de factura ${model.type === '31' ? 'de crédito fiscal' : 'de consumo'} electrónica</h2><p>e-NCF sintético: ${escape(model.encf)} · Emisión: ${escape(model.issuedOn)}</p></header>
<div class="notice">PRUEBA SINTÉTICA — SIN FIRMA — SIN VALIDEZ FISCAL — NO ENVIADA A DGII</div>
<p>Comprador: ${escape(model.buyer || 'No indicado en el XML')}${model.buyerRnc ? ` · RNC: ${escape(model.buyerRnc)}` : ''}</p>
<table><thead><tr>${['Línea', 'Descripción', 'Cantidad', 'Precio unitario', 'Descuento', 'Monto según XML'].map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${model.lines.map((line) => `<tr>${line.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>
<table class="totals"><tbody>${model.totals.map((total) => `<tr><th>${escape(totals[total.label as keyof typeof totals] ?? total.label)}</th><td>${escape(total.value)}</td></tr>`).join('')}</tbody></table>
<footer><p>Sin QR fiscal ni código de seguridad: este XML aún no está firmado.</p><p>Fecha/hora de firma prevista en el borrador (no es una firma realizada): ${escape(model.plannedSignatureAt)}</p><p>Copia de la preparación persistida. No confirma cobro ni aceptación fiscal.</p></footer></body></html>`;
}
export async function printElectronicDraft(xml: string, encf: string, sha256: string) {
  const popup = window.open('', '_blank', 'width=900,height=900');
  if (!popup) throw Error('Permite ventanas emergentes para imprimir el borrador.');
  popup.opener = null;
  try {
    const model = await readElectronicDraft(xml, encf, sha256);
    popup.document.open();
    popup.document.write(renderElectronicDraft(model));
    popup.document.close();
    popup.focus();
    popup.print();
  } catch (error) {
    popup.close();
    throw error;
  }
}

import type { PrintedRepresentation, PrintField } from './printed-types.ts';
const ensure = (ok: unknown) => {
  if (!ok) throw Error('INVALID_PRINTED_EVIDENCE');
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
/** qrSvg must come from the trusted version-checked encoder, not user HTML.
 * Embedded as an image with restrictive CSP, never inserted as inline SVG DOM.
 */
export function renderPrintedRepresentation(model: PrintedRepresentation, qrSvg: string) {
  // This renderer is imported by the browser-only synthetic rehearsal. A legal
  // production RI must be produced by the isolated server renderer on VM4,
  // never by shipping activation-file access into the web bundle.
  ensure(model.scope.environment !== 'production');
  ensure(
    qrSvg.startsWith('<svg ') &&
      qrSvg.includes(`viewBox="0 0 ${model.qrVersion === 8 ? 57 : 61} ${model.qrVersion === 8 ? 57 : 61}"`) &&
      new TextEncoder().encode(qrSvg).length < 262144 &&
      !/<!|<script|<foreignObject|\bon\w+=|href=/i.test(qrSvg),
  );
  const rows = (items: readonly PrintField[]) =>
    items
      .map(
        (f) =>
          `<tr><th>${escape(f.label.split(' / ').slice(1).join(' / ') || f.label)}</th><td>${escape(f.value)}</td></tr>`,
      )
      .join('');
  const columns = [
    'Línea',
    'Descripción',
    'Cantidad',
    'Precio unitario',
    'Descuento',
    'Monto de línea según XML',
  ];
  const lineRows = model.lines
    .map((line) => {
      const primary = columns.map((label) => line.find((f) => f.label === `Item / ${label}`));
      const additional = line.filter((f) => !primary.includes(f));
      return (
        `<tr>${primary.map((f) => `<td>${escape(f?.value ?? '—')}</td>`).join('')}</tr>` +
        (additional.length
          ? `<tr><td colspan="6"><dl>${additional.map((f) => `<dt>${escape(f.label)}</dt><dd>${escape(f.value)}</dd>`).join('')}</dl></td></tr>`
          : '')
      );
    })
    .join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escape(model.encf)}</title><style>
@page{size:A4;margin:15mm}body{font:11px Arial,sans-serif;color:#111;max-width:180mm;margin:20px auto}h1{font-size:20px}h2{font-size:15px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{padding:5px;border-bottom:1px solid #ccc;text-align:left;overflow-wrap:anywhere}td{font-variant-numeric:tabular-nums}thead{display:table-header-group}tr{break-inside:avoid}dl{display:grid;grid-template-columns:1fr 1fr;margin:0;font-size:9px}dd{margin:0}.notice{border:2px solid;padding:10px;font-weight:bold}.fiscal-footer{break-inside:avoid;margin-top:20px}.qr{width:40mm;height:40mm}.hash{font-size:9px;overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}}</style></head><body>
<style>h2{font-size:14px;margin:10px 0 6px}.metadata{display:grid;grid-template-columns:1fr 1fr;gap:0 15px}.metadata section{break-inside:avoid}.metadata table{font-size:10px}.notice{padding:8px}.fiscal-footer{margin-top:16px}</style>
<header><h1>${escape(model.issuer)}</h1><p>RNC: ${escape(model.issuerRnc)}</p><h2>${escape(model.title)}</h2><p>e-NCF: ${escape(model.encf)} · Fecha de emisión: ${escape(model.issuedOn)}</p><p class="notice">${escape(model.notice)}</p></header>
<div class="metadata">${model.sections
    .filter((s) => !['Totales DOP', 'Otra moneda'].includes(s.title))
    .map((s) => `<section><h2>${escape(s.title)}</h2><table>${rows(s.fields)}</table></section>`)
    .join('')}</div>
<h2>Detalle de bienes y servicios</h2><table><thead><tr>${columns.map((label) => `<th>${escape(label)}</th>`).join('')}</tr></thead><tbody>${lineRows}</tbody></table>
${model.sections
  .filter((s) => ['Totales DOP', 'Otra moneda'].includes(s.title))
  .map((s) => `<section><h2>${escape(s.title)}</h2><table>${rows(s.fields)}</table></section>`)
  .join('')}
<footer class="fiscal-footer"><img class="qr" alt="QR de consulta del comprobante de prueba" src="data:image/svg+xml;base64,${btoa(qrSvg)}"><p>Código de seguridad: ${escape(model.securityCode)}</p><p>Fecha de firma digital: ${escape(model.signedAt)}</p><p>Este documento es una representación impresa de un Comprobante Fiscal Electrónico.</p><p class="notice">${escape(model.notice)}</p><p class="hash">SHA-256 del XML firmado: ${escape(model.signedSha256)}</p></footer></body></html>`;
}

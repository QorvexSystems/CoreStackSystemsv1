import type { PrintedRepresentation } from '../../../packages/fiscal/src/printed-types';
import { renderPrintedRepresentation } from '../../../packages/fiscal/src/printed-html';
import { renderSyntheticFiscalQr } from './synthetic-fiscal-qr';

/** Only server-verified evidence returned by the authenticated preview route. */
export function printSyntheticRehearsal(
  model: PrintedRepresentation,
  expected: { encf: string; sha256: string },
) {
  if (
    process.env.NEXT_PUBLIC_SYNTHETIC_ECF !== 'true' ||
    model.scope.tenantId !== 'cmt397emm0002nm0ogb50l2q6' ||
    model.scope.environment !== 'precertification' ||
    model.encf !== expected.encf ||
    model.sourceSha256 !== expected.sha256
  )
    throw Error('INVALID_PRINTED_EVIDENCE');
  // Check capacity before opening any printable window. No partial/alternate RI.
  const html = renderPrintedRepresentation(model, renderSyntheticFiscalQr(model.qrUrl));
  const popup = window.open('', '_blank', 'width=900,height=900');
  if (!popup) throw Error('Permite ventanas emergentes para imprimir.');
  popup.opener = null;
  popup.document.open();
  popup.document.write(html);
  popup.document.close();
  popup.focus();
  popup.print();
}

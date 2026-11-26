import JsBarcode from 'jsbarcode';
import { brand } from './brand';
import { formatCurrency } from './utils';

type BarcodeLabel = {
  barcode: string;
  barcodeType?: string | null;
  name?: string | null;
  sku?: string | null;
  price?: number | null;
};

export type LabelSize = 'SMALL' | 'MEDIUM' | 'LARGE';
export type LabelDimensions = { widthMm: number; heightMm: number };

export const DEFAULT_LABEL_DIMENSIONS: Record<LabelSize, LabelDimensions> = {
  SMALL: { widthMm: 30, heightMm: 20 },
  MEDIUM: { widthMm: 40, heightMm: 30 },
  LARGE: { widthMm: 50, heightMm: 40 },
};

const labelStyle: Record<LabelSize, {
  paddingMm: number;
  gapMm: number;
  namePt: number;
  pricePt: number;
  barcodeHeight: number;
  barcodeFontSize: number;
  barcodeModuleWidth: number;
}> = {
  SMALL: { paddingMm: 1, gapMm: 0.3, namePt: 7, pricePt: 8, barcodeHeight: 22, barcodeFontSize: 8, barcodeModuleWidth: 1.05 },
  MEDIUM: { paddingMm: 1.5, gapMm: 0.7, namePt: 8.5, pricePt: 10, barcodeHeight: 32, barcodeFontSize: 9, barcodeModuleWidth: 1.2 },
  LARGE: { paddingMm: 2, gapMm: 1, namePt: 10, pricePt: 12, barcodeHeight: 43, barcodeFontSize: 11, barcodeModuleWidth: 1.35 },
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };

    return entities[character];
  });
}

function resolveBarcodeFormat(type?: string | null) {
  switch (type) {
    case 'EAN13':
      return 'EAN13';
    case 'UPC_A':
    case 'UPC':
      return 'UPC';
    case 'CODE39':
      return 'CODE39';
    case 'EAN8':
      return 'EAN8';
    case 'ITF14':
      return 'ITF14';
    case 'QR':
      throw new Error('Las etiquetas QR requieren el módulo de códigos QR.');
    default:
      return 'CODE128';
  }
}

function createBarcodeSvg(value: string, size: LabelSize, type?: string | null) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  const style = labelStyle[size];

  JsBarcode(svg, value, {
    format: resolveBarcodeFormat(type),
    displayValue: true,
    font: 'Arial',
    fontSize: style.barcodeFontSize,
    lineColor: '#000000',
    background: '#ffffff',
    margin: 0,
    width: style.barcodeModuleWidth,
    height: style.barcodeHeight,
  });

  return svg.outerHTML;
}

/** Opens the print tab while the click is still active, avoiding popup blockers. */
export function openBarcodeLabelPrintWindow() {
  const printWindow = window.open('', '_blank', 'popup,width=420,height=300');
  if (!printWindow) return null;

  printWindow.document.write(
    '<!doctype html><html><body style="font-family:Arial,sans-serif;padding:24px">Preparando etiqueta...</body></html>',
  );
  printWindow.document.close();
  return printWindow;
}

/** Prints one label on media with the selected physical dimensions. */
export function printBarcodeLabel(
  printWindow: Window,
  label: BarcodeLabel,
  size: LabelSize,
  dimensions: LabelDimensions,
) {
  const barcode = label.barcode.trim();
  if (!barcode) throw new Error('La etiqueta no tiene un código de barras válido.');

  const { widthMm, heightMm } = dimensions;
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)
    || widthMm < 15 || widthMm > 120 || heightMm < 10 || heightMm > 100) {
    throw new Error('Indica medidas válidas para la etiqueta en milímetros.');
  }

  const barcodeSvg = createBarcodeSvg(barcode, size, label.barcodeType);
  const productName = label.name?.trim() || brand.name;
  const price = label.price == null ? null : formatCurrency(label.price);
  const style = labelStyle[size];

  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(productName)} · Etiqueta</title>
        <style>
          @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
          * { box-sizing: border-box; }
          html, body { width: ${widthMm}mm; height: ${heightMm}mm; margin: 0; overflow: hidden; background: #fff; color: #000; }
          body { font-family: Arial, Helvetica, sans-serif; }
          .label {
            display: flex;
            width: ${widthMm}mm;
            height: ${heightMm}mm;
            flex-direction: column;
            justify-content: center;
            gap: ${style.gapMm}mm;
            padding: ${style.paddingMm}mm;
            text-align: center;
          }
          .name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; font-size: ${style.namePt}pt; font-weight: 700; line-height: 1.08; }
          .price { white-space: nowrap; font-size: ${style.pricePt}pt; font-weight: 700; line-height: 1; }
          .barcode { display: flex; flex: 0 1 auto; justify-content: center; min-height: 0; max-width: 100%; overflow: hidden; }
          .barcode svg { display: block; width: auto; max-width: 100%; height: auto; max-height: ${size === 'SMALL' ? 8.5 : size === 'MEDIUM' ? 12 : 16}mm; }
          @media screen { body { min-width: ${widthMm}mm; min-height: ${heightMm}mm; } }
        </style>
      </head>
      <body>
        <main class="label">
          <div class="name">${escapeHtml(productName)}</div>
          <div class="barcode">${barcodeSvg}</div>
          ${price ? `<div class="price">${escapeHtml(price)}</div>` : ''}
        </main>
      </body>
    </html>`);
  printWindow.document.close();

  window.setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 150);
}

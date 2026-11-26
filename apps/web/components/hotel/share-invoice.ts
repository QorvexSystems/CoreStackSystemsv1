'use client';

import { whatsappUrl } from './whatsapp';

/**
 * Genera el PDF del ticket (80 mm, mismo formato que la impresión térmica) a partir de la factura que está en
 * pantalla. Usa una copia aislada con los estilos del ticket, igual que al imprimir.
 */
export async function buildInvoicePdf(fileName: string) {
  const source = document.querySelector<HTMLElement>('.hotel-payment-invoice');
  if (!source) throw new Error('No se encontró la factura en pantalla.');
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);

  const root = document.createElement('div');
  root.id = 'thermal-print-root';
  root.appendChild(source.cloneNode(true));
  document.body.appendChild(root);
  document.body.classList.add('hotel-invoice-printing');
  try {
    const ticket = root.firstElementChild as HTMLElement;
    const canvas = await html2canvas(ticket, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const widthMm = 72;
    const heightMm = (canvas.height / canvas.width) * widthMm;
    const pdf = new jsPDF({ unit: 'mm', format: [80, heightMm + 8], orientation: 'portrait', compress: true });
    // JPEG comprimido: el PDF queda liviano para enviarlo por WhatsApp.
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 4, 4, widthMm, heightMm, undefined, 'FAST');
    return new File([pdf.output('blob')], fileName, { type: 'application/pdf' });
  } finally {
    document.body.classList.remove('hotel-invoice-printing');
    root.remove();
  }
}

/**
 * Comparte la factura en PDF. Si el equipo permite compartir archivos (Android, iPhone, Windows con
 * WhatsApp instalado), abre el menú de compartir del sistema para elegir WhatsApp. Si no, descarga el PDF y
 * abre el chat de WhatsApp del huésped para adjuntarlo.
 */
export async function shareInvoiceByWhatsApp({
  receiptNumber,
  guestName,
  phone,
}: {
  receiptNumber: string;
  guestName: string;
  phone?: string | null;
}): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = await buildInvoicePdf(`Factura-${receiptNumber}.pdf`);
  const text = `Hola ${guestName}, le compartimos su factura ${receiptNumber} de Hotel Suite Ancla. ¡Gracias por su preferencia!`;
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: `Factura ${receiptNumber}`, text });
      return 'shared';
    } catch (error) {
      if ((error as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const chat = whatsappUrl(phone, `${text} (Le adjuntamos el PDF.)`) ?? `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(chat, '_blank', 'noopener,noreferrer');
  return 'downloaded';
}

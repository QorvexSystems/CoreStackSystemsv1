'use client';
import { DocumentPdfDownloadButton } from './document-pdf-download-button';

import { ReceptionWhatsappButton } from './reception-whatsapp-button';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { getWorkshopTickets } from '@/lib/api';
import { SessionRequired, useCurrentSession } from './session-required';
import { WorkshopReceptionDocument } from './workshop-reception-document';

export function WorkshopReceptionPrint({
  ticketId,
  autoPrint = false,
}: {
  ticketId: string;
  autoPrint?: boolean;
}) {
  const printedRef = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const session = useCurrentSession();
  const query = useQuery({
    queryKey: ['workshop-tickets', session?.tenantId],
    queryFn: () => getWorkshopTickets(session!.tenantId, session!.accessToken),
    enabled: Boolean(session),
  });
  const ticket = query.data?.find((item) => item.id === ticketId);
  const fitPage = () => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.zoom = '1';
    // A4 minus 10 mm margins; reserve 2 mm for browser rounding.
    const availableHeight = (275 * 96) / 25.4;
    sheet.style.zoom = String(
      Math.min(
        1,
        availableHeight / Math.max(sheet.scrollHeight, sheet.getBoundingClientRect().height),
      ),
    );
  };
  useEffect(() => {
    window.addEventListener('beforeprint', fitPage);
    return () => window.removeEventListener('beforeprint', fitPage);
  }, [ticket, mounted]);
  const print = () => {
    fitPage();
    window.focus();
    window.print();
  };
  useEffect(() => {
    if (!autoPrint || !ticket?.reception || !mounted || printedRef.current) return;
    printedRef.current = true;
    void (async () => {
      await Promise.race([
        Promise.all([document.fonts.ready, ...Array.from(document.querySelectorAll<HTMLImageElement>('.reception-document img')).map(img => img.decode().catch(() => undefined))]),
        new Promise(resolve => window.setTimeout(resolve, 2000)),
      ]);
      print();
    })();
  }, [autoPrint, ticket, mounted]);
  if (!session) return <SessionRequired session={session} />;
  if (query.isLoading) return <p className="p-6">Preparando recepción…</p>;
  if (query.isError)
    return (
      <div className="p-6">
        <p>No se pudo cargar la recepción.</p>
        <Button onClick={() => query.refetch()}>Reintentar</Button>
      </div>
    );
  if (!ticket) return <p className="p-6">Recepción no encontrada.</p>;
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6 print:p-0">
      <style>{`
      @page { size: A4; margin: 10mm; }
      #reception-print-sheet { position: fixed; left: -10000px; top: 0; width: 190mm; visibility: hidden; background: white; }
      #reception-print-sheet .reception-document { padding: 0; border: 0; border-radius: 0; min-height: 270mm; }
      #reception-print-sheet header { padding-bottom: 10px; }
      #reception-print-sheet header img { width: 52px; height: 52px; }
      #reception-print-sheet .reception-fields { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 9px 18px; margin: 14px 0; }
      #reception-print-sheet .reception-fields dd { font-size: 11px; line-height: 1.35; margin-top: 2px; }
      #reception-print-sheet .reception-notes { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px 18px; padding-top: 12px; }
      #reception-print-sheet .reception-notes > * { margin: 0; min-width: 0; }
      #reception-print-sheet .reception-notes > :first-child,
      #reception-print-sheet .reception-notes > :last-child { grid-column: 1 / -1; }
      #reception-print-sheet .reception-notes p { font-size: 11px; line-height: 1.4; margin-top: 2px; overflow-wrap: anywhere; }
      #reception-print-sheet .reception-photos { margin-top: 14px; padding-top: 10px; }
      #reception-print-sheet .reception-photos h3 { margin-bottom: 7px; }
      #reception-print-sheet .reception-photos img { height: 90px; }
      #reception-print-sheet .reception-clauses { margin-top: 10px; padding: 9px 12px; }
      #reception-print-sheet .reception-clauses ol { font-size: 9px; line-height: 1.4; margin-top: 5px; }
      #reception-print-sheet .reception-clauses li { margin-top: 4px; }
      #reception-print-sheet .reception-signature { margin-top: 14px; padding-top: 10px; }
      #reception-print-sheet .reception-signature > div { margin-top: 5px; }
      #reception-print-sheet .reception-signature img,
      #reception-print-sheet .reception-signature .h-24 { height: 58px; }
      #reception-print-sheet footer { margin-top: 12px; padding-top: 7px; }
      @media print {
        body > :not(#reception-print-sheet) { display: none !important; }
        html, body { margin: 0 !important; padding: 0 !important; min-height: 0 !important; height: auto !important; background: white !important; }
        #reception-print-sheet { position: static; visibility: visible; display: block; margin: 0; padding: 0; }
      }
    `}</style>
      {mounted
        ? createPortal(
            <div id="reception-print-sheet" ref={sheetRef}>
              <WorkshopReceptionDocument ticket={ticket} />
            </div>,
            document.body,
          )
        : null}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h1 className="text-xl font-semibold">Formulario de recepción</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/workshop?ticket=${ticketId}`}>Volver a OT</Link>
          </Button>
          <Button disabled={!ticket.reception} onClick={print}>
            Imprimir / Guardar PDF
          </Button>
          {ticket.reception ? <DocumentPdfDownloadButton kind="reception" id={ticket.id} number={ticket.ticketNumber} /> : null}
          <ReceptionWhatsappButton ticket={ticket} />
        </div>
      </div>
      <WorkshopReceptionDocument ticket={ticket} />
    </div>
  );
}

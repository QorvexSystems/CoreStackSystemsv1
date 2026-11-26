'use client';
import type { WorkshopTicket } from '@/lib/api';
import { DocumentWhatsappButton } from './document-whatsapp-button';
export function ReceptionWhatsappButton({ ticket }: { ticket: WorkshopTicket }) {
  return (
    <DocumentWhatsappButton
      kind="reception"
      documentId={ticket.id}
      documentNumber={ticket.ticketNumber}
      customer={ticket.customer}
    />
  );
}

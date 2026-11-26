import { InvoiceDetail } from '@/components/operations/invoice-detail';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetail invoiceId={id} />;
}

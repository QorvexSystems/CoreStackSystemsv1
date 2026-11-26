import { InvoiceDetail } from '@/components/operations/invoice-detail';

export default async function InvoicePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoPrint?: string }>;
}) {
  const { id } = await params;
  const { autoPrint } = await searchParams;

  return <InvoiceDetail invoiceId={id} printMode autoPrint={autoPrint === '1'} />;
}

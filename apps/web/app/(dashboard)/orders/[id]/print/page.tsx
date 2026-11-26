import { QuotationPrint } from '@/components/operations/quotation-print';

export default async function QuotationPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoPrint?: string }>;
}) {
  const { id } = await params;
  const { autoPrint } = await searchParams;

  return <QuotationPrint orderId={id} autoPrint={autoPrint === '1'} />;
}

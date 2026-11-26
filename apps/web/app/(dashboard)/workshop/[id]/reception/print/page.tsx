import { WorkshopReceptionPrint } from '@/components/operations/workshop-reception-print';
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ autoPrint?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <WorkshopReceptionPrint ticketId={id} autoPrint={query.autoPrint === '1'} />;
}

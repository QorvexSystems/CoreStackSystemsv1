import { EditReservationPage } from '@/components/hotel/reservation-form-page';

export default async function EditReservationRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditReservationPage reservationId={id} />;
}

import { Suspense } from 'react';
import { HotelPaymentPage } from '@/components/hotel/payment-page';

export default async function ReservationPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <HotelPaymentPage reservationId={id} />
    </Suspense>
  );
}

import { Suspense } from 'react';
import { NewReservationPage } from '@/components/hotel/reservation-form-page';

export default function NewReservationRoute() {
  return (
    <Suspense fallback={null}>
      <NewReservationPage />
    </Suspense>
  );
}

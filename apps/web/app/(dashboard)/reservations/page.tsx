import { Suspense } from 'react';
import { ReservationsView } from '@/components/hotel/reservations-view';

export default function ReservationsPage() {
  return <Suspense fallback={<div className="rounded-xl border bg-white p-8 text-sm text-slate-500">Cargando reservaciones...</div>}><ReservationsView /></Suspense>;
}

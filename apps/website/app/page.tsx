import { BookingExperience } from '@/components/booking/booking-experience';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { Hero } from '@/components/hero';
import { GallerySection, LocationSection } from '@/components/sections';
import { ErpError, erpRequest } from '@/lib/erp';
import type { HotelCatalog } from '@/lib/types';

// Cada visita consulta el ERP: tarifas, tipos y estado de reservas siempre al día.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let catalog: HotelCatalog | null = null;
  let unavailableReason: string | null = null;
  try {
    catalog = (await erpRequest<HotelCatalog>('GET', '/channel/hotel/catalog')).data;
    if (!catalog.bookingEnabled)
      unavailableReason = 'Las reservas en línea están pausadas temporalmente.';
  } catch (error) {
    unavailableReason =
      error instanceof ErpError ? error.message : 'El sistema de reservas no está disponible.';
  }
  const hotel = catalog?.hotel ?? { name: 'Hotel Suite Ancla', email: null, phone: null, address: null };

  return (
    <>
      <SiteHeader phone={hotel.phone} />
      <main>
        <Hero />
        <BookingExperience catalog={catalog} unavailableReason={unavailableReason} />
        <GallerySection />
        <LocationSection hotel={hotel} />
      </main>
      <SiteFooter hotel={hotel} />
    </>
  );
}

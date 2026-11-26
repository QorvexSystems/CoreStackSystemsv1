import Image from 'next/image';
import { Clock, Mail, MapPin, Navigation, Phone } from 'lucide-react';
import { fallbackAddress, gallery, mapsEmbedUrl, mapsLink } from '@/lib/content';
import type { HotelCatalog } from '@/lib/types';

export function GallerySection() {
  return (
    <section id="galeria" className="border-t border-line/70 bg-sand-deep/50 py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2 className="font-serif text-3xl font-semibold">Galería</h2>
        <p className="mt-2 text-muted">Un vistazo a los espacios que te esperan.</p>
        <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 md:grid-rows-2">
          {gallery.map((item, index) => (
            <figure
              key={item.src}
              className={`relative overflow-hidden rounded-xl ${
                index === 0 ? 'col-span-2 row-span-2 aspect-square md:aspect-auto' : 'aspect-[4/3]'
              }`}
            >
              <Image
                src={item.src}
                alt={item.alt}
                fill
                sizes={index === 0 ? '(min-width: 768px) 50vw, 100vw' : '(min-width: 768px) 25vw, 50vw'}
                className="object-cover transition duration-500 hover:scale-[1.03]"
              />
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

export function LocationSection({ hotel }: { hotel: HotelCatalog['hotel'] }) {
  const address = hotel.address || fallbackAddress;
  return (
    <section id="ubicacion" className="py-16">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <h2 className="font-serif text-3xl font-semibold">Ubicación</h2>
          <p className="mt-2 text-muted">En Barahona, cerca de todo lo que quieres conocer.</p>
          <ul id="contacto" className="mt-8 space-y-5 text-sm">
            <li className="flex gap-3">
              <MapPin className="h-5 w-5 shrink-0 text-sea" aria-hidden />
              <span>{address}</span>
            </li>
            {hotel.phone && (
              <li className="flex gap-3">
                <Phone className="h-5 w-5 shrink-0 text-sea" aria-hidden />
                <a href={`tel:${hotel.phone.replace(/[^\d+]/g, '')}`} className="hover:text-sea-dark">
                  {hotel.phone}
                </a>
              </li>
            )}
            {hotel.email && (
              <li className="flex gap-3">
                <Mail className="h-5 w-5 shrink-0 text-sea" aria-hidden />
                <a href={`mailto:${hotel.email}`} className="hover:text-sea-dark">
                  {hotel.email}
                </a>
              </li>
            )}
            <li className="flex gap-3">
              <Clock className="h-5 w-5 shrink-0 text-sea" aria-hidden />
              <span>Check-in desde las 3:00 p. m. · Check-out hasta las 11:00 a. m.</span>
            </li>
          </ul>
          <a href={mapsLink} target="_blank" rel="noopener noreferrer" className="btn-outline mt-6">
            <Navigation className="h-4 w-4" aria-hidden /> Cómo llegar
          </a>
        </div>
        <div className="card overflow-hidden">
          <iframe
            title={`Mapa: ${address}`}
            src={mapsEmbedUrl}
            className="h-[340px] w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      </div>
    </section>
  );
}

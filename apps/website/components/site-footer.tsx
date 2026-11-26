import Image from 'next/image';
import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { fallbackAddress, whatsappLink } from '@/lib/content';
import type { HotelCatalog } from '@/lib/types';

export function SiteFooter({ hotel }: { hotel: HotelCatalog['hotel'] }) {
  const whatsapp = whatsappLink(hotel.phone);
  return (
    <footer className="border-t border-line bg-white/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 text-xs text-muted sm:px-6 lg:flex-row lg:items-center">
        <Image
          src="/brand/hotel-ancla-logo.png"
          alt="Hotel Suite Ancla"
          width={100}
          height={40}
          className="h-10 w-auto object-contain"
        />
        <div className="flex flex-1 flex-wrap gap-x-10 gap-y-3 lg:border-l lg:border-line lg:pl-8">
          <span className="flex items-center gap-2">
            <MapPin className="h-4 w-4" aria-hidden />
            {hotel.address || fallbackAddress}
          </span>
          {hotel.phone && (
            <span className="flex items-center gap-2">
              <Phone className="h-4 w-4" aria-hidden />
              {hotel.phone}
            </span>
          )}
          {hotel.email && (
            <a href={`mailto:${hotel.email}`} className="flex items-center gap-2 hover:text-sea-dark">
              <Mail className="h-4 w-4" aria-hidden />
              {hotel.email}
            </a>
          )}
          {whatsapp && (
            <a
              href={whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 hover:text-sea-dark"
            >
              <MessageCircle className="h-4 w-4" aria-hidden />
              WhatsApp
            </a>
          )}
        </div>
        <p className="max-w-[12rem] leading-snug">
          Una experiencia de descanso, siempre cerca de ti.
          <span className="mt-1.5 block h-0.5 w-6 bg-sea" />
        </p>
      </div>
    </footer>
  );
}

import Image from 'next/image';
import { CalendarCheck, MessageCircle } from 'lucide-react';
import { whatsappLink } from '@/lib/content';

const nav = [
  { href: '#reservar', label: 'Reserva tu estadía' },
  { href: '#habitaciones', label: 'Habitaciones' },
  { href: '#galeria', label: 'Galería' },
  { href: '#ubicacion', label: 'Ubicación' },
  { href: '#contacto', label: 'Contacto' },
];

export function SiteHeader({ phone }: { phone: string | null }) {
  const whatsapp = whatsappLink(phone);
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-sand/90 backdrop-blur">
      <div className="mx-auto flex h-[72px] max-w-7xl items-center gap-6 px-4 sm:px-6">
        <a href="#" className="shrink-0" aria-label="Hotel Suite Ancla, inicio">
          <Image
            src="/brand/hotel-ancla-logo.png"
            alt="Hotel Suite Ancla"
            width={160}
            height={64}
            priority
            className="h-14 w-auto object-contain"
          />
        </a>
        <nav className="hidden flex-1 items-center gap-7 lg:flex" aria-label="Principal">
          {nav.map((item, index) => (
            <a
              key={item.href}
              href={item.href}
              className={
                index === 0
                  ? 'border-b-2 border-sea py-1 text-sm font-bold text-sea-dark'
                  : 'py-1 text-sm text-ink/80 transition hover:text-sea-dark'
              }
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          {whatsapp && (
            <a
              href={whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden items-center gap-2.5 md:flex"
            >
              <MessageCircle className="h-7 w-7 text-sea" aria-hidden />
              <span className="leading-tight">
                <span className="block text-sm font-semibold">¿Tienes dudas?</span>
                <span className="block text-xs text-muted">Escríbenos por WhatsApp</span>
              </span>
            </a>
          )}
          <a
            href="#reservar"
            className="flex items-center gap-2.5 rounded-xl bg-sea-light px-4 py-2 text-sea-dark ring-1 ring-sea/15 transition hover:bg-sea hover:text-white"
          >
            <CalendarCheck className="h-5 w-5" aria-hidden />
            <span className="leading-tight">
              <span className="block text-sm font-bold">Sin registro</span>
              <span className="hidden text-[11px] sm:block">Reserva de forma rápida</span>
            </span>
          </a>
        </div>
      </div>
    </header>
  );
}

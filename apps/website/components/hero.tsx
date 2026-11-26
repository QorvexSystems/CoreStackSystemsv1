import Image from 'next/image';
import { BedDouble, MapPin, Wifi } from 'lucide-react';
import { heroImage } from '@/lib/content';

const features = [
  { icon: MapPin, label: 'Excelente ubicación' },
  { icon: BedDouble, label: 'Habitaciones modernas' },
  { icon: Wifi, label: 'WiFi gratuito' },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-line/70">
      <div className="absolute inset-y-0 right-0 hidden w-[64%] md:block">
        <Image
          src={heroImage}
          alt="Habitación luminosa con cama king y vista a la ciudad"
          fill
          priority
          sizes="64vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-sand via-sand/40 to-transparent" />
      </div>
      <div className="relative mx-auto grid max-w-7xl items-center px-4 pb-20 pt-12 sm:px-6 md:min-h-[420px] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:pb-24 md:pt-14">
        <div className="max-w-xl">
          <h1 className="font-serif text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
            Tu lugar en el corazón de la ciudad
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Comodidad, descanso y una excelente ubicación. Reserva tu estadía en Hotel Suite Ancla
            de forma rápida y sin registro.
          </p>
          <ul className="mt-7 flex flex-wrap gap-x-8 gap-y-4">
            {features.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-sm text-muted">
                <Icon className="h-6 w-6 shrink-0 text-sea" aria-hidden />
                <span className="max-w-[6.5rem] leading-snug">{label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="relative mt-8 aspect-[16/10] overflow-hidden rounded-2xl md:hidden">
          <Image src={heroImage} alt="" fill sizes="100vw" className="object-cover" />
        </div>
        <div className="hidden justify-end md:flex">
          <p className="mr-2 bg-sand/85 px-7 py-6 font-serif text-2xl leading-snug text-ink shadow-card backdrop-blur-sm">
            Descansa.
            <br />
            Explora.
            <br />
            Vuelve.
            <span className="mt-3 block h-0.5 w-8 bg-sea" />
          </p>
        </div>
      </div>
    </section>
  );
}

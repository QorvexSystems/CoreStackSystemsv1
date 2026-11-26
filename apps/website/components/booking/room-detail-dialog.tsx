'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Users, X } from 'lucide-react';
import clsx from 'clsx';
import type { RoomContent } from '@/lib/content';
import { formatShort, moneyShort } from '@/lib/dates';
import type { RoomType, StayAvailability } from '@/lib/types';
import { amenityIcon } from './amenities';

type Props = {
  room: RoomType;
  content: RoomContent;
  stay: StayAvailability['roomTypes'][number] | undefined;
  selected: boolean;
  canSelect: boolean;
  onSelect: () => void;
  onClose: () => void;
};

/** Detalle de un tipo de habitación con su galería de fotos. */
export function RoomDetailDialog({ room, content, stay, selected, canSelect, onSelect, onClose }: Props) {
  const photos = content.photos;
  const [index, setIndex] = useState(0);
  const touchStart = useRef<number | null>(null);
  const go = useCallback(
    (step: number) => setIndex((current) => (current + step + photos.length) % photos.length),
    [photos.length],
  );

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [go, onClose]);

  const capacity = `${room.capacityAdults} adultos${room.capacityChildren ? ` y ${room.capacityChildren} ${room.capacityChildren === 1 ? 'niño' : 'niños'}` : ''}`;
  const availability = (() => {
    if (!stay) return null;
    if (!stay.fitsGuests) return { ok: false, text: `Admite hasta ${capacity}.` };
    if (stay.available === 0)
      return {
        ok: false,
        text: stay.soldOutDates.length
          ? `Sin disponibilidad la noche del ${stay.soldOutDates.slice(0, 2).map(formatShort).join(' y ')}.`
          : 'No disponible para tus fechas.',
      };
    return { ok: true, text: stay.available <= 3 ? `Disponible · quedan ${stay.available}` : 'Disponible para tus fechas' };
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-detail-title"
        className="flex max-h-[100dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[94vh] sm:rounded-2xl"
      >
        <div className="overflow-y-auto">
          {/* Galería */}
          <div
            className="relative aspect-[16/10] w-full bg-ink sm:aspect-[16/8]"
            onTouchStart={(event) => (touchStart.current = event.touches[0].clientX)}
            onTouchEnd={(event) => {
              if (touchStart.current === null) return;
              const delta = event.changedTouches[0].clientX - touchStart.current;
              if (Math.abs(delta) > 40) go(delta < 0 ? 1 : -1);
              touchStart.current = null;
            }}
          >
            {photos.map((photo, photoIndex) => (
              <Image
                key={photo.src}
                src={photo.src}
                alt={photo.alt}
                fill
                sizes="(min-width: 896px) 896px, 100vw"
                priority={photoIndex === 0}
                className={clsx('object-cover transition-opacity duration-300', photoIndex === index ? 'opacity-100' : 'opacity-0')}
              />
            ))}
            <button
              type="button"
              onClick={onClose}
              className="absolute right-3 top-3 rounded-full bg-white/90 p-2 text-ink shadow hover:bg-white"
              aria-label="Cerrar"
            >
              <X className="h-5 w-5" />
            </button>
            {photos.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 text-ink shadow hover:bg-white"
                  aria-label="Foto anterior"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 text-ink shadow hover:bg-white"
                  aria-label="Foto siguiente"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
            <p className="absolute bottom-3 left-3 rounded-full bg-ink/70 px-3 py-1 text-xs text-white">
              {photos[index]?.alt} · {index + 1}/{photos.length}
            </p>
          </div>
          {photos.length > 1 && (
            <div className="flex gap-2 overflow-x-auto px-5 pt-3">
              {photos.map((photo, photoIndex) => (
                <button
                  key={photo.src}
                  type="button"
                  onClick={() => setIndex(photoIndex)}
                  aria-label={`Ver foto ${photoIndex + 1}: ${photo.alt}`}
                  aria-current={photoIndex === index}
                  className={clsx(
                    'relative h-14 w-20 shrink-0 overflow-hidden rounded-lg ring-2 transition',
                    photoIndex === index ? 'ring-sea' : 'ring-transparent opacity-70 hover:opacity-100',
                  )}
                >
                  <Image src={photo.src} alt="" fill sizes="80px" className="object-cover" />
                </button>
              ))}
            </div>
          )}

          {/* Detalles */}
          <div className="grid gap-6 px-5 py-5 sm:grid-cols-[1fr_auto]">
            <div>
              <h2 id="room-detail-title" className="font-serif text-2xl font-semibold">{room.name}</h2>
              <p className="mt-1 flex items-center gap-2 text-sm text-muted">
                <Users className="h-4 w-4" aria-hidden /> Hasta {capacity}
              </p>
              {room.description && <p className="mt-4 leading-relaxed text-ink/85">{room.description}</p>}
              {room.amenities.length > 0 && (
                <>
                  <h3 className="mt-5 text-sm font-semibold">Comodidades</h3>
                  <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted">
                    {room.amenities.map((amenity) => {
                      const Icon = amenityIcon(amenity);
                      return (
                        <li key={amenity} className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0 text-sea" aria-hidden /> {amenity}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
            <div className="h-fit rounded-xl border border-line bg-sand p-4 sm:w-60">
              <RoomPrice room={room} priceUsd={content.priceUsd} large />
              {availability && (
                <p className={clsx('mt-3 text-sm font-semibold', availability.ok ? 'text-sea-dark' : 'text-rose-700')}>
                  {availability.text}
                </p>
              )}
              <button
                type="button"
                disabled={!selected && !canSelect}
                onClick={() => {
                  if (!selected) onSelect();
                  onClose();
                }}
                className="btn-primary mt-4 h-11 w-full text-sm"
              >
                {selected ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Seleccionada
                  </>
                ) : (
                  'Seleccionar'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Precio por noche; si la tarifa se publica en dólares la muestra en US$ con su equivalente en RD$. */
export function RoomPrice({ room, priceUsd, large }: { room: RoomType; priceUsd?: number; large?: boolean }) {
  return (
    <p className="leading-tight">
      <span className={clsx('block font-bold', large ? 'text-2xl' : 'text-lg')}>
        {priceUsd ? `US$${priceUsd}` : moneyShort(room.nightlyRate)}
      </span>
      <span className="text-xs text-muted">
        por noche{priceUsd ? ` · ${moneyShort(room.nightlyRate)}` : ''}
      </span>
    </p>
  );
}

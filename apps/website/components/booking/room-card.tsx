'use client';

import Image from 'next/image';
import { ArrowRight, Camera, CheckCircle2, Users } from 'lucide-react';
import clsx from 'clsx';
import type { RoomContent } from '@/lib/content';
import { formatShort } from '@/lib/dates';
import type { RoomType, StayAvailability } from '@/lib/types';
import { amenityIcon } from './amenities';
import { RoomPrice } from './room-detail-dialog';

type Props = {
  room: RoomType;
  content: RoomContent;
  stay: StayAvailability['roomTypes'][number] | undefined;
  loading: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onOpen: () => void;
};

/** Tarjeta de un tipo de habitación. Toda la tarjeta abre el detalle con la galería de fotos. */
export function RoomCard({ room, content, stay, loading, selected, disabled, onSelect, onOpen }: Props) {
  const capacity = room.capacityAdults + room.capacityChildren;
  const cover = content.photos[0];
  const status = (() => {
    if (!stay) return null;
    if (!stay.fitsGuests)
      return { tone: 'warn', text: `Capacidad: ${room.capacityAdults} adultos${room.capacityChildren ? ` y ${room.capacityChildren} niños` : ''}` };
    if (stay.available === 0)
      return {
        tone: 'warn',
        text: stay.soldOutDates.length
          ? `Sin cupo la noche del ${stay.soldOutDates.slice(0, 2).map(formatShort).join(' y ')}${stay.soldOutDates.length > 2 ? '…' : ''}`
          : 'No disponible en estas fechas',
      };
    if (stay.available <= 3)
      return { tone: 'low', text: stay.available === 1 ? '¡Queda 1 disponible!' : `Quedan ${stay.available} disponibles` };
    return { tone: 'ok', text: 'Disponible para tus fechas' };
  })();
  const bookable = !disabled && (stay ? stay.bookable : room.sellable);

  return (
    <article
      onClick={onOpen}
      className={clsx(
        'card group flex cursor-pointer flex-col gap-4 p-3 transition hover:border-sea/50 hover:shadow-lg min-[480px]:flex-row',
        selected && 'border-sea bg-sea-light/40 ring-1 ring-sea',
        !selected && stay && !stay.bookable && 'opacity-80',
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        aria-label={`Ver fotos de ${room.name}`}
        className="relative aspect-[4/3] w-full shrink-0 overflow-hidden rounded-xl min-[480px]:aspect-auto min-[480px]:min-h-[140px] min-[480px]:w-[36%] min-[480px]:max-w-[210px]"
      >
        {cover && (
          <Image
            src={cover.src}
            alt={cover.alt}
            fill
            sizes="(min-width: 480px) 210px, 100vw"
            className="object-cover transition duration-500 group-hover:scale-[1.04]"
          />
        )}
        <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-ink/70 px-2.5 py-1 text-[11px] font-semibold text-white">
          <Camera className="h-3.5 w-3.5" aria-hidden /> {content.photos.length} fotos
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-serif text-lg font-semibold leading-snug group-hover:text-sea-dark">{room.name}</h3>
          <div className="shrink-0 text-right">
            <RoomPrice room={room} priceUsd={content.priceUsd} />
          </div>
        </div>
        <ul className="mt-1 space-y-1 text-[12.5px] text-muted">
          <li className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden /> Hasta {capacity} huéspedes
          </li>
          {room.amenities.slice(0, 3).map((amenity) => {
            const Icon = amenityIcon(amenity);
            return (
              <li key={amenity} className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> {amenity}
              </li>
            );
          })}
        </ul>
        <div className="mt-auto flex flex-wrap items-end justify-between gap-x-3 gap-y-2 pt-2">
          <div className="min-w-0">
            {loading ? (
              <span className="block h-4 w-28 animate-pulse rounded bg-line" />
            ) : (
              status && (
                <span
                  className={clsx(
                    'block text-[11.5px] font-semibold leading-tight',
                    status.tone === 'ok' && 'text-sea-dark',
                    status.tone === 'low' && 'text-amber-700',
                    status.tone === 'warn' && 'text-rose-700',
                  )}
                >
                  {status.text}
                </span>
              )
            )}
            <span className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-semibold text-sea-dark group-hover:underline">
              Ver detalles y fotos <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
          {selected ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              className="btn-outline border-sea bg-sea-light"
              aria-pressed="true"
            >
              <CheckCircle2 className="h-4 w-4 text-sea" aria-hidden /> Seleccionada
            </button>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              disabled={!bookable || loading}
              className="btn-outline min-w-[128px]"
            >
              Seleccionar
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

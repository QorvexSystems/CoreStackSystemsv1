import type { MetadataRoute } from 'next';
import { brand } from '@/lib/brand';

// Instalable como app (necesario para recibir notificaciones push en iPhone, iOS 16.4+).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: brand.name,
    short_name: brand.shortName,
    description: `${brand.descriptor}. Gestión hotelera desarrollada por CoreStack.`,
    start_url: '/reservations',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f7f6f2',
    theme_color: '#15988d',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

import type { MetadataRoute } from 'next';
import { brand } from '@/lib/brand';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: `${brand.descriptor}. Gestión empresarial desarrollada por CoreStack.`,
    start_url: '/',
    display: 'standalone',
    background_color: '#f8f5ee',
    theme_color: '#9a6b00',
    icons: [
      {
        src: '/brand/unique-app-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/brand/unique-app-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
}

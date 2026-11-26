import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';
import { brand } from '@/lib/brand';

// En Android el teclado redimensiona el contenido (en vez de taparlo), así el campo activo queda visible.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#15988d',
  interactiveWidget: 'resizes-content',
};

export const metadata: Metadata = {
  applicationName: brand.name,
  title: {
    default: `${brand.name} | Operación hotelera`,
    template: `%s | ${brand.name}`,
  },
  description: `${brand.descriptor}. Reservaciones, habitaciones, huéspedes, canales y facturación.`,
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: brand.faviconPath, type: 'image/png', sizes: '512x512' }],
    shortcut: brand.faviconPath,
    apple: [{ url: brand.appleTouchIconPath, type: 'image/png', sizes: '180x180' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: brand.shortName,
  },
};

// A per-request CSP nonce requires dynamic rendering so Next.js can attach the
// nonce to its generated scripts instead of permitting arbitrary inline code.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

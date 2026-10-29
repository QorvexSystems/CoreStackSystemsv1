import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';
import { brand } from '@/lib/brand';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  applicationName: brand.name,
  title: {
    default: `${brand.name} | CoreStack`,
    template: `%s | ${brand.name}`,
  },
  description: `${brand.descriptor}. Operación, facturación, personalización e inventario.`,
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
      <body className={`${inter.variable} font-sans`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

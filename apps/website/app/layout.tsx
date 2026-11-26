import type { Metadata, Viewport } from 'next';
import { Fraunces, Mulish } from 'next/font/google';
import './globals.css';

const serif = Fraunces({ subsets: ['latin'], variable: '--font-serif', display: 'swap' });
const sans = Mulish({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: 'Hotel Suite Ancla · Reserva tu estadía en Barahona',
  description:
    'Comodidad, descanso y una excelente ubicación. Reserva tu estadía en Hotel Suite Ancla de forma rápida y sin registro.',
  icons: { icon: '/brand/hotel-ancla-logo.png' },
  openGraph: {
    title: 'Hotel Suite Ancla',
    description: 'Tu lugar en el corazón de la ciudad. Reserva de forma rápida y sin registro.',
    type: 'website',
    locale: 'es_DO',
  },
};

export const viewport: Viewport = { themeColor: '#137E74' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-DO" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}

export const brand = {
  name: 'Hotel Ancla',
  shortName: 'Ancla',
  tagline: 'Hospitalidad que siempre te trae de vuelta',
  descriptor: 'Operación integral del hotel',
  logoPath: '/brand/hotel-ancla-logo.png',
  horizontalLogoPath: '/brand/hotel-ancla-logo.png',
  stackedLogoPath: '/brand/hotel-ancla-logo.png',
  wordmarkPath: '/brand/hotel-ancla-logo.png',
  faviconPath: '/brand/hotel-ancla-logo.png',
  appleTouchIconPath: '/icons/apple-touch-icon.png',
  loginEmailPlaceholder: 'usuario@hotelancla.local',
} as const;

export const platform = {
  name: 'CoreStack',
  logoPath: '/brand/corestack-logo.jpeg',
  description: 'Plataforma hotelera provista por CoreStack',
} as const;

export const brandCopy = {
  operationalDescription: `Operación diaria de ${brand.name}.`,
  catalogDescription: `Reservas, habitaciones, huéspedes y facturación de ${brand.name}.`,
} as const;

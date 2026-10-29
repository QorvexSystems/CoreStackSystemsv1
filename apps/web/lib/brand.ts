export const brand = {
  name: 'Unique Personalizado',
  shortName: 'Unique',
  tagline: 'Detalles únicos para momentos inolvidables',
  descriptor: 'Joyas y regalos personalizados',
  logoPath: '/brand/logo-brand.png',
  horizontalLogoPath: '/brand/unique-logo-horizontal.png',
  stackedLogoPath: '/brand/logo-brand.png',
  wordmarkPath: '/brand/unique-wordmark.png',
  faviconPath: '/icon.png',
  appleTouchIconPath: '/apple-icon.png',
  loginEmailPlaceholder: 'usuario@uniquepersonalizado.com',
} as const;

export const platform = {
  name: 'CoreStack',
  logoPath: '/brand/corestack-logo.jpeg',
  description: 'Tecnología empresarial creada por CoreStack',
} as const;

export const brandCopy = {
  operationalDescription: `Operación diaria de ${brand.name}.`,
  catalogDescription: `Catálogo, personalización, precios e inventario de ${brand.name}.`,
} as const;

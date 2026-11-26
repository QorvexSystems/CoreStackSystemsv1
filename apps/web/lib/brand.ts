// Punto único de personalización para cada instalación de la plantilla de taller.
export const brand = {
  name: 'Soluciones Automotriz CyR',
  shortName: 'Automotriz CyR',
  tagline: 'Gestión de taller',
  descriptor: 'Sistema Electrico, Mecanica Automotriz y Programaciones.',
  address: 'Calle Betania No. 21 Detras de la Innocacion, Los Beibolistas, Sto. Dgo. Oeste, R.D.',
  rnc: '132279816',
  phone: '829-995-1128',
  logoPath: '/brand/logo-taller.png',
  faviconPath: '/brand/logo-taller-32.png',
  appleTouchIconPath: '/brand/logo-taller-180.png',
  pwaIconPath: '/brand/logo-taller-192.png',
  pwaLargeIconPath: '/brand/logo-taller-512.png',
  loginEmailPlaceholder: 'usuario@solucionesautomotrizcyr.local',
  businessType: 'Taller automotriz',
} as const;

export const platform = {
  name: 'CoreStack',
  logoPath: '/brand/corestack-logo.jpeg',
  description: 'Tecnología empresarial creada por CoreStack',
} as const;

export const brandCopy = {
  operationalDescription: `Operación diaria de ${brand.name}.`,
  catalogDescription: `Catálogo, precios e inventario de ${brand.name}.`,
} as const;

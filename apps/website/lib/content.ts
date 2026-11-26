// Contenido editorial del sitio. Los datos operativos (tipos, tarifas, capacidad, disponibilidad) vienen
// del ERP; aquí solo hay textos y fotos. Las fotos son de ejemplo (Unsplash): sustitúyelas por fotos
// reales del hotel en /public cuando estén listas.

const unsplash = (id: string, width = 1200) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}&q=75`;

export const heroImage = unsplash('1618773928121-c32242e63f39', 1800);

export type RoomPhoto = { src: string; alt: string };
export type RoomContent = {
  /** Fotos de la galería; la primera es la portada de la tarjeta. */
  photos: RoomPhoto[];
  /** Tarifa publicada en dólares (se cobra su equivalente en RD$ guardado en el ERP). */
  priceUsd?: number;
};

// Galerías por tipo de habitación (se asocian por el nombre que tiene el tipo en el ERP).
// Para usar fotos reales: copia los archivos a apps/website/public/rooms/<carpeta>/ y reemplaza cada
// `src` por su ruta, por ejemplo { src: '/rooms/doble/1.jpg', alt: 'Habitación doble' }.
const roomContent: { match: RegExp; content: RoomContent }[] = [
  {
    match: /apart/i,
    content: {
      priceUsd: 100,
      photos: [
        { src: unsplash('1554995207-c18c203602cb'), alt: 'Sala del apartamento con cocina abierta' },
        { src: unsplash('1484154218962-a197022b5858'), alt: 'Cocina equipada' },
        { src: unsplash('1560185007-cde436f6a4d0'), alt: 'Comedor y sala' },
        { src: unsplash('1540518614846-7eded433c457'), alt: 'Habitación principal' },
        { src: unsplash('1560185893-a55cbc8c57e8'), alt: 'Segunda habitación' },
        { src: unsplash('1584622650111-993a426fbf0a'), alt: 'Baño del apartamento' },
      ],
    },
  },
  {
    match: /doble|double|twin/i,
    content: {
      photos: [
        { src: unsplash('1595576508898-0ad5c879a061'), alt: 'Habitación doble con dos camas' },
        { src: unsplash('1566665797739-1674de7a421a'), alt: 'Detalle de las camas' },
        { src: unsplash('1611892440504-42a792e24d32'), alt: 'Ambiente cálido de la habitación' },
        { src: unsplash('1552321554-5fefe8c9ef14'), alt: 'Baño privado' },
      ],
    },
  },
  {
    match: /sencill|single|standard/i,
    content: {
      photos: [
        { src: unsplash('1631049307264-da0ec9d70304'), alt: 'Habitación sencilla con vista a la ciudad' },
        { src: unsplash('1590490359683-658d3d23f972'), alt: 'Área de escritorio junto a la ventana' },
        { src: unsplash('1629140727571-9b5c6f6267b4'), alt: 'Cama matrimonial' },
        { src: unsplash('1584622650111-993a426fbf0a'), alt: 'Baño privado' },
      ],
    },
  },
];
const fallbackPhotos: RoomPhoto[] = [
  { src: unsplash('1611892440504-42a792e24d32'), alt: 'Habitación' },
  { src: unsplash('1582719478250-c89cae4dc85b'), alt: 'Habitación' },
];

export function roomContentFor(name: string): RoomContent {
  return roomContent.find((rule) => rule.match.test(name))?.content ?? { photos: fallbackPhotos };
}

export const gallery = [
  { src: unsplash('1611892440504-42a792e24d32'), alt: 'Habitación con iluminación cálida' },
  { src: unsplash('1551882547-ff40c63fe5fa'), alt: 'Piscina al atardecer' },
  { src: unsplash('1578683010236-d716f9a3f461'), alt: 'Suite amplia con sala' },
  { src: unsplash('1584132967334-10e028bd69f7'), alt: 'Terraza junto al mar' },
  { src: unsplash('1631049307264-da0ec9d70304'), alt: 'Habitación con vista a la ciudad' },
];

/** Dirección mostrada si el ERP no tiene una registrada. */
export const fallbackAddress =
  'Frente a la Escuela Laboral Vocacional, Calle Los Maestros #1, Barahona 81000';

/** Ficha de Google Maps del hotel: botón "Cómo llegar" y mapa embebido (por su CID, el pin exacto). */
export const mapsLink = 'https://maps.app.goo.gl/HCXd6kpR9s3XZACC8';
export const mapsEmbedUrl = 'https://maps.google.com/maps?cid=5849573661409507608&hl=es&output=embed';

export function whatsappLink(
  phone: string | null,
  text = 'Hola, tengo una pregunta sobre una reserva.',
) {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const international = digits.length === 10 ? `1${digits}` : digits;
  return `https://wa.me/${international}?text=${encodeURIComponent(text)}`;
}

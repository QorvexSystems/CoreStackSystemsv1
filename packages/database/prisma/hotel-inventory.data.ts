// Inventario real de Hotel Ancla. Lo usan el seed demo y el script de reemplazo de inventario.
//
// El ERP trabaja en RD$. El apartamento tiene tarifa en dólares: se guarda en RD$ con la tasa
// HOTEL_USD_EXCHANGE_RATE (por defecto 63) y el sitio web la muestra en US$.

export const USD_TO_DOP = (() => {
  const value = Number(process.env.HOTEL_USD_EXCHANGE_RATE ?? 63);
  if (!Number.isFinite(value) || value <= 0) throw new Error('HOTEL_USD_EXCHANGE_RATE inválida.');
  return value;
})();

export type HotelRoomTypeSpec = {
  name: string;
  description: string;
  baseRate: number;
  capacityAdults: number;
  capacityChildren: number;
  amenities: string[];
  rooms: { number: string; floor: number }[];
};

/** Numeración real del hotel: "piso-habitación" (ej. 2-5 = piso 2, habitación 5). */
const rooms = (numbers: string[]) => numbers.map((number) => ({ number, floor: Number(number.split('-')[0]) }));

export const hotelRoomTypes: HotelRoomTypeSpec[] = [
  {
    name: 'Habitación Sencilla',
    description:
      'Habitación acogedora con cama matrimonial, ideal para viajeros solos o parejas que buscan descanso y una excelente ubicación.',
    baseRate: 2300,
    capacityAdults: 2,
    capacityChildren: 1,
    amenities: ['Cama matrimonial', 'Wi-Fi', 'Aire acondicionado', 'Smart TV', 'Baño privado'],
    rooms: rooms(['1-1', '1-4', '1-5', '2-2', '2-5', '2-6']),
  },
  {
    name: 'Habitación Doble',
    description:
      'Amplia habitación con dos camas, perfecta para familias, amigos o compañeros de viaje que quieren compartir sin perder comodidad.',
    baseRate: 3000,
    capacityAdults: 4,
    capacityChildren: 2,
    amenities: ['2 camas', 'Wi-Fi', 'Aire acondicionado', 'Smart TV', 'Baño privado'],
    rooms: rooms(['1-2', '1-3', '2-1', '2-3', '2-4']),
  },
  {
    name: 'Apartamento',
    description:
      'Apartamento completo de 2 habitaciones con sala, comedor y cocina equipada. Ideal para familias y estadías largas con la privacidad de un hogar.',
    baseRate: Math.round(100 * USD_TO_DOP),
    capacityAdults: 4,
    capacityChildren: 2,
    amenities: [
      '2 habitaciones',
      'Cocina equipada',
      'Sala y comedor',
      'Wi-Fi',
      'Aire acondicionado',
      'Smart TV',
    ],
    rooms: [{ number: 'APT-1', floor: 3 }],
  },
];

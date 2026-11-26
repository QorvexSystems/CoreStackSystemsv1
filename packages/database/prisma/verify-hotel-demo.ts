import { PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'hotel-ancla' }, include: { hotelRoomTypes: true, hotelRooms: true, hotelGuests: true, hotelChannels: true, hotelReservations: true } });
  if (!tenant) throw new Error('No existe el tenant hotel-ancla.');
  if (tenant.hotelRoomTypes.length < 3) throw new Error('Faltan tipos de habitación demo.');
  if (tenant.hotelRooms.length < 12) throw new Error('Faltan habitaciones demo.');
  if (tenant.hotelChannels.length < 5) throw new Error('Faltan canales demo.');
  if (tenant.hotelReservations.length < 3) throw new Error('Faltan reservaciones demo.');
  console.log(`Hotel Ancla verificado: ${tenant.hotelRooms.length} habitaciones, ${tenant.hotelReservations.length} reservas y ${tenant.hotelGuests.length} huéspedes.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());

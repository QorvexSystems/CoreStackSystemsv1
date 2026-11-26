// Reemplaza el inventario de Hotel Ancla (tipos y habitaciones) por el de hotel-inventory.data.ts.
// Como las reservaciones dependen de los tipos, también elimina los datos operativos de PRUEBA del hotel:
// pagos de reservaciones, reservaciones y huéspedes. NO toca usuarios, membresías, canales, tenant,
// secuencias fiscales ni bitácora.
//
//   HOTEL_BACKUP_FILE=<ruta.json>             respaldo previo obligatorio (se escribe antes de borrar)
//   HOTEL_INVENTORY_CONFIRM=si                sin esto solo muestra lo que haría
//   HOTEL_USD_EXCHANGE_RATE=63                tasa para la tarifa en dólares del apartamento
import { writeFileSync } from 'node:fs';
import { HotelRoomStatus, HousekeepingStatus, PrismaClient } from '../generated/client';
import { hotelRoomTypes } from './hotel-inventory.data';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'hotel-ancla' } });
  if (!tenant) throw new Error('No existe el tenant hotel-ancla.');
  const where = { tenantId: tenant.id };

  const [payments, reservations, guests, rooms, roomTypes] = await Promise.all([
    prisma.hotelReservationPayment.findMany({ where }),
    prisma.hotelReservation.findMany({ where }),
    prisma.hotelGuest.findMany({ where }),
    prisma.hotelRoom.findMany({ where }),
    prisma.hotelRoomType.findMany({ where }),
  ]);
  console.log(
    `Actual: ${roomTypes.length} tipos, ${rooms.length} habitaciones, ${reservations.length} reservaciones, ` +
      `${payments.length} pagos, ${guests.length} huéspedes.`,
  );
  console.log('Nuevo inventario:');
  for (const type of hotelRoomTypes)
    console.log(`  ${type.name}: RD$${type.baseRate} · ${type.rooms.map((room) => room.number).join(', ')}`);

  if (process.env.HOTEL_INVENTORY_CONFIRM !== 'si') {
    console.log('\nSimulación: no se modificó nada. Usa HOTEL_INVENTORY_CONFIRM=si para aplicar.');
    return;
  }
  const backupFile = process.env.HOTEL_BACKUP_FILE;
  if (!backupFile) throw new Error('Define HOTEL_BACKUP_FILE para guardar el respaldo antes de borrar.');
  writeFileSync(
    backupFile,
    JSON.stringify({ tenant: tenant.slug, at: new Date(), payments, reservations, guests, rooms, roomTypes }, null, 2),
  );
  console.log(`\nRespaldo guardado en ${backupFile}`);

  await prisma.$transaction(
    async (tx) => {
      await tx.hotelReservationPayment.deleteMany({ where });
      await tx.hotelReservation.deleteMany({ where });
      await tx.hotelGuest.deleteMany({ where });
      await tx.hotelRoom.deleteMany({ where });
      await tx.hotelRoomType.deleteMany({ where });
      for (const { rooms: units, amenities, ...data } of hotelRoomTypes) {
        const type = await tx.hotelRoomType.create({ data: { ...data, amenities, tenantId: tenant.id } });
        await tx.hotelRoom.createMany({
          data: units.map((room) => ({
            tenantId: tenant.id,
            roomTypeId: type.id,
            number: room.number,
            floor: room.floor,
            status: HotelRoomStatus.AVAILABLE,
            housekeepingStatus: HousekeepingStatus.CLEAN,
          })),
        });
      }
    },
    { timeout: 60_000, maxWait: 20_000 },
  );

  const [types, units] = await Promise.all([
    prisma.hotelRoomType.findMany({ where, include: { _count: { select: { rooms: true } } }, orderBy: { baseRate: 'asc' } }),
    prisma.hotelRoom.count({ where }),
  ]);
  console.log('Inventario aplicado:');
  for (const type of types) console.log(`  ${type.name}: RD$${type.baseRate} · ${type._count.rooms} unidades`);
  console.log(`Total: ${units} unidades. Reservaciones, pagos y huéspedes de prueba eliminados.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

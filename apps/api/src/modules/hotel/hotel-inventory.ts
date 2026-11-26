import { HotelReservationStatus, HotelRoomStatus, Prisma } from '@qorvex/database';
import {
  addDays,
  daysBetween,
  hotelDateKey,
  hotelInstant,
  nightlyAvailability,
  type OccupyingReservation,
} from './hotel-availability';

type Db = Prisma.TransactionClient;

/** Estados que ya no ocupan inventario. */
export const RELEASED_RESERVATION_STATUSES: HotelReservationStatus[] = [
  HotelReservationStatus.CANCELLED,
  HotelReservationStatus.NO_SHOW,
  HotelReservationStatus.CHECKED_OUT,
];

/** Habitaciones que no se pueden vender. */
const UNSELLABLE_ROOM_STATUSES: HotelRoomStatus[] = [
  HotelRoomStatus.MAINTENANCE,
  HotelRoomStatus.OUT_OF_SERVICE,
];

/**
 * Serializa la creación de reservaciones del hotel dentro de la transacción. Con el bloqueo tomado, la
 * verificación de inventario y la inserción son atómicas: dos solicitudes simultáneas para la última
 * habitación nunca pueden aceptarse ambas. Se libera sola al terminar la transacción.
 */
export async function lockHotelReservations(tx: Db, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hotel-reservations:${tenantId}`}))`;
}

export async function bookableRoomsByType(db: Db, tenantId: string, roomTypeIds?: string[]) {
  const grouped = await db.hotelRoom.groupBy({
    by: ['roomTypeId'],
    where: {
      tenantId,
      status: { notIn: UNSELLABLE_ROOM_STATUSES },
      ...(roomTypeIds ? { roomTypeId: { in: roomTypeIds } } : {}),
    },
    _count: { _all: true },
  });
  const counts = new Map<string, number>();
  for (const id of roomTypeIds ?? []) counts.set(id, 0);
  for (const row of grouped) counts.set(row.roomTypeId, row._count._all);
  return counts;
}

/**
 * Disponibilidad por tipo y noche para [from, from + days). Las reservaciones se buscan con un margen de
 * un día porque se comparan por fecha local del hotel, no por instante UTC.
 */
export async function loadNightlyAvailability(
  db: Db,
  tenantId: string,
  from: string,
  days: number,
  roomTypeIds?: string[],
  /** Reservación que se está editando: no cuenta contra su propio inventario. */
  excludeReservationId?: string,
) {
  const rooms = await bookableRoomsByType(db, tenantId, roomTypeIds);
  const windowStart = new Date(Date.parse(`${addDays(from, -1)}T00:00:00Z`));
  const windowEnd = new Date(Date.parse(`${addDays(from, days + 1)}T00:00:00Z`));
  const typeFilter = roomTypeIds ? { roomTypeId: { in: roomTypeIds } } : {};
  // Con habitación asignada cuenta el tipo de la habitación física (por si la reservación quedó con otro tipo).
  const reservationTypeFilter = roomTypeIds
    ? { OR: [{ roomTypeId: { in: roomTypeIds } }, { room: { roomTypeId: { in: roomTypeIds } } }] }
    : {};
  const occupying = (row: { roomTypeId: string; room: { roomTypeId: string } | null }) =>
    row.room?.roomTypeId ?? row.roomTypeId;
  const reservations: (OccupyingReservation & { status?: HotelReservationStatus })[] = (
    await db.hotelReservation.findMany({
      where: {
        tenantId,
        status: { notIn: RELEASED_RESERVATION_STATUSES },
        checkIn: { lt: windowEnd },
        checkOut: { gt: windowStart },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
        ...reservationTypeFilter,
      },
      select: {
        roomTypeId: true,
        checkIn: true,
        checkOut: true,
        status: true,
        room: { select: { roomTypeId: true } },
      },
    })
  ).map((row) => ({ ...row, roomTypeId: occupying(row) }));

  // La noche de hoy se ajusta al estado físico del hotel: un huésped con check-in que no ha registrado su
  // salida sigue ocupando la habitación aunque su fecha de salida ya pasó, y una habitación marcada como
  // ocupada sin estadía registrada tampoco se puede vender esta noche.
  const today = hotelDateKey(new Date());
  if (from <= today && today < addDays(from, days)) {
    const tonight = { checkIn: hotelInstant(today, 12), checkOut: hotelInstant(addDays(today, 1), 11) };
    const startOfToday = hotelInstant(today, 0);
    const [overstays, occupiedRooms, inHouse] = await Promise.all([
      db.hotelReservation.findMany({
        where: {
          tenantId,
          status: HotelReservationStatus.CHECKED_IN,
          checkOut: { lte: windowStart < startOfToday ? windowStart : startOfToday },
          ...reservationTypeFilter,
        },
        select: { roomTypeId: true, room: { select: { roomTypeId: true } } },
      }),
      db.hotelRoom.findMany({
        where: { tenantId, status: HotelRoomStatus.OCCUPIED, ...typeFilter },
        select: { id: true, roomTypeId: true },
      }),
      db.hotelReservation.findMany({
        where: { tenantId, status: HotelReservationStatus.CHECKED_IN, roomId: { not: null } },
        select: { roomId: true },
      }),
    ]);
    const lodged = new Set(inHouse.map((item) => item.roomId));
    for (const stay of overstays) reservations.push({ roomTypeId: occupying(stay), ...tonight });
    for (const room of occupiedRooms)
      if (!lodged.has(room.id)) reservations.push({ roomTypeId: room.roomTypeId, ...tonight });
    // Estadías con check-in cuya salida venció antes de hoy y caen en la ventana: se extienden hasta mañana.
    for (const stay of reservations)
      if (
        stay.status === HotelReservationStatus.CHECKED_IN &&
        stay.checkOut < startOfToday &&
        stay.checkOut > windowStart
      )
        stay.checkOut = tonight.checkOut;
  }
  return nightlyAvailability(rooms, reservations, from, days);
}

/** Habitaciones de un tipo libres durante TODA la estadía (el mínimo entre sus noches). */
export async function availableRoomsForStay(
  db: Db,
  tenantId: string,
  roomTypeId: string,
  checkIn: Date,
  checkOut: Date,
  excludeReservationId?: string,
) {
  const from = hotelDateKey(checkIn);
  const nights = Math.max(1, daysBetween(from, hotelDateKey(checkOut)));
  const availability = await loadNightlyAvailability(
    db,
    tenantId,
    from,
    nights,
    [roomTypeId],
    excludeReservationId,
  );
  return Math.min(...(availability.get(roomTypeId) ?? [0]));
}

/** Código consecutivo AN-xxxxx. Debe llamarse con `lockHotelReservations` tomado. */
export async function nextReservationCode(db: Db, tenantId: string) {
  let sequence = 10001 + (await db.hotelReservation.count({ where: { tenantId } }));
  for (;;) {
    const code = `AN-${String(sequence).padStart(5, '0')}`;
    const taken = await db.hotelReservation.findUnique({
      where: { tenantId_code: { tenantId, code } },
      select: { id: true },
    });
    if (!taken) return code;
    sequence += 1;
  }
}

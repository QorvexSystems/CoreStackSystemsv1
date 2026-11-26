import {
  DocumentType,
  EmployeeStatus,
  FiscalSequenceStatus,
  HotelChannelType,
  HotelPaymentStatus,
  HotelReservationStatus,
  HotelRoomStatus,
  HousekeepingStatus,
  InvoiceDocumentType,
  MembershipStatus,
  PrismaClient,
  Role,
  UserStatus,
} from '../generated/client';
import * as bcrypt from 'bcryptjs';
import { USD_TO_DOP, hotelRoomTypes } from './hotel-inventory.data';

const prisma = new PrismaClient();
const demoPassword = process.env.SEED_HOTEL_DEMO_PASSWORD ?? 'HotelAnclaDemo#2026!';

async function main() {
  if (demoPassword.length < 16)
    throw new Error('SEED_HOTEL_DEMO_PASSWORD debe tener al menos 16 caracteres.');
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'hotel-ancla' } });
  if (!tenant) throw new Error('Primero ejecuta pnpm db:seed para crear el tenant de Hotel Ancla.');
  const passwordHash = await bcrypt.hash(demoPassword, 12);

  const users = [
    {
      email: 'recepcion@hotelancla.local',
      name: 'Recepción Hotel Ancla',
      role: Role.RECEPTION,
      employeeCode: 'HA-REC-001',
      jobTitle: 'Recepcionista',
    },
    {
      // La limpieza se coordina desde recepción; este puesto pasó a ser el contador (solo Facturación).
      email: 'contador@hotelancla.local',
      name: 'Contador Hotel Ancla',
      role: Role.ACCOUNTANT,
      employeeCode: 'HA-CON-002',
      jobTitle: 'Contador',
    },
  ];
  for (const item of users) {
    const user = await prisma.user.upsert({
      where: { email: item.email },
      update: { name: item.name, passwordHash, status: UserStatus.ACTIVE },
      create: { email: item.email, name: item.name, passwordHash, status: UserStatus.ACTIVE },
    });
    const hotelPermissions = {
      canViewReports: item.role === Role.ACCOUNTANT,
      canTakeOrders: false,
      canUsePos: false,
    };
    await prisma.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      update: { role: item.role, status: MembershipStatus.ACTIVE, ...hotelPermissions },
      create: { userId: user.id, tenantId: tenant.id, role: item.role, ...hotelPermissions },
    });
    await prisma.employeeProfile.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: {
        employeeCode: item.employeeCode,
        jobTitle: item.jobTitle,
        status: EmployeeStatus.ACTIVE,
      },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        employeeCode: item.employeeCode,
        jobTitle: item.jobTitle,
        status: EmployeeStatus.ACTIVE,
      },
    });
  }

  for (const sequence of [
    {
      documentType: InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
      prefix: 'E31',
    },
    {
      documentType: InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
      prefix: 'E32',
    },
  ]) {
    const existing = await prisma.fiscalSequence.findFirst({
      where: { tenantId: tenant.id, documentType: sequence.documentType },
    });
    if (!existing) {
      await prisma.fiscalSequence.create({
        data: {
          tenantId: tenant.id,
          documentType: sequence.documentType,
          prefix: sequence.prefix,
          startNumber: 1,
          endNumber: 999999,
          nextNumber: 1,
          authorizationNumber: 'HOTEL-ANCLA-DEMO',
          status: FiscalSequenceStatus.ACTIVE,
        },
      });
    }
  }

  const roomTypes = new Map<string, string>();
  for (const spec of hotelRoomTypes) {
    const { rooms, amenities, ...data } = spec;
    const roomType = await prisma.hotelRoomType.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: spec.name } },
      update: { ...data, amenities },
      create: { tenantId: tenant.id, ...data, amenities },
    });
    roomTypes.set(spec.name, roomType.id);
    for (const room of rooms) {
      await prisma.hotelRoom.upsert({
        where: { tenantId_number: { tenantId: tenant.id, number: room.number } },
        update: { roomTypeId: roomType.id, floor: room.floor },
        create: {
          tenantId: tenant.id,
          roomTypeId: roomType.id,
          number: room.number,
          floor: room.floor,
          status: HotelRoomStatus.AVAILABLE,
          housekeepingStatus: HousekeepingStatus.CLEAN,
        },
      });
    }
  }

  await prisma.hotelChannel.updateMany({
    where: { tenantId: tenant.id, type: HotelChannelType.DIRECT_WEB, name: 'Directo (Web)' },
    data: { name: 'Sitio Web' },
  });
  const channelSpecs = [
    [HotelChannelType.WALK_IN, 'Interno'],
    [HotelChannelType.DIRECT_WEB, 'Sitio Web'],
    [HotelChannelType.WHATSAPP, 'WhatsApp'],
    [HotelChannelType.BOOKING, 'Booking.com'],
    [HotelChannelType.EXPEDIA, 'Expedia'],
    [HotelChannelType.AIRBNB, 'Airbnb'],
  ] as const;
  const channels = new Map<string, string>();
  for (const [type, name] of channelSpecs) {
    const channel = await prisma.hotelChannel.upsert({
      where: { tenantId_type_name: { tenantId: tenant.id, type, name } },
      update: { active: true, lastSyncedAt: new Date() },
      create: { tenantId: tenant.id, type, name, lastSyncedAt: new Date() },
    });
    channels.set(name, channel.id);
  }

  const reservationSpecs = [
    {
      code: 'AN-10286',
      firstName: 'María',
      lastName: 'González',
      email: 'maria.gonzalez@gmail.com',
      phone: '+1 809 555 1234',
      type: 'Habitación Doble',
      room: '2-1',
      channel: 'Sitio Web',
      nights: 2,
      total: 6000,
      status: HotelReservationStatus.PENDING_REVIEW,
      payment: HotelPaymentStatus.PENDING,
    },
    {
      code: 'AN-10285',
      firstName: 'Carlos',
      lastName: 'Méndez',
      email: 'carlos.mendez@gmail.com',
      phone: '+1 829 555 4021',
      type: 'Habitación Sencilla',
      room: '1-4',
      channel: 'WhatsApp',
      nights: 1,
      total: 2300,
      status: HotelReservationStatus.CONFIRMED,
      payment: HotelPaymentStatus.PENDING,
    },
    {
      code: 'AN-10284',
      firstName: 'Laura',
      lastName: 'Contreras',
      email: 'laura.contreras@gmail.com',
      phone: '+1 849 555 7720',
      type: 'Apartamento',
      room: 'APT-1',
      channel: 'Booking.com',
      nights: 3,
      total: 3 * Math.round(100 * USD_TO_DOP),
      status: HotelReservationStatus.ASSIGNED,
      payment: HotelPaymentStatus.PENDING,
    },
  ];
  for (const [index, spec] of reservationSpecs.entries()) {
    let guest = await prisma.hotelGuest.findFirst({
      where: { tenantId: tenant.id, email: spec.email },
    });
    guest ??= await prisma.hotelGuest.create({
      data: {
        tenantId: tenant.id,
        firstName: spec.firstName,
        lastName: spec.lastName,
        email: spec.email,
        phone: spec.phone,
        documentType: DocumentType.PASSPORT,
        documentNumber: `HA-DEMO-${index + 1}`,
      },
    });
    const room = await prisma.hotelRoom.findUnique({
      where: { tenantId_number: { tenantId: tenant.id, number: spec.room } },
    });
    const checkIn = new Date();
    checkIn.setHours(15, 0, 0, 0);
    checkIn.setDate(checkIn.getDate() + index);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + spec.nights);
    await prisma.hotelReservation.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: spec.code } },
      update: {
        guestId: guest.id,
        roomTypeId: roomTypes.get(spec.type)!,
        roomId: room?.id,
        channelId: channels.get(spec.channel),
        status: spec.status,
        paymentStatus: spec.payment,
        checkIn,
        checkOut,
        totalAmount: spec.total,
        paidAmount: spec.payment === HotelPaymentStatus.PAID ? spec.total : 0,
      },
      create: {
        tenantId: tenant.id,
        code: spec.code,
        guestId: guest.id,
        roomTypeId: roomTypes.get(spec.type)!,
        roomId: room?.id,
        channelId: channels.get(spec.channel),
        status: spec.status,
        paymentStatus: spec.payment,
        checkIn,
        checkOut,
        adults: 2,
        totalAmount: spec.total,
        paidAmount: spec.payment === HotelPaymentStatus.PAID ? spec.total : 0,
        arrivalTime: '3:00 p. m.',
      },
    });
  }

  console.log('Datos demo de Hotel Ancla creados correctamente.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

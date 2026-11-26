import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DocumentType,
  FiscalSequenceStatus,
  HotelBillingDocumentType,
  HotelChannelType,
  HotelPaymentStatus,
  HotelReservationStatus,
  HotelRoomStatus,
  HousekeepingStatus,
  InvoiceDocumentType,
  PaymentMethod,
  Prisma,
} from '@qorvex/database';
import { validateDominicanDocument } from '../../common/utils/dominican-documents';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_CHECK_IN_HOUR,
  DEFAULT_CHECK_OUT_HOUR,
  earlyCheckoutCredit,
  hotelDateKey,
  hotelInstant,
} from './hotel-availability';
import { availableRoomsForStay, lockHotelReservations, nextReservationCode } from './hotel-inventory';
import {
  AssignHotelRoomDto,
  CreateHotelChannelDto,
  CreateHotelExpressInvoiceDto,
  CreateHotelReservationDto,
  RecordHotelPaymentDto,
  UpdateHotelReservationDto,
  UpdateHotelReservationStatusDto,
  UpdateHotelRoomStateDto,
  UpdateHotelGuestDto,
} from './hotel.dto';

const tenantInvoiceSelect = {
  name: true,
  commercialName: true,
  legalName: true,
  rnc: true,
  email: true,
  phone: true,
  address: true,
} as const;

const reservationInclude = {
  tenant: {
    select: {
      name: true,
      commercialName: true,
      legalName: true,
      rnc: true,
      email: true,
      phone: true,
      address: true,
    },
  },
  guest: {
    include: {
      credits: {
        where: { remainingAmount: { gt: 0 } },
        orderBy: { createdAt: 'asc' as const },
        include: { sourceReservation: { select: { code: true } } },
      },
    },
  },
  roomType: true,
  room: true,
  channel: true,
  payments: {
    include: { recordedBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.HotelReservationInclude;

/** Hora (del hotel) a la que una llegada sin check-in pasa a "inasistida". */
export const NO_SHOW_HOUR = 21;
/** Tiempo que una inasistida queda para recuperarla antes de borrarse sola. */
const NO_SHOW_RETENTION_MS = 24 * 3_600_000;
const BEFORE_CHECK_IN: HotelReservationStatus[] = [
  HotelReservationStatus.PENDING_REVIEW,
  HotelReservationStatus.CONFIRMED,
  HotelReservationStatus.ASSIGNED,
];
/** Las horas del hotel son fijas: llegada 3:00 PM y salida 11:00 AM (solo cuenta la fecha enviada). */
const fixedCheckIn = (value: string | Date) =>
  hotelInstant(hotelDateKey(new Date(value)), DEFAULT_CHECK_IN_HOUR);
const fixedCheckOut = (value: string | Date) =>
  hotelInstant(hotelDateKey(new Date(value)), DEFAULT_CHECK_OUT_HOUR);
/** Pagos que se pueden borrar con la reservación: solo los simulados del sitio web (sin cobro en recepción). */
const isOnlinePayment = (payment: { notes: string | null; method: PaymentMethod }) =>
  payment.method === PaymentMethod.CARD && Boolean(payment.notes?.startsWith('Pago en línea'));

@Injectable()
export class HotelService {
  private readonly logger = new Logger(HotelService.name);
  /** Último barrido de inasistidas por hotel (evita repetirlo en cada consulta). */
  private readonly lastSweep = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async dashboard(tenantId: string) {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 999);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [rooms, arrivals, departures, pendingPayments, monthRevenue, channels] =
      await Promise.all([
        this.prisma.hotelRoom.groupBy({
          by: ['status'],
          where: { tenantId },
          _count: true,
        }),
        this.prisma.hotelReservation.count({
          where: {
            tenantId,
            checkIn: { gte: dayStart, lte: dayEnd },
            status: {
              notIn: [HotelReservationStatus.CANCELLED, HotelReservationStatus.NO_SHOW],
            },
          },
        }),
        this.prisma.hotelReservation.count({
          where: {
            tenantId,
            checkOut: { gte: dayStart, lte: dayEnd },
            status: { not: HotelReservationStatus.CANCELLED },
          },
        }),
        this.prisma.hotelReservation.aggregate({
          where: {
            tenantId,
            paymentStatus: { in: [HotelPaymentStatus.PENDING, HotelPaymentStatus.PARTIAL] },
          },
          _sum: { totalAmount: true, paidAmount: true },
          _count: true,
        }),
        this.prisma.hotelReservation.aggregate({
          where: {
            tenantId,
            createdAt: { gte: monthStart },
            status: { not: HotelReservationStatus.CANCELLED },
          },
          _sum: { totalAmount: true },
        }),
        this.prisma.hotelReservation.groupBy({
          by: ['channelId'],
          where: { tenantId, createdAt: { gte: monthStart } },
          _count: true,
        }),
      ]);
    const roomCounts = Object.fromEntries(rooms.map((item) => [item.status, item._count]));
    const outstanding =
      Number(pendingPayments._sum.totalAmount ?? 0) - Number(pendingPayments._sum.paidAmount ?? 0);
    return {
      rooms: roomCounts,
      arrivalsToday: arrivals,
      departuresToday: departures,
      pendingPayments: { count: pendingPayments._count, amount: outstanding },
      monthRevenue: Number(monthRevenue._sum.totalAmount ?? 0),
      channels,
    };
  }

  async reservations(tenantId: string) {
    await this.sweepNoShows(tenantId);
    return this.prisma.hotelReservation.findMany({
      where: { tenantId },
      include: reservationInclude,
      orderBy: [{ checkIn: 'asc' }, { createdAt: 'desc' }],
    });
  }

  invoices(tenantId: string) {
    return this.prisma.hotelReservationPayment.findMany({
      where: { tenantId },
      include: {
        tenant: {
          select: {
            name: true,
            commercialName: true,
            legalName: true,
            rnc: true,
            email: true,
            phone: true,
            address: true,
          },
        },
        recordedBy: { select: { id: true, name: true, email: true } },
        reservation: {
          include: {
            tenant: {
              select: {
                name: true,
                commercialName: true,
                legalName: true,
                rnc: true,
                email: true,
                phone: true,
                address: true,
              },
            },
            guest: true,
            roomType: true,
            room: true,
            channel: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  fiscalSequenceValidity(tenantId: string) {
    return this.prisma.fiscalSequence.findMany({
      where: {
        tenantId,
        documentType: {
          in: [InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31, InvoiceDocumentType.CONSUMER_ELECTRONIC_32],
        },
      },
      select: { prefix: true, startNumber: true, endNumber: true, validUntil: true },
    });
  }

  pendingRequests(tenantId: string) {
    return this.prisma.hotelReservation.findMany({
      where: {
        tenantId,
        status: HotelReservationStatus.PENDING_REVIEW,
        channel: { type: HotelChannelType.DIRECT_WEB },
      },
      include: reservationInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  roomTypes(tenantId: string) {
    return this.prisma.hotelRoomType.findMany({
      where: { tenantId },
      orderBy: { baseRate: 'asc' },
    });
  }

  rooms(tenantId: string) {
    return this.prisma.hotelRoom.findMany({
      where: { tenantId },
      include: { roomType: true },
      orderBy: { number: 'asc' },
    });
  }

  /** Habitaciones por limpiar, con la última salida y la próxima llegada (para priorizar). */
  async housekeepingRooms(tenantId: string) {
    const rooms = await this.prisma.hotelRoom.findMany({
      where: {
        tenantId,
        OR: [
          { status: HotelRoomStatus.CLEANING },
          {
            housekeepingStatus: { in: [HousekeepingStatus.DIRTY, HousekeepingStatus.IN_PROGRESS] },
          },
        ],
      },
      include: {
        roomType: true,
        reservations: {
          where: {
            OR: [
              { status: HotelReservationStatus.CHECKED_OUT },
              {
                status: { in: [HotelReservationStatus.CONFIRMED, HotelReservationStatus.ASSIGNED] },
                checkOut: { gt: new Date() },
              },
            ],
          },
          orderBy: { checkIn: 'asc' },
          select: {
            status: true,
            checkIn: true,
            checkOut: true,
            checkedOutAt: true,
            specialRequests: true,
            guest: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    });
    return rooms.map(({ reservations, ...room }) => {
      const departures = reservations
        .filter((item) => item.status === HotelReservationStatus.CHECKED_OUT)
        .sort((a, b) => +(b.checkedOutAt ?? b.checkOut) - +(a.checkedOutAt ?? a.checkOut));
      const next = reservations.find((item) => item.status !== HotelReservationStatus.CHECKED_OUT);
      return {
        ...room,
        lastCheckout: departures[0]
          ? {
              checkOut: departures[0].checkOut,
              checkedOutAt: departures[0].checkedOutAt,
              specialRequests: departures[0].specialRequests,
            }
          : null,
        nextArrival: next
          ? { checkIn: next.checkIn, guest: `${next.guest.firstName} ${next.guest.lastName}`.trim() }
          : null,
      };
    });
  }

  async housekeepingRoom(tenantId: string, id: string) {
    const room = await this.prisma.hotelRoom.findFirst({
      where: {
        id,
        tenantId,
        OR: [
          { status: HotelRoomStatus.CLEANING },
          {
            housekeepingStatus: { in: [HousekeepingStatus.DIRTY, HousekeepingStatus.IN_PROGRESS] },
          },
        ],
      },
      include: {
        roomType: true,
        reservations: {
          where: { status: HotelReservationStatus.CHECKED_OUT },
          orderBy: [{ checkedOutAt: 'desc' }, { checkOut: 'desc' }],
          take: 1,
          select: {
            checkOut: true,
            checkedOutAt: true,
            specialRequests: true,
          },
        },
      },
    });
    if (!room) throw new NotFoundException('Habitación pendiente de limpieza no encontrada.');
    const { reservations, ...details } = room;
    return { ...details, lastCheckout: reservations[0] ?? null };
  }

  /** Edita la ficha del huésped: nombre, teléfono, documento, nacionalidad y notas. */
  async updateGuest(tenantId: string, userId: string, id: string, dto: UpdateHotelGuestDto) {
    const guest = await this.prisma.hotelGuest.findFirst({ where: { id, tenantId } });
    if (!guest) throw new NotFoundException('Huésped no encontrado.');
    const data: Prisma.HotelGuestUpdateInput = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) data.lastName = dto.lastName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (dto.nationality !== undefined) data.nationality = dto.nationality.trim() || null;
    if (dto.notes !== undefined) data.notes = dto.notes.trim() || null;
    if (dto.documentNumber !== undefined) {
      const type = dto.documentType ?? (guest.documentType === DocumentType.PASSPORT ? 'PASSPORT' : 'CEDULA');
      const number =
        type === 'CEDULA' ? dto.documentNumber.replace(/\D/g, '') : dto.documentNumber.replace(/[^\dA-Za-z]/g, '').toUpperCase();
      if (!number) {
        data.documentNumber = null;
        data.documentType = null;
      } else {
        if (type === 'CEDULA' && number.length !== 11)
          throw new BadRequestException('La cédula debe tener 11 dígitos.');
        if (type === 'PASSPORT' && number.length < 5)
          throw new BadRequestException('El pasaporte debe tener al menos 5 caracteres.');
        data.documentNumber = number;
        data.documentType = type === 'CEDULA' ? DocumentType.CEDULA : DocumentType.PASSPORT;
        const duplicate = await this.prisma.hotelGuest.findFirst({
          where: { tenantId, documentType: data.documentType, documentNumber: number, NOT: { id } },
          select: { firstName: true, lastName: true },
        });
        if (duplicate)
          throw new ConflictException(
            `Ese documento ya está registrado para ${duplicate.firstName} ${duplicate.lastName}.`,
          );
      }
    }
    if ((data.firstName as string | undefined) === '' || (data.lastName as string | undefined) === '')
      throw new BadRequestException('El nombre y el apellido son obligatorios.');
    await this.prisma.hotelGuest.update({ where: { id }, data });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_GUEST_UPDATED',
      entity: 'HotelGuest',
      entityId: id,
      metadata: { fields: Object.keys(data) },
    });
    return (await this.guests(tenantId)).find((item) => item.id === id);
  }

  guests(tenantId: string) {
    return this.prisma.hotelGuest.findMany({
      where: { tenantId },
      include: {
        _count: { select: { reservations: true } },
        credits: {
          orderBy: { createdAt: 'desc' },
          include: { sourceReservation: { select: { code: true } } },
        },
        reservations: {
          include: {
            room: { select: { id: true, number: true, floor: true } },
            roomType: { select: { id: true, name: true } },
            channel: { select: { id: true, name: true } },
          },
          orderBy: { checkIn: 'desc' },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  channels(tenantId: string) {
    return this.prisma.hotelChannel.findMany({
      where: { tenantId },
      include: { _count: { select: { reservations: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createChannel(tenantId: string, userId: string, dto: CreateHotelChannelDto) {
    const channel = await this.prisma.hotelChannel.create({
      data: { tenantId, type: dto.type, name: dto.name },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_CHANNEL_CREATED',
      entity: 'HotelChannel',
      entityId: channel.id,
    });
    return channel;
  }

  async createReservation(tenantId: string, userId: string, dto: CreateHotelReservationDto) {
    const checkIn = fixedCheckIn(dto.checkIn);
    const checkOut = fixedCheckOut(dto.checkOut);
    if (checkOut <= checkIn)
      throw new BadRequestException('La fecha de salida debe ser posterior a la llegada.');
    await this.ensureRoomType(tenantId, dto.roomTypeId);
    await this.ensureChannel(tenantId, dto.channelId);
    if (dto.roomId) {
      const room = await this.ensureRoomAvailable(tenantId, dto.roomId, checkIn, checkOut);
      if (room.roomTypeId !== dto.roomTypeId)
        throw new BadRequestException('La habitación no corresponde al tipo seleccionado.');
    }

    const guestFilters: Prisma.HotelGuestWhereInput[] = [];
    if (dto.documentType && dto.documentNumber)
      guestFilters.push({ documentType: dto.documentType, documentNumber: dto.documentNumber });
    if (dto.email) guestFilters.push({ email: dto.email });
    const existingGuest = dto.guestId
      ? await this.prisma.hotelGuest.findFirst({ where: { id: dto.guestId, tenantId } })
      : guestFilters.length
        ? await this.prisma.hotelGuest.findFirst({ where: { tenantId, OR: guestFilters } })
        : null;
    if (dto.guestId && !existingGuest)
      throw new BadRequestException('El cliente registrado no pertenece a este hotel.');
    const guest = existingGuest
      ? await this.prisma.hotelGuest.update({
          where: { id: existingGuest.id },
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phone: dto.phone,
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
          },
        })
      : await this.prisma.hotelGuest.create({
          data: {
            tenantId,
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phone: dto.phone,
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
          },
        });
    const roomType = await this.prisma.hotelRoomType.findFirstOrThrow({
      where: { id: dto.roomTypeId, tenantId },
      select: { name: true },
    });
    const reservation = await this.prisma.$transaction(async (tx) => {
      // Mismo bloqueo que el canal web: el inventario se verifica y se reserva de forma atómica.
      await lockHotelReservations(tx, tenantId);
      if ((await availableRoomsForStay(tx, tenantId, dto.roomTypeId, checkIn, checkOut)) < 1)
        throw new BadRequestException(
          `No quedan habitaciones ${roomType.name} disponibles para esas fechas.`,
        );
      const code = await nextReservationCode(tx, tenantId);
      const created = await tx.hotelReservation.create({
        data: {
          tenantId,
          code,
          guestId: guest.id,
          roomTypeId: dto.roomTypeId,
          roomId: dto.roomId,
          channelId: dto.channelId,
          status: dto.roomId
            ? HotelReservationStatus.ASSIGNED
            : HotelReservationStatus.PENDING_REVIEW,
          checkIn,
          checkOut,
          adults: dto.adults,
          children: dto.children ?? 0,
          totalAmount: new Prisma.Decimal(dto.totalAmount),
          specialRequests: dto.specialRequests,
        },
        include: reservationInclude,
      });
      if (dto.roomId)
        await tx.hotelRoom.update({
          where: { id: dto.roomId },
          data: { status: HotelRoomStatus.RESERVED },
        });
      return created;
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_RESERVATION_CREATED',
      entity: 'HotelReservation',
      entityId: reservation.id,
      metadata: { code: reservation.code, channelId: dto.channelId },
    });
    return reservation;
  }

  /**
   * Edita una reservación antes del check-in: huésped, fechas, tipo, habitación, canal, ocupación y monto.
   * La disponibilidad se verifica de nuevo (sin contar la propia reservación) bajo el mismo bloqueo que la
   * creación, así una edición tampoco puede sobrevender ni solapar habitaciones.
   */
  async updateReservation(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateHotelReservationDto,
  ) {
    const current = await this.prisma.hotelReservation.findFirst({
      where: { id, tenantId },
      include: { guest: true },
    });
    if (!current) throw new NotFoundException('Reservación no encontrada.');
    const editable: HotelReservationStatus[] = [
      HotelReservationStatus.PENDING_REVIEW,
      HotelReservationStatus.CONFIRMED,
      HotelReservationStatus.ASSIGNED,
    ];
    if (!editable.includes(current.status))
      throw new BadRequestException('Solo se pueden editar reservaciones antes del check-in.');

    const checkIn = dto.checkIn ? fixedCheckIn(dto.checkIn) : current.checkIn;
    const checkOut = dto.checkOut ? fixedCheckOut(dto.checkOut) : current.checkOut;
    if (checkOut <= checkIn)
      throw new BadRequestException('La fecha de salida debe ser posterior a la llegada.');
    const roomTypeId = dto.roomTypeId ?? current.roomTypeId;
    const roomType = await this.prisma.hotelRoomType.findFirst({ where: { id: roomTypeId, tenantId } });
    if (!roomType) throw new NotFoundException('Tipo de habitación no encontrado.');
    if (dto.channelId) await this.ensureChannel(tenantId, dto.channelId);
    const adults = dto.adults ?? current.adults;
    const children = dto.children ?? current.children;
    if (adults > roomType.capacityAdults || children > roomType.capacityChildren)
      throw new BadRequestException(
        `${roomType.name} admite hasta ${roomType.capacityAdults} adultos y ${roomType.capacityChildren} niños.`,
      );

    // Habitación: si cambia el tipo y no se indica otra, la asignada deja de servir.
    let roomId: string | null =
      dto.roomId === undefined ? current.roomId : dto.roomId === '' ? null : dto.roomId;
    if (roomId && dto.roomId === undefined && dto.roomTypeId && dto.roomTypeId !== current.roomTypeId)
      roomId = null;
    if (roomId) {
      const room = await this.ensureRoomAvailable(tenantId, roomId, checkIn, checkOut, id);
      if (room.roomTypeId !== roomTypeId)
        throw new BadRequestException('La habitación no corresponde al tipo seleccionado.');
    }

    const totalAmount = dto.totalAmount ?? Number(current.totalAmount);
    const paid = Number(current.paidAmount);
    if (totalAmount + 0.001 < paid)
      throw new BadRequestException(
        'El nuevo monto no puede ser menor a lo ya pagado. Registra un reembolso primero.',
      );
    const paymentStatus =
      paid <= 0
        ? HotelPaymentStatus.PENDING
        : paid + 0.001 >= totalAmount
          ? HotelPaymentStatus.PAID
          : HotelPaymentStatus.PARTIAL;
    let status = current.status;
    if (roomId && status !== HotelReservationStatus.PENDING_REVIEW) status = HotelReservationStatus.ASSIGNED;
    if (!roomId && status === HotelReservationStatus.ASSIGNED) status = HotelReservationStatus.CONFIRMED;

    const updated = await this.prisma.$transaction(async (tx) => {
      await lockHotelReservations(tx, tenantId);
      if ((await availableRoomsForStay(tx, tenantId, roomTypeId, checkIn, checkOut, id)) < 1)
        throw new BadRequestException(
          `No quedan habitaciones ${roomType.name} disponibles para esas fechas.`,
        );

      const guestData: Prisma.HotelGuestUpdateInput = {};
      if (dto.firstName?.trim()) guestData.firstName = dto.firstName.trim();
      if (dto.lastName?.trim()) guestData.lastName = dto.lastName.trim();
      if (dto.email !== undefined) guestData.email = dto.email.trim() || null;
      if (dto.phone !== undefined) guestData.phone = dto.phone.trim() || null;
      if (dto.documentType !== undefined) guestData.documentType = dto.documentType;
      if (dto.documentNumber !== undefined)
        guestData.documentNumber = dto.documentNumber.replace(/[^\dA-Za-z]/g, '') || null;
      if (Object.keys(guestData).length)
        await tx.hotelGuest.update({ where: { id: current.guestId }, data: guestData });

      if (current.roomId && current.roomId !== roomId)
        await tx.hotelRoom.updateMany({
          where: { id: current.roomId, status: HotelRoomStatus.RESERVED },
          data: { status: HotelRoomStatus.AVAILABLE },
        });
      if (roomId && roomId !== current.roomId)
        await tx.hotelRoom.updateMany({
          where: { id: roomId, status: HotelRoomStatus.AVAILABLE },
          data: { status: HotelRoomStatus.RESERVED },
        });

      return tx.hotelReservation.update({
        where: { id },
        data: {
          roomTypeId,
          roomId,
          channelId: dto.channelId ?? undefined,
          checkIn,
          checkOut,
          adults,
          children,
          totalAmount: new Prisma.Decimal(totalAmount),
          paymentStatus,
          status,
          specialRequests:
            dto.specialRequests === undefined ? undefined : dto.specialRequests.trim() || null,
          arrivalTime: dto.arrivalTime === undefined ? undefined : dto.arrivalTime.trim() || null,
          // Una recuperada que cambia de fecha vuelve a la regla normal de las 9:00 PM.
          noShowRecoveredAt:
            hotelDateKey(checkIn) !== hotelDateKey(current.checkIn) ? null : undefined,
        },
        include: reservationInclude,
      });
    });

    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_RESERVATION_UPDATED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: {
        before: {
          roomTypeId: current.roomTypeId,
          roomId: current.roomId,
          checkIn: current.checkIn,
          checkOut: current.checkOut,
          adults: current.adults,
          children: current.children,
          totalAmount: Number(current.totalAmount),
        },
        changes: JSON.parse(JSON.stringify(dto)),
      },
    });
    return updated;
  }

  /**
   * Aplica el crédito a favor del huésped como pago de esta reservación (los créditos más antiguos
   * primero, hasta cubrir el balance). Queda registrado como un pago con su comprobante CR-.
   */
  async applyGuestCredit(tenantId: string, userId: string, id: string) {
    const reservation = await this.findReservation(tenantId, id);
    const blocked: HotelReservationStatus[] = [
      HotelReservationStatus.CANCELLED,
      HotelReservationStatus.CHECKED_OUT,
      HotelReservationStatus.NO_SHOW,
    ];
    if (blocked.includes(reservation.status))
      throw new BadRequestException('Esta reservación ya no admite pagos.');
    const total = Number(reservation.totalAmount);
    const paid = Number(reservation.paidAmount);
    const balance = Math.round((total - paid) * 100) / 100;
    if (balance <= 0) throw new BadRequestException('La reservación no tiene balance pendiente.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const credits = await tx.hotelGuestCredit.findMany({
        where: { tenantId, guestId: reservation.guestId, remainingAmount: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
        include: { sourceReservation: { select: { code: true } } },
      });
      let pending = balance;
      const used: string[] = [];
      for (const credit of credits) {
        if (pending <= 0) break;
        const take = Math.min(pending, Number(credit.remainingAmount));
        // Solo descuenta si nadie más tomó ese crédito al mismo tiempo.
        const claimed = await tx.hotelGuestCredit.updateMany({
          where: { id: credit.id, remainingAmount: credit.remainingAmount },
          data: { remainingAmount: { decrement: new Prisma.Decimal(take) } },
        });
        if (claimed.count !== 1) continue;
        pending = Math.round((pending - take) * 100) / 100;
        used.push(`${credit.sourceReservation?.code ?? 'crédito'} (${take.toFixed(2)})`);
      }
      const applied = Math.round((balance - pending) * 100) / 100;
      if (applied <= 0) throw new BadRequestException('El huésped no tiene crédito disponible.');
      const previous = await tx.hotelReservationPayment.count({
        where: { tenantId, reservationId: id, receiptNumber: { startsWith: 'CR-' } },
      });
      await tx.hotelReservationPayment.create({
        data: {
          tenantId,
          reservationId: id,
          recordedById: userId,
          amount: new Prisma.Decimal(applied),
          method: PaymentMethod.OTHER,
          billingDocumentType: HotelBillingDocumentType.SALE_NOTE,
          receiptNumber: `CR-${reservation.code}${previous ? `-${previous + 1}` : ''}`,
          reference: 'Crédito a favor',
          notes: `Crédito aplicado de: ${used.join(', ')}`,
        },
      });
      const newPaid = paid + applied;
      return tx.hotelReservation.update({
        where: { id },
        data: {
          paidAmount: new Prisma.Decimal(newPaid),
          paymentStatus: newPaid + 0.001 >= total ? HotelPaymentStatus.PAID : HotelPaymentStatus.PARTIAL,
        },
        include: reservationInclude,
      });
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_GUEST_CREDIT_APPLIED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: { paidAfter: Number(updated.paidAmount) },
    });
    return updated;
  }

  async assignRoom(tenantId: string, userId: string, id: string, dto: AssignHotelRoomDto) {
    const reservation = await this.findReservation(tenantId, id);
    if (
      (
        [
          HotelReservationStatus.CHECKED_IN,
          HotelReservationStatus.CHECKED_OUT,
          HotelReservationStatus.CANCELLED,
        ] as HotelReservationStatus[]
      ).includes(reservation.status)
    ) {
      throw new BadRequestException('La reservación ya no permite cambiar de habitación.');
    }
    const room = await this.ensureRoomAvailable(
      tenantId,
      dto.roomId,
      reservation.checkIn,
      reservation.checkOut,
      id,
    );
    if (room.roomTypeId !== reservation.roomTypeId)
      throw new BadRequestException('La habitación no corresponde al tipo reservado.');
    const updated = await this.prisma.$transaction(async (tx) => {
      if (reservation.roomId && reservation.roomId !== dto.roomId) {
        await tx.hotelRoom.update({
          where: { id: reservation.roomId },
          data: { status: HotelRoomStatus.AVAILABLE },
        });
      }
      await tx.hotelRoom.update({
        where: { id: dto.roomId },
        data: { status: HotelRoomStatus.RESERVED },
      });
      return tx.hotelReservation.update({
        where: { id },
        data: { roomId: dto.roomId, status: HotelReservationStatus.ASSIGNED },
        include: reservationInclude,
      });
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_ROOM_ASSIGNED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: { roomId: dto.roomId },
    });
    return updated;
  }

  async updateStatus(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateHotelReservationStatusDto,
  ) {
    const reservation = await this.findReservation(tenantId, id);
    this.validateStatusTransition(reservation.status, dto.status);
    if (dto.status === HotelReservationStatus.CHECKED_IN) {
      // El huésped puede pagar al llegar o al final (check-out); recepción lo elige al hacer el check-in.
      if (Number(reservation.paidAmount) + 0.001 < Number(reservation.totalAmount) && !dto.payLater)
        throw new BadRequestException(
          'Registra el pago ahora o indica que el huésped pagará al final.',
        );
      if (!reservation.roomId)
        throw new BadRequestException('Asigna una habitación antes de registrar el check-in.');
      const room = await this.prisma.hotelRoom.findFirst({
        where: { id: reservation.roomId, tenantId },
      });
      if (!room || room.housekeepingStatus !== HousekeepingStatus.CLEAN)
        throw new BadRequestException('La habitación debe estar limpia antes del check-in.');
    }
    if (
      dto.status === HotelReservationStatus.CHECKED_OUT &&
      Number(reservation.paidAmount) < Number(reservation.totalAmount)
    ) {
      throw new BadRequestException('La reservación tiene un balance pendiente.');
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.HotelReservationUpdateInput = { status: dto.status };
      if (dto.status === HotelReservationStatus.CHECKED_IN) data.checkedInAt = now;
      if (dto.status === HotelReservationStatus.CHECKED_OUT) data.checkedOutAt = now;
      if (dto.status === HotelReservationStatus.CANCELLED) data.cancelledAt = now;
      if (dto.status === HotelReservationStatus.CHECKED_OUT && dto.grantCredit !== false) {
        const credit = earlyCheckoutCredit(reservation, now);
        if (credit)
          await tx.hotelGuestCredit.create({
            data: {
              tenantId,
              guestId: reservation.guestId,
              sourceReservationId: reservation.id,
              nights: credit.nights,
              amount: new Prisma.Decimal(credit.amount),
              remainingAmount: new Prisma.Decimal(credit.amount),
              reason: `Check-out anticipado de ${reservation.code}: ${credit.nights} ${credit.nights === 1 ? 'noche no usada' : 'noches no usadas'}.`,
              createdById: userId,
            },
          });
      }
      const value = await tx.hotelReservation.update({
        where: { id },
        data,
        include: reservationInclude,
      });
      if (reservation.roomId) {
        if (dto.status === HotelReservationStatus.CHECKED_IN) {
          await tx.hotelRoom.update({
            where: { id: reservation.roomId },
            data: { status: HotelRoomStatus.OCCUPIED },
          });
        } else if (dto.status === HotelReservationStatus.CHECKED_OUT) {
          await tx.hotelRoom.update({
            where: { id: reservation.roomId },
            data: {
              status: HotelRoomStatus.CLEANING,
              housekeepingStatus: HousekeepingStatus.DIRTY,
            },
          });
        } else if (dto.status === HotelReservationStatus.CANCELLED) {
          await tx.hotelRoom.update({
            where: { id: reservation.roomId },
            data: { status: HotelRoomStatus.AVAILABLE },
          });
        }
      }
      return value;
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_RESERVATION_STATUS_UPDATED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: { from: reservation.status, to: dto.status, payLater: dto.payLater || undefined },
    });
    return updated;
  }

  async recordPayment(tenantId: string, userId: string, id: string, dto: RecordHotelPaymentDto) {
    const reservation = await this.findReservation(tenantId, id);
    if (reservation.status === HotelReservationStatus.CANCELLED)
      throw new BadRequestException('No se puede cobrar una reservación cancelada.');
    const total = Number(reservation.totalAmount);
    const paid = Number(reservation.paidAmount);
    const balance = total - paid;
    if (hotelDateKey(new Date()) < hotelDateKey(reservation.checkIn))
      throw new BadRequestException(
        'El pago solo puede registrarse el día de llegada. No se aceptan pagos por adelantado.',
      );
    if (Math.abs(dto.amount - balance) > 0.001)
      throw new BadRequestException('El pago debe completar el balance pendiente.');
    if (
      dto.method === PaymentMethod.CASH &&
      (dto.cashReceived === undefined || dto.cashReceived + 0.001 < balance)
    )
      throw new BadRequestException(
        'Indica un monto recibido en efectivo igual o mayor al balance pendiente.',
      );
    const allowedDocuments: Partial<Record<PaymentMethod, HotelBillingDocumentType[]>> = {
      [PaymentMethod.CASH]: [HotelBillingDocumentType.SALE_NOTE, HotelBillingDocumentType.E31],
      [PaymentMethod.TRANSFER]: [
        HotelBillingDocumentType.SALE_NOTE,
        HotelBillingDocumentType.E31,
        HotelBillingDocumentType.E32,
      ],
      [PaymentMethod.CARD]: [HotelBillingDocumentType.E31, HotelBillingDocumentType.E32],
    };
    if (!allowedDocuments[dto.method]?.includes(dto.billingDocumentType))
      throw new BadRequestException(
        'El tipo de comprobante no está permitido para el método de pago seleccionado.',
      );
    if (dto.billingDocumentType === HotelBillingDocumentType.E31) {
      if (
        (dto.fiscalDocumentType !== DocumentType.RNC &&
          dto.fiscalDocumentType !== DocumentType.CEDULA) ||
        !dto.fiscalDocumentNumber?.trim()
      )
        throw new BadRequestException('La factura E31 requiere cédula o RNC.');
      if (!validateDominicanDocument(dto.fiscalDocumentType, dto.fiscalDocumentNumber))
        throw new BadRequestException('La cédula o el RNC no es válido.');
    }
    const cashReceived = dto.method === PaymentMethod.CASH ? dto.cashReceived! : undefined;
    const changeAmount =
      cashReceived === undefined ? undefined : Math.round((cashReceived - balance) * 100) / 100;
    const newPaid = paid + dto.amount;
    const paymentStatus = newPaid >= total ? HotelPaymentStatus.PAID : HotelPaymentStatus.PARTIAL;
    const updated = await this.prisma.$transaction(async (tx) => {
      const receiptNumber = await this.nextHotelReceiptNumber(
        tx,
        tenantId,
        reservation.code,
        dto.billingDocumentType,
      );
      await tx.hotelReservationPayment.create({
        data: {
          tenantId,
          reservationId: id,
          recordedById: userId,
          amount: new Prisma.Decimal(dto.amount),
          cashReceived: cashReceived === undefined ? undefined : new Prisma.Decimal(cashReceived),
          changeAmount: changeAmount === undefined ? undefined : new Prisma.Decimal(changeAmount),
          method: dto.method,
          billingDocumentType: dto.billingDocumentType,
          fiscalDocumentType:
            dto.billingDocumentType === HotelBillingDocumentType.E31
              ? dto.fiscalDocumentType
              : undefined,
          fiscalDocumentNumber:
            dto.billingDocumentType === HotelBillingDocumentType.E31
              ? dto.fiscalDocumentNumber?.replace(/\D/g, '')
              : undefined,
          receiptNumber,
          reference: dto.reference?.trim() || undefined,
          notes: dto.notes,
        },
      });
      return tx.hotelReservation.update({
        where: { id },
        data: { paidAmount: new Prisma.Decimal(newPaid), paymentStatus },
        include: reservationInclude,
      });
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_PAYMENT_RECORDED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: {
        amount: dto.amount,
        cashReceived,
        changeAmount,
        method: dto.method,
        billingDocumentType: dto.billingDocumentType,
        fiscalDocumentType: dto.fiscalDocumentType,
        reference: dto.reference,
        notes: dto.notes,
        balanceAfter: Math.max(0, total - newPaid),
      },
    });
    return updated;
  }

  private async nextHotelReceiptNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    reservationCode: string,
    billingDocumentType: HotelBillingDocumentType,
  ) {
    if (billingDocumentType === HotelBillingDocumentType.SALE_NOTE) {
      return `NV-${reservationCode}`;
    }
    const documentType =
      billingDocumentType === HotelBillingDocumentType.E31
        ? InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31
        : InvoiceDocumentType.CONSUMER_ELECTRONIC_32;
    const reserved = await this.reserveHotelFiscalSequence(tx, tenantId, documentType);
    return `${reserved.prefix}${String(reserved.number).padStart(10, '0')}`;
  }

  private async reserveHotelFiscalSequence(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentType: InvoiceDocumentType,
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = new Date();
      await tx.fiscalSequence.updateMany({
        where: {
          tenantId,
          documentType,
          status: FiscalSequenceStatus.ACTIVE,
          validUntil: { lt: now },
        },
        data: { status: FiscalSequenceStatus.EXPIRED },
      });
      const sequence = await tx.fiscalSequence.findFirst({
        where: {
          tenantId,
          documentType,
          status: FiscalSequenceStatus.ACTIVE,
          OR: [{ validUntil: null }, { validUntil: { gte: now } }],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!sequence) {
        const nextBlock = await tx.fiscalSequence.findFirst({
          where: {
            tenantId,
            documentType,
            status: FiscalSequenceStatus.INACTIVE,
            OR: [{ validUntil: null }, { validUntil: { gte: now } }],
          },
          orderBy: { createdAt: 'asc' },
        });
        if (nextBlock) {
          const activated = await tx.fiscalSequence.updateMany({
            where: { id: nextBlock.id, status: FiscalSequenceStatus.INACTIVE },
            data: { status: FiscalSequenceStatus.ACTIVE },
          });
          if (activated.count === 1) continue;
        }
        throw new BadRequestException(
          'No hay una secuencia fiscal activa para este comprobante. Registra un bloque en Secuencias fiscales.',
        );
      }
      if (sequence.nextNumber > sequence.endNumber) {
        await tx.fiscalSequence.updateMany({
          where: { id: sequence.id, status: FiscalSequenceStatus.ACTIVE },
          data: { status: FiscalSequenceStatus.EXHAUSTED },
        });
        continue;
      }
      const reserved = await tx.fiscalSequence.updateMany({
        where: {
          id: sequence.id,
          nextNumber: sequence.nextNumber,
          status: FiscalSequenceStatus.ACTIVE,
        },
        data: {
          nextNumber: { increment: 1 },
          ...(sequence.nextNumber >= sequence.endNumber
            ? { status: FiscalSequenceStatus.EXHAUSTED }
            : {}),
        },
      });
      if (reserved.count === 1) return { prefix: sequence.prefix, number: sequence.nextNumber };
    }
    throw new BadRequestException('No se pudo reservar la secuencia fiscal.');
  }

  async updateRoomState(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateHotelRoomStateDto,
  ) {
    if (!dto.status && !dto.housekeepingStatus)
      throw new BadRequestException('Indica el estado operativo o de limpieza.');
    const room = await this.prisma.hotelRoom.findFirst({ where: { id, tenantId } });
    if (!room) throw new NotFoundException('Habitación no encontrada.');
    const resultingStatus = dto.status ?? room.status;
    const resultingHousekeeping = dto.housekeepingStatus ?? room.housekeepingStatus;
    if (
      resultingStatus === HotelRoomStatus.AVAILABLE &&
      resultingHousekeeping !== HousekeepingStatus.CLEAN
    ) {
      throw new BadRequestException('Una habitación disponible debe estar limpia.');
    }
    if (resultingStatus === HotelRoomStatus.AVAILABLE) {
      const activeStay = await this.prisma.hotelReservation.findFirst({
        where: {
          tenantId,
          roomId: id,
          status: {
            in: [
              HotelReservationStatus.PENDING_REVIEW,
              HotelReservationStatus.CONFIRMED,
              HotelReservationStatus.ASSIGNED,
              HotelReservationStatus.CHECKED_IN,
            ],
          },
        },
      });
      if (activeStay) throw new BadRequestException('La habitación tiene una reservación activa.');
    }
    const updated = await this.prisma.hotelRoom.update({
      where: { id },
      data: { status: dto.status, housekeepingStatus: dto.housekeepingStatus },
      include: { roomType: true },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_ROOM_STATE_UPDATED',
      entity: 'HotelRoom',
      entityId: id,
      metadata: { status: dto.status, housekeepingStatus: dto.housekeepingStatus },
    });
    return updated;
  }

  async confirmCleaning(tenantId: string, userId: string, id: string) {
    const room = await this.prisma.hotelRoom.findFirst({ where: { id, tenantId } });
    if (!room) throw new NotFoundException('Habitación no encontrada.');
    if (
      room.status !== HotelRoomStatus.CLEANING &&
      room.housekeepingStatus !== HousekeepingStatus.DIRTY &&
      room.housekeepingStatus !== HousekeepingStatus.IN_PROGRESS
    ) {
      throw new BadRequestException('La habitación no está pendiente de limpieza.');
    }
    const updated = await this.prisma.hotelRoom.update({
      where: { id },
      data: {
        status: HotelRoomStatus.AVAILABLE,
        housekeepingStatus: HousekeepingStatus.CLEAN,
      },
      include: { roomType: true },
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_ROOM_CLEANING_CONFIRMED',
      entity: 'HotelRoom',
      entityId: id,
      metadata: {
        previousStatus: room.status,
        previousHousekeepingStatus: room.housekeepingStatus,
      },
    });
    return updated;
  }

  /**
   * Inasistidas: a las 9:00 PM del día de llegada, una reservación sin check-in pasa a NO_SHOW (libera su
   * habitación y su cupo en el calendario). Se pueden recuperar durante 24 h; luego se borran solas, salvo
   * que tengan un cobro hecho en recepción (eso nunca se borra de forma automática).
   */
  async sweepNoShows(tenantId: string, force = false) {
    const now = new Date();
    if (!force && now.getTime() - (this.lastSweep.get(tenantId) ?? 0) < 30_000) return;
    this.lastSweep.set(tenantId, now.getTime());
    try {
      const candidates = await this.prisma.hotelReservation.findMany({
        where: {
          tenantId,
          status: { in: BEFORE_CHECK_IN },
          noShowRecoveredAt: null,
          checkIn: { lt: now },
        },
        select: { id: true, code: true, checkIn: true, roomId: true },
      });
      const late = candidates.filter(
        (item) => now >= hotelInstant(hotelDateKey(item.checkIn), NO_SHOW_HOUR),
      );
      for (const item of late) {
        await this.prisma.$transaction(async (tx) => {
          const moved = await tx.hotelReservation.updateMany({
            where: { id: item.id, status: { in: BEFORE_CHECK_IN }, noShowRecoveredAt: null },
            data: { status: HotelReservationStatus.NO_SHOW, noShowAt: now },
          });
          if (moved.count && item.roomId) await this.releaseRoom(tx, tenantId, item.roomId, item.id);
        });
        await this.audit.log({
          tenantId,
          action: 'HOTEL_RESERVATION_NO_SHOW',
          entity: 'HotelReservation',
          entityId: item.id,
          metadata: { code: item.code, automatic: true },
        });
      }
      const expired = await this.prisma.hotelReservation.findMany({
        where: {
          tenantId,
          status: HotelReservationStatus.NO_SHOW,
          noShowAt: { lt: new Date(now.getTime() - NO_SHOW_RETENTION_MS) },
        },
        select: { id: true, code: true, payments: { select: { notes: true, method: true } } },
      });
      for (const item of expired) {
        if (!item.payments.every(isOnlinePayment)) continue;
        await this.prisma.$transaction([
          this.prisma.hotelReservationPayment.deleteMany({ where: { reservationId: item.id } }),
          this.prisma.hotelReservation.delete({ where: { id: item.id } }),
        ]);
        await this.audit.log({
          tenantId,
          action: 'HOTEL_RESERVATION_DELETED',
          entity: 'HotelReservation',
          entityId: item.id,
          metadata: { code: item.code, reason: 'Inasistida por más de 24 horas', automatic: true },
        });
      }
    } catch (error) {
      // El barrido nunca debe tumbar la consulta de reservaciones.
      this.logger.error(`No se pudo procesar las inasistidas: ${String(error)}`);
    }
  }

  /** Devuelve una inasistida a las llegadas (si todavía hay cupo para sus fechas). */
  async recoverNoShow(tenantId: string, userId: string, id: string) {
    const reservation = await this.findReservation(tenantId, id);
    if (reservation.status !== HotelReservationStatus.NO_SHOW)
      throw new BadRequestException('Solo se pueden recuperar reservaciones inasistidas.');
    if (hotelDateKey(reservation.checkOut) <= hotelDateKey(new Date()))
      throw new BadRequestException(
        'La fecha de salida ya pasó. Crea una reservación nueva con las fechas correctas.',
      );
    let roomId = reservation.roomId;
    if (roomId) {
      try {
        await this.ensureRoomAvailable(tenantId, roomId, reservation.checkIn, reservation.checkOut, id);
      } catch {
        // La habitación ya se vendió a otro huésped: vuelve sin habitación y se asigna otra.
        roomId = null;
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockHotelReservations(tx, tenantId);
      const free = await availableRoomsForStay(
        tx,
        tenantId,
        reservation.roomTypeId,
        reservation.checkIn,
        reservation.checkOut,
        id,
      );
      if (free < 1)
        throw new BadRequestException(
          'Ya no queda cupo de ese tipo de habitación para esas fechas. Crea una reservación nueva.',
        );
      if (roomId)
        await tx.hotelRoom.updateMany({
          where: { id: roomId, status: HotelRoomStatus.AVAILABLE },
          data: { status: HotelRoomStatus.RESERVED },
        });
      return tx.hotelReservation.update({
        where: { id },
        data: {
          status: roomId ? HotelReservationStatus.ASSIGNED : HotelReservationStatus.CONFIRMED,
          roomId,
          noShowAt: null,
          noShowRecoveredAt: new Date(),
        },
        include: reservationInclude,
      });
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_RESERVATION_RECOVERED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: { code: reservation.code, keptRoom: Boolean(roomId) },
    });
    return updated;
  }

  /** Elimina una reservación antes del check-in (admin o recepción). Un cobro de recepción lo impide. */
  async deleteReservation(tenantId: string, userId: string, id: string) {
    const reservation = await this.prisma.hotelReservation.findFirst({
      where: { id, tenantId },
      include: { payments: { select: { notes: true, method: true } }, guest: true },
    });
    if (!reservation) throw new NotFoundException('Reservación no encontrada.');
    const deletable: HotelReservationStatus[] = [
      ...BEFORE_CHECK_IN,
      HotelReservationStatus.NO_SHOW,
      HotelReservationStatus.CANCELLED,
    ];
    if (!deletable.includes(reservation.status))
      throw new BadRequestException('Solo se pueden eliminar reservaciones antes del check-in.');
    if (!reservation.payments.every(isOnlinePayment))
      throw new BadRequestException(
        'Esta reservación ya tiene un cobro registrado en recepción y su factura no se puede borrar.',
      );
    await this.prisma.$transaction(async (tx) => {
      if (reservation.roomId) await this.releaseRoom(tx, tenantId, reservation.roomId, id);
      await tx.hotelReservationPayment.deleteMany({ where: { reservationId: id } });
      await tx.hotelReservation.delete({ where: { id } });
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_RESERVATION_DELETED',
      entity: 'HotelReservation',
      entityId: id,
      metadata: {
        code: reservation.code,
        status: reservation.status,
        guest: `${reservation.guest.firstName} ${reservation.guest.lastName}`.trim(),
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        totalAmount: Number(reservation.totalAmount),
      },
    });
    return { id, deleted: true };
  }

  /**
   * Pago Express: factura rápida (sin reservación) con cédula/RNC, nombre, descripción y monto total.
   * El total incluye el ITBIS; el comprobante lo desglosa.
   */
  async createExpressInvoice(tenantId: string, userId: string, dto: CreateHotelExpressInvoiceDto) {
    const documentNumber = dto.documentNumber.replace(/\D/g, '');
    const documentType = dto.documentType === 'RNC' ? DocumentType.RNC : DocumentType.CEDULA;
    if (!validateDominicanDocument(documentType, documentNumber))
      throw new BadRequestException('La cédula o el RNC no es válido.');
    const amount = Math.round(dto.amount * 100) / 100;
    const allowed: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER];
    if (!allowed.includes(dto.method)) throw new BadRequestException('Método de pago no válido.');
    if (dto.method === PaymentMethod.CASH && (dto.cashReceived ?? 0) + 0.001 < amount)
      throw new BadRequestException('El efectivo recibido debe cubrir el total.');
    const cashReceived = dto.method === PaymentMethod.CASH ? dto.cashReceived! : undefined;
    const changeAmount =
      cashReceived === undefined ? undefined : Math.round((cashReceived - amount) * 100) / 100;
    const billingDocumentType =
      dto.billingDocumentType === 'E32' ? HotelBillingDocumentType.E32 : HotelBillingDocumentType.E31;
    const payment = await this.prisma.$transaction(async (tx) => {
      const receiptNumber = await this.nextHotelReceiptNumber(tx, tenantId, '', billingDocumentType);
      return tx.hotelReservationPayment.create({
        data: {
          tenantId,
          recordedById: userId,
          amount: new Prisma.Decimal(amount),
          cashReceived: cashReceived === undefined ? undefined : new Prisma.Decimal(cashReceived),
          changeAmount: changeAmount === undefined ? undefined : new Prisma.Decimal(changeAmount),
          method: dto.method,
          billingDocumentType,
          fiscalDocumentType: documentType,
          fiscalDocumentNumber: documentNumber,
          receiptNumber,
          reference: dto.reference?.trim() || undefined,
          customerName: dto.customerName.trim(),
          customerPhone: dto.customerPhone?.trim() || undefined,
          description: dto.description.trim(),
          notes: 'Pago Express',
        },
        include: {
          tenant: { select: tenantInvoiceSelect },
          recordedBy: { select: { id: true, name: true, email: true } },
          reservation: true,
        },
      });
    });
    await this.audit.log({
      tenantId,
      userId,
      action: 'HOTEL_EXPRESS_INVOICE_CREATED',
      entity: 'HotelReservationPayment',
      entityId: payment.id,
      metadata: { receiptNumber: payment.receiptNumber, amount, method: dto.method, billingDocumentType },
    });
    return payment;
  }

  /** Libera la habitación reservada si ninguna otra reservación activa la tiene asignada. */
  private async releaseRoom(
    tx: Prisma.TransactionClient,
    tenantId: string,
    roomId: string,
    exceptId: string,
  ) {
    const other = await tx.hotelReservation.count({
      where: {
        tenantId,
        roomId,
        id: { not: exceptId },
        status: { in: [HotelReservationStatus.ASSIGNED, HotelReservationStatus.CHECKED_IN] },
      },
    });
    if (!other)
      await tx.hotelRoom.updateMany({
        where: { id: roomId, status: HotelRoomStatus.RESERVED },
        data: { status: HotelRoomStatus.AVAILABLE },
      });
  }

  private async findReservation(tenantId: string, id: string) {
    const value = await this.prisma.hotelReservation.findFirst({ where: { id, tenantId } });
    if (!value) throw new NotFoundException('Reservación no encontrada.');
    return value;
  }

  private async ensureRoomType(tenantId: string, id: string) {
    if (!(await this.prisma.hotelRoomType.findFirst({ where: { id, tenantId } })))
      throw new NotFoundException('Tipo de habitación no encontrado.');
  }

  private async ensureChannel(tenantId: string, id: string) {
    if (!(await this.prisma.hotelChannel.findFirst({ where: { id, tenantId, active: true } })))
      throw new NotFoundException('Canal de reservación no encontrado o inactivo.');
  }

  private async ensureRoomAvailable(
    tenantId: string,
    roomId: string,
    checkIn: Date,
    checkOut: Date,
    excludeId?: string,
  ) {
    const room = await this.prisma.hotelRoom.findFirst({ where: { id: roomId, tenantId } });
    if (!room) throw new NotFoundException('Habitación no encontrada.');
    if (
      room.status === HotelRoomStatus.MAINTENANCE ||
      room.status === HotelRoomStatus.OUT_OF_SERVICE
    )
      throw new BadRequestException('La habitación no está disponible para asignación.');
    const overlap = await this.prisma.hotelReservation.findFirst({
      where: {
        tenantId,
        roomId,
        id: excludeId ? { not: excludeId } : undefined,
        status: {
          notIn: [
            HotelReservationStatus.CANCELLED,
            HotelReservationStatus.NO_SHOW,
            HotelReservationStatus.CHECKED_OUT,
          ],
        },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
    });
    if (overlap) throw new BadRequestException('La habitación ya está asignada en esas fechas.');
    return room;
  }

  private validateStatusTransition(current: HotelReservationStatus, next: HotelReservationStatus) {
    if (current === next) return;
    const allowed: Partial<Record<HotelReservationStatus, HotelReservationStatus[]>> = {
      [HotelReservationStatus.PENDING_REVIEW]: [
        HotelReservationStatus.CONFIRMED,
        HotelReservationStatus.ASSIGNED,
        HotelReservationStatus.CHECKED_IN,
        HotelReservationStatus.CANCELLED,
      ],
      [HotelReservationStatus.CONFIRMED]: [
        HotelReservationStatus.ASSIGNED,
        HotelReservationStatus.CHECKED_IN,
        HotelReservationStatus.CANCELLED,
      ],
      [HotelReservationStatus.ASSIGNED]: [
        HotelReservationStatus.CONFIRMED,
        HotelReservationStatus.CHECKED_IN,
        HotelReservationStatus.CANCELLED,
      ],
      [HotelReservationStatus.CHECKED_IN]: [HotelReservationStatus.CHECKED_OUT],
    };
    if (!allowed[current]?.includes(next))
      throw new BadRequestException(`No se puede cambiar la reservación de ${current} a ${next}.`);
  }
}

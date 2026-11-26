import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  DocumentType,
  HotelBillingDocumentType,
  HotelChannelType,
  HotelPaymentStatus,
  HotelReservationStatus,
  MembershipStatus,
  PaymentMethod,
  Prisma,
  Role,
} from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { HotelPushService } from './hotel-push.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_CHECK_IN_HOUR,
  DEFAULT_CHECK_OUT_HOUR,
  MAX_BOOKING_WINDOW_DAYS,
  MAX_STAY_NIGHTS,
  addDays,
  daysBetween,
  hotelDateKey,
  hotelInstant,
  isDateKey,
  quoteStay,
  validateWebStay,
  webTaxRate,
} from './hotel-availability';
import {
  loadNightlyAvailability,
  lockHotelReservations,
  nextReservationCode,
} from './hotel-inventory';
import {
  ChannelHotelCalendarQueryDto,
  ChannelHotelReservationDto,
  ChannelHotelStayQueryDto,
} from './hotel.dto';

/** Lo que el sitio web puede leer y crear en el ERP. Nunca expone números de habitación ni otros huéspedes. */
@Injectable()
export class HotelChannelService {
  private readonly logger = new Logger(HotelChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly push: HotelPushService,
  ) {}

  async catalog(tenantId: string) {
    const [tenant, roomTypes, availability] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, commercialName: true, email: true, phone: true, address: true },
      }),
      this.prisma.hotelRoomType.findMany({ where: { tenantId }, orderBy: { baseRate: 'asc' } }),
      loadNightlyAvailability(this.prisma, tenantId, hotelDateKey(new Date()), 1),
    ]);
    const channel = await this.webChannel(tenantId).catch(() => null);
    return {
      hotel: {
        name: tenant?.commercialName || tenant?.name || 'Hotel',
        email: tenant?.email ?? null,
        phone: tenant?.phone ?? null,
        address: tenant?.address ?? null,
      },
      bookingEnabled: Boolean(channel),
      currency: 'DOP',
      taxRate: webTaxRate(process.env),
      checkInTime: `${DEFAULT_CHECK_IN_HOUR}:00`,
      checkOutTime: `${DEFAULT_CHECK_OUT_HOUR}:00`,
      maxStayNights: MAX_STAY_NIGHTS,
      bookingWindowDays: MAX_BOOKING_WINDOW_DAYS,
      today: hotelDateKey(new Date()),
      roomTypes: roomTypes.map((type) => ({
        id: type.id,
        name: type.name,
        description: type.description,
        capacityAdults: type.capacityAdults,
        capacityChildren: type.capacityChildren,
        nightlyRate: Number(type.baseRate),
        amenities: Array.isArray(type.amenities) ? type.amenities.map(String) : [],
        // Solo indica si el tipo tiene inventario vendible; la disponibilidad real es por fecha.
        sellable: availability.has(type.id),
      })),
    };
  }

  /** Disponibilidad y precio de cada tipo para una estadía concreta. */
  async availability(tenantId: string, query: ChannelHotelStayQueryDto) {
    const stay = this.assertStay(query.checkIn, query.checkOut);
    const adults = query.adults ?? 1;
    const children = query.children ?? 0;
    const taxRate = webTaxRate(process.env);
    const [roomTypes, nightly] = await Promise.all([
      this.prisma.hotelRoomType.findMany({ where: { tenantId }, orderBy: { baseRate: 'asc' } }),
      loadNightlyAvailability(this.prisma, tenantId, query.checkIn, stay.nights),
    ]);
    return {
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights: stay.nights,
      adults,
      children,
      roomTypes: roomTypes.map((type) => {
        const nights = nightly.get(type.id) ?? Array(stay.nights).fill(0);
        const available = Math.min(...nights);
        const fitsGuests = adults <= type.capacityAdults && children <= type.capacityChildren;
        return {
          roomTypeId: type.id,
          available,
          fitsGuests,
          bookable: available > 0 && fitsGuests,
          // Noches agotadas dentro de la estadía, para explicar al huésped por qué no hay cupo.
          soldOutDates: nights
            .map((count, index) => (count > 0 ? null : addDays(query.checkIn, index)))
            .filter((value): value is string => value !== null),
          quote: quoteStay(Number(type.baseRate), stay.nights, taxRate),
        };
      }),
    };
  }

  /** Habitaciones libres por tipo y por noche: el sitio lo usa para marcar los días sin cupo. */
  async calendar(tenantId: string, query: ChannelHotelCalendarQueryDto) {
    if (!isDateKey(query.from)) throw new BadRequestException('Fecha inicial inválida.');
    const today = hotelDateKey(new Date());
    const from = query.from < today ? today : query.from;
    const days = Math.min(query.days ?? 62, MAX_BOOKING_WINDOW_DAYS + 1 - daysBetween(today, from));
    if (days < 1) return { from, days: 0, roomTypes: [] };
    const nightly = await loadNightlyAvailability(this.prisma, tenantId, from, days);
    const roomTypes = await this.prisma.hotelRoomType.findMany({
      where: { tenantId },
      select: { id: true },
    });
    return {
      from,
      days,
      roomTypes: roomTypes.map(({ id }) => ({
        roomTypeId: id,
        available: nightly.get(id) ?? Array(days).fill(0),
      })),
    };
  }

  /**
   * Crea la reserva pagada en el canal "Sitio Web": CONFIRMED y PAID, con su pago (nota de venta) registrado.
   * Queda sin habitación asignada (recepción la asigna) y consume inventario del tipo desde este momento.
   * 201 al crear; 200 con `duplicate: true` si la misma referencia ya se había recibido.
   */
  async createReservation(tenantId: string, dto: ChannelHotelReservationDto) {
    const stay = this.assertStay(dto.checkIn, dto.checkOut);
    const children = dto.children ?? 0;
    const channel = await this.webChannel(tenantId);
    const cashier = await this.onlinePaymentRecorder(tenantId);
    const roomType = await this.prisma.hotelRoomType.findFirst({
      where: { id: dto.roomTypeId, tenantId },
    });
    if (!roomType) throw new NotFoundException('Tipo de habitación no encontrado.');
    if (dto.adults > roomType.capacityAdults || children > roomType.capacityChildren)
      throw new BadRequestException(
        `${roomType.name} admite hasta ${roomType.capacityAdults} adultos y ${roomType.capacityChildren} niños.`,
      );

    const quote = quoteStay(Number(roomType.baseRate), stay.nights, webTaxRate(process.env));
    const sourceReference = `web:${dto.reference}`;
    const email = dto.email?.trim().toLowerCase() || undefined;
    const documentType = dto.documentNumber
      ? dto.documentType === 'PASSPORT'
        ? DocumentType.PASSPORT
        : DocumentType.CEDULA
      : undefined;
    const documentNumber = dto.documentNumber
      ? documentType === DocumentType.CEDULA
        ? dto.documentNumber.replace(/\D/g, '')
        : dto.documentNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
      : undefined;
    const phone = dto.phone.trim();
    const checkIn = hotelInstant(dto.checkIn, DEFAULT_CHECK_IN_HOUR);
    const checkOut = hotelInstant(dto.checkOut, DEFAULT_CHECK_OUT_HOUR);

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await lockHotelReservations(tx, tenantId);

        const existing = await tx.hotelReservation.findFirst({
          where: { tenantId, channelId: channel.id, sourceReference },
          include: { roomType: { select: { name: true } } },
        });
        if (existing) return { reservation: existing, duplicate: true };

        const nightly = await loadNightlyAvailability(tx, tenantId, dto.checkIn, stay.nights, [
          roomType.id,
        ]);
        const free = Math.min(...(nightly.get(roomType.id) ?? [0]));
        if (free < 1)
          throw new ConflictException({
            statusCode: 409,
            code: 'SOLD_OUT',
            message: `Ya no quedan habitaciones ${roomType.name} para esas fechas. Elige otras fechas u otro tipo de habitación.`,
          });

        // Un perfil existente se reutiliza por documento (o teléfono / correo), pero desde la web solo se
        // completan datos vacíos: un formulario público no puede sobrescribir el perfil de otro huésped.
        const matchers: Prisma.HotelGuestWhereInput[] = [];
        if (documentType && documentNumber) matchers.push({ documentType, documentNumber });
        if (!matchers.length) matchers.push({ phone });
        const known = await tx.hotelGuest.findFirst({
          where: { tenantId, OR: matchers },
          orderBy: { createdAt: 'asc' },
        });
        const guest = known
          ? await tx.hotelGuest.update({
              where: { id: known.id },
              data: {
                phone: known.phone || phone,
                email: known.email || email,
                ...(known.documentNumber || !documentNumber ? {} : { documentType, documentNumber }),
              },
            })
          : await tx.hotelGuest.create({
              data: {
                tenantId,
                firstName: dto.firstName.trim(),
                lastName: dto.lastName.trim(),
                email,
                phone,
                documentType,
                documentNumber,
              },
            });

        const notes = [
          known && `${known.firstName} ${known.lastName}`.toLowerCase() !==
            `${dto.firstName} ${dto.lastName}`.trim().toLowerCase()
            ? `Nombre indicado en la web: ${dto.firstName.trim()} ${dto.lastName.trim()}.`
            : null,
          dto.notes?.trim() || null,
        ].filter(Boolean);

        const reservation = await tx.hotelReservation.create({
          data: {
            tenantId,
            code: await nextReservationCode(tx, tenantId),
            guestId: guest.id,
            roomTypeId: roomType.id,
            channelId: channel.id,
            // Pagada en la pasarela, pero entra como SOLICITUD: el administrador la revisa, puede
            // modificarla y la aprueba. Mientras tanto ya reserva su cupo en el inventario.
            status: HotelReservationStatus.PENDING_REVIEW,
            paymentStatus: HotelPaymentStatus.PAID,
            paidAmount: new Prisma.Decimal(quote.total),
            checkIn,
            checkOut,
            adults: dto.adults,
            children,
            totalAmount: new Prisma.Decimal(quote.total),
            specialRequests: notes.length ? notes.join(' ') : undefined,
            sourceReference,
          },
          include: {
            roomType: { select: { name: true } },
            guest: { select: { firstName: true, lastName: true } },
          },
        });
        const card = [dto.cardBrand?.trim(), dto.cardLast4 && `•••• ${dto.cardLast4}`]
          .filter(Boolean)
          .join(' ');
        await tx.hotelReservationPayment.create({
          data: {
            tenantId,
            reservationId: reservation.id,
            recordedById: cashier,
            amount: new Prisma.Decimal(quote.total),
            method: PaymentMethod.CARD,
            billingDocumentType: HotelBillingDocumentType.SALE_NOTE,
            receiptNumber: `NV-${reservation.code}`,
            reference: `WEB-SIM-${randomBytes(4).toString('hex').toUpperCase()}`,
            notes: `Pago en línea · Sitio web (simulado)${card ? ` · Tarjeta ${card}` : ''}`,
          },
        });
        return { reservation, duplicate: false };
      },
      { timeout: 15_000, maxWait: 10_000 },
    );

    const { reservation, duplicate } = outcome;
    if (!duplicate) {
      await this.audit
        .log({
          tenantId,
          action: 'HOTEL_WEB_RESERVATION_RECEIVED',
          entity: 'HotelReservation',
          entityId: reservation.id,
          metadata: { code: reservation.code, channelId: channel.id, reference: dto.reference, quote, paid: true, simulatedPayment: true },
        })
        .catch((error: unknown) =>
          this.logger.error(`No se pudo auditar la reserva web ${reservation.code}: ${String(error)}`),
        );
      await this.prisma.hotelChannel
        .update({ where: { id: channel.id }, data: { lastSyncedAt: new Date() } })
        .catch(() => undefined);
      await this.push.notifyAdmins(tenantId, {
        title: `Nueva solicitud de reserva · ${reservation.code}`,
        body: `${dto.firstName.trim()} ${dto.lastName.trim()} · ${reservation.roomType.name} · ${dto.checkIn} → ${dto.checkOut} · ${stay.nights} ${stay.nights === 1 ? 'noche' : 'noches'} · pagada`,
        url: `/reservations?open=${reservation.id}`,
        tag: `web-request:${reservation.id}`,
      });
    }
    const nights = Math.max(
      1,
      daysBetween(hotelDateKey(reservation.checkIn), hotelDateKey(reservation.checkOut)),
    );
    return {
      duplicate,
      code: reservation.code,
      status: reservation.status,
      paymentStatus: reservation.paymentStatus,
      paidAmount: Number(reservation.paidAmount),
      roomType: reservation.roomType.name,
      checkIn: hotelDateKey(reservation.checkIn),
      checkOut: hotelDateKey(reservation.checkOut),
      nights,
      adults: reservation.adults,
      children: reservation.children,
      total: Number(reservation.totalAmount),
      currency: 'DOP',
    };
  }

  /**
   * El ERP exige un usuario en cada pago. Los cobros de la web se registran a nombre del administrador
   * activo más antiguo del hotel; la nota del pago indica que vino del sitio web.
   */
  private async onlinePaymentRecorder(tenantId: string) {
    for (const roles of [[Role.ADMIN], [Role.SUPER_ADMIN, Role.RECEPTION]]) {
      const membership = await this.prisma.membership.findFirst({
        where: { tenantId, status: MembershipStatus.ACTIVE, role: { in: roles } },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
      });
      if (membership) return membership.userId;
    }
    throw new ServiceUnavailableException(
      'Las reservas en línea no están disponibles en este momento.',
    );
  }

  private assertStay(checkIn: string, checkOut: string) {
    const result = validateWebStay(checkIn, checkOut, hotelDateKey(new Date()));
    if (!result.ok) throw new BadRequestException(result.message);
    return result;
  }

  /** Canal activo "Sitio Web" (DIRECT_WEB) configurado en el ERP. */
  private async webChannel(tenantId: string) {
    const channel = await this.prisma.hotelChannel.findFirst({
      where: { tenantId, type: HotelChannelType.DIRECT_WEB, active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!channel)
      throw new ServiceUnavailableException(
        'Las reservas en línea no están disponibles en este momento.',
      );
    return channel;
  }
}

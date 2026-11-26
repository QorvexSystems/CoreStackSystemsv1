import { Injectable } from '@nestjs/common';
import {
  HotelChannelType,
  HotelReservationStatus,
  HotelRoomStatus,
  HousekeepingStatus,
} from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { addDays, daysBetween, hotelDateKey, hotelInstant } from './hotel-availability';
import { loadNightlyAvailability } from './hotel-inventory';

const MONTH_LABELS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const NOT_STAYING: HotelReservationStatus[] = [
  HotelReservationStatus.CANCELLED,
  HotelReservationStatus.NO_SHOW,
];
const BEFORE_ARRIVAL: HotelReservationStatus[] = [
  HotelReservationStatus.PENDING_REVIEW,
  HotelReservationStatus.CONFIRMED,
  HotelReservationStatus.ASSIGNED,
];
const round = (value: number) => Math.round(value * 100) / 100;
/** Pagos con crédito a favor (CR-) no son dinero nuevo: no cuentan como facturación. */
const isCreditPayment = (receiptNumber: string) => receiptNumber.startsWith('CR-');

/** Datos reales del panel principal, en hora del hotel. */
@Injectable()
export class HotelDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(tenantId: string) {
    const now = new Date();
    const today = hotelDateKey(now);
    const monthStart = `${today.slice(0, 7)}-01`;
    const months = Array.from({ length: 6 }, (_, index) => shiftMonth(monthStart, index - 5));
    const windowStart = hotelInstant(months[0], 0);
    const windowEnd = hotelInstant(shiftMonth(monthStart, 1), 0);

    const [rooms, payments, stays, open, monthReservations, channels, tonight] = await Promise.all([
      this.prisma.hotelRoom.findMany({
        where: { tenantId },
        select: { number: true, status: true, housekeepingStatus: true },
        orderBy: { number: 'asc' },
      }),
      this.prisma.hotelReservationPayment.findMany({
        where: { tenantId, createdAt: { gte: windowStart, lt: windowEnd } },
        select: { amount: true, createdAt: true, receiptNumber: true },
      }),
      this.prisma.hotelReservation.findMany({
        where: {
          tenantId,
          status: { notIn: NOT_STAYING },
          checkIn: { lt: windowEnd },
          checkOut: { gt: windowStart },
        },
        select: { checkIn: true, checkOut: true, checkedOutAt: true, status: true },
      }),
      this.prisma.hotelReservation.findMany({
        where: { tenantId, status: { notIn: [...NOT_STAYING, HotelReservationStatus.CHECKED_OUT] } },
        include: {
          guest: { select: { firstName: true, lastName: true } },
          room: { select: { number: true } },
          roomType: { select: { name: true } },
          channel: { select: { type: true } },
        },
        orderBy: { checkIn: 'asc' },
      }),
      this.prisma.hotelReservation.groupBy({
        by: ['channelId'],
        where: {
          tenantId,
          status: { notIn: NOT_STAYING },
          createdAt: { gte: hotelInstant(monthStart, 0), lt: windowEnd },
        },
        _count: { _all: true },
      }),
      this.prisma.hotelChannel.findMany({
        where: { tenantId },
        select: { id: true, name: true, type: true },
      }),
      loadNightlyAvailability(this.prisma, tenantId, today, 1),
    ]);

    // ---- Facturación (cobros registrados) ----
    let monthRevenue = 0;
    let todayRevenue = 0;
    const revenueByMonth = new Map<string, number>(months.map((month) => [month, 0]));
    for (const payment of payments) {
      if (isCreditPayment(payment.receiptNumber)) continue;
      const day = hotelDateKey(payment.createdAt);
      const month = `${day.slice(0, 7)}-01`;
      const amount = Number(payment.amount);
      revenueByMonth.set(month, (revenueByMonth.get(month) ?? 0) + amount);
      if (month === monthStart) monthRevenue += amount;
      if (day === today) todayRevenue += amount;
    }

    // ---- Ocupación: noches ocupadas / (habitaciones vendibles × días del mes) ----
    const sellable = rooms.filter(
      (room) => room.status !== HotelRoomStatus.MAINTENANCE && room.status !== HotelRoomStatus.OUT_OF_SERVICE,
    ).length;
    const occupiedNights = new Map<string, number>(months.map((month) => [month, 0]));
    for (const stay of stays) {
      const first = hotelDateKey(stay.checkIn);
      const departure = hotelDateKey(
        stay.status === HotelReservationStatus.CHECKED_OUT && stay.checkedOutAt && stay.checkedOutAt < stay.checkOut
          ? stay.checkedOutAt
          : stay.checkOut,
      );
      const end = departure > first ? departure : addDays(first, 1);
      for (let night = first; night < end; night = addDays(night, 1)) {
        const month = `${night.slice(0, 7)}-01`;
        if (occupiedNights.has(month)) occupiedNights.set(month, occupiedNights.get(month)! + 1);
      }
    }
    const performance = months.map((month) => {
      const days = daysBetween(month, shiftMonth(month, 1));
      const capacity = sellable * days;
      return {
        month: MONTH_LABELS[Number(month.slice(5, 7)) - 1],
        revenue: round(revenueByMonth.get(month) ?? 0),
        occupancy: capacity ? Math.min(100, Math.round(((occupiedNights.get(month) ?? 0) / capacity) * 100)) : 0,
      };
    });

    // ---- Hoy ----
    const arrivalsToday = open.filter(
      (item) => BEFORE_ARRIVAL.includes(item.status) && hotelDateKey(item.checkIn) === today,
    );
    const inHouse = open.filter((item) => item.status === HotelReservationStatus.CHECKED_IN);
    const departuresToday = inHouse.filter((item) => hotelDateKey(item.checkOut) <= today);
    const withBalance = open
      .map((item) => ({ item, balance: round(Number(item.totalAmount) - Number(item.paidAmount)) }))
      .filter(({ balance }) => balance > 0.009)
      .sort((first, second) => second.balance - first.balance);
    const webRequests = open.filter(
      (item) =>
        item.status === HotelReservationStatus.PENDING_REVIEW &&
        item.channel?.type === HotelChannelType.DIRECT_WEB,
    );
    const toClean = rooms.filter(
      (room) =>
        room.status === HotelRoomStatus.CLEANING ||
        room.housekeepingStatus === HousekeepingStatus.DIRTY ||
        room.housekeepingStatus === HousekeepingStatus.IN_PROGRESS,
    );

    // ---- Habitaciones ----
    const count = (status: HotelRoomStatus) => rooms.filter((room) => room.status === status).length;
    const freeTonight = [...tonight.values()].reduce((sum, nights) => sum + (nights[0] ?? 0), 0);

    // ---- Canales del mes ----
    const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
    const totalChannel = monthReservations.reduce((sum, row) => sum + row._count._all, 0);
    const channelRows = monthReservations
      .map((row) => ({
        name: row.channelId ? channelNames.get(row.channelId) ?? 'Otro' : 'Sin canal',
        total: row._count._all,
        share: totalChannel ? Math.round((row._count._all / totalChannel) * 100) : 0,
      }))
      .sort((first, second) => second.total - first.total);

    return {
      today,
      revenue: { month: round(monthRevenue), today: round(todayRevenue) },
      reservationsToday: {
        total: arrivalsToday.length + inHouse.length,
        arrivalsPending: arrivalsToday.length,
        inHouse: inHouse.length,
        departuresPending: departuresToday.length,
      },
      pendingPayments: {
        amount: round(withBalance.reduce((sum, row) => sum + row.balance, 0)),
        count: withBalance.length,
        top: withBalance.slice(0, 4).map(({ item, balance }) => ({
          id: item.id,
          code: item.code,
          guest: `${item.guest.firstName} ${item.guest.lastName}`.trim(),
          balance,
        })),
      },
      rooms: {
        total: rooms.length,
        freeTonight,
        occupied: count(HotelRoomStatus.OCCUPIED),
        available: count(HotelRoomStatus.AVAILABLE),
        reserved: count(HotelRoomStatus.RESERVED),
        cleaning: count(HotelRoomStatus.CLEANING),
        outOfService: count(HotelRoomStatus.MAINTENANCE) + count(HotelRoomStatus.OUT_OF_SERVICE),
      },
      performance,
      channels: channelRows,
      arrivals: arrivalsToday.slice(0, 5).map((item) => ({
        id: item.id,
        code: item.code,
        guest: `${item.guest.firstName} ${item.guest.lastName}`.trim(),
        adults: item.adults,
        children: item.children,
        checkIn: item.checkIn,
        arrivalTime: item.arrivalTime,
        room: item.room?.number ?? null,
        roomType: item.roomType.name,
      })),
      priorities: {
        webRequests: webRequests.length,
        arrivalsPending: arrivalsToday.length,
        arrivalsWithoutRoom: arrivalsToday.filter((item) => !item.room).length,
        departuresPending: departuresToday.length,
        paymentsPending: withBalance.length,
        topPayment: withBalance[0]
          ? { code: withBalance[0].item.code, balance: withBalance[0].balance }
          : null,
        roomsToClean: toClean.map((room) => room.number),
      },
    };
  }
}

function shiftMonth(monthKey: string, offset: number) {
  const date = new Date(`${monthKey}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}

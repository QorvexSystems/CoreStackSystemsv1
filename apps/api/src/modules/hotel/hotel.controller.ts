import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@qorvex/database';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import {
  AssignHotelRoomDto,
  CreateHotelChannelDto,
  CreateHotelExpressInvoiceDto,
  CreateHotelReservationDto,
  PushSubscriptionDto,
  RecordHotelPaymentDto,
  RevokePushSubscriptionDto,
  TaxIdentityLookupQueryDto,
  UpdateHotelReservationDto,
  UpdateHotelReservationStatusDto,
  UpdateHotelRoomStateDto,
  UpdateHotelGuestDto,
} from './hotel.dto';
import { HotelDashboardService } from './hotel-dashboard.service';
import { HotelPushService } from './hotel-push.service';
import { HotelTaxService } from './hotel-tax.service';
import { HotelService } from './hotel.service';

const hotelAdminRoles = [Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN];
const hotelReadRoles = [...hotelAdminRoles, Role.RECEPTION, Role.ACCOUNTANT, Role.CASHIER];
const hotelReceptionRoles = [Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.RECEPTION];
const hotelPaymentRoles = [...hotelReceptionRoles, Role.CASHIER, Role.ACCOUNTANT];
const hotelBillingRoles = [...hotelAdminRoles, Role.ACCOUNTANT];
// La limpieza se coordina desde recepción: las camareras pasan por recepción y confirman ahí.
const hotelHousekeepingRoles = [...hotelAdminRoles, Role.RECEPTION, Role.HOUSEKEEPING];

@Controller('hotel')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
export class HotelController {
  constructor(
    private readonly service: HotelService,
    private readonly push: HotelPushService,
    private readonly tax: HotelTaxService,
    private readonly dashboardData: HotelDashboardService,
  ) {}
  /** Panel principal con datos reales (cobros, ocupación, llegadas, balances, canales). */
  @Get('dashboard/overview') @Roles(...hotelReadRoles) dashboardOverview(@TenantId() tenantId: string) {
    return this.dashboardData.overview(tenantId);
  }
  /** Solicitudes pendientes de aprobación (las reservas que llegan desde la web): alimentan la campanita. */
  @Get('requests') @Roles(...hotelReadRoles) requests(@TenantId() tenantId: string) {
    return this.service.pendingRequests(tenantId);
  }
  /** Vencimiento de las secuencias e-CF (E31/E32): la factura lo imprime bajo el e-NCF. */
  @Get('fiscal-sequences/validity') @Roles(...hotelReadRoles) fiscalSequenceValidity(
    @TenantId() tenantId: string,
  ) {
    return this.service.fiscalSequenceValidity(tenantId);
  }
  @Get('tax-identities/lookup') @Roles(...hotelReadRoles) lookupTaxIdentity(
    @Query() query: TaxIdentityLookupQueryDto,
  ) {
    return this.tax.lookup(query.documentType, query.documentNumber);
  }
  @Get('push/config') @Roles(...hotelReadRoles) pushConfig() {
    return this.push.config();
  }
  @Post('push/subscriptions') @Roles(...hotelReadRoles) registerPush(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PushSubscriptionDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.push.register(tenantId, user.id, dto, userAgent);
  }
  @Post('push/subscriptions/revoke') @Roles(...hotelReadRoles) revokePush(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RevokePushSubscriptionDto,
  ) {
    return this.push.revoke(user.id, dto.endpoint);
  }
  @Post('push/test') @Roles(...hotelReadRoles) testPush(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.push.sendTest(tenantId, user.id);
  }
  @Get('dashboard') @Roles(...hotelReadRoles) dashboard(@TenantId() tenantId: string) {
    return this.service.dashboard(tenantId);
  }
  @Get('reservations') @Roles(...hotelReadRoles) reservations(@TenantId() tenantId: string) {
    return this.service.reservations(tenantId);
  }
  @Get('invoices') @Roles(...hotelBillingRoles) invoices(@TenantId() tenantId: string) {
    return this.service.invoices(tenantId);
  }
  @Post('reservations') @Roles(...hotelReceptionRoles) createReservation(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateHotelReservationDto,
  ) {
    return this.service.createReservation(tenantId, user.id, dto);
  }
  @Patch('reservations/:id') @Roles(...hotelReceptionRoles) updateReservation(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateHotelReservationDto,
  ) {
    return this.service.updateReservation(tenantId, user.id, id, dto);
  }
  /** Eliminar una reservación antes del check-in (administrador o recepción). */
  @Delete('reservations/:id') @Roles(...hotelReceptionRoles) deleteReservation(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.deleteReservation(tenantId, user.id, id);
  }
  /** Recuperar una reservación inasistida (vuelve a las llegadas si hay cupo). */
  @Post('reservations/:id/recover') @Roles(...hotelReceptionRoles) recoverReservation(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.recoverNoShow(tenantId, user.id, id);
  }
  /** Pago Express: factura rápida sin reservación. */
  @Post('invoices/express') @Roles(...hotelPaymentRoles) createExpressInvoice(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateHotelExpressInvoiceDto,
  ) {
    return this.service.createExpressInvoice(tenantId, user.id, dto);
  }
  @Post('reservations/:id/apply-credit') @Roles(...hotelPaymentRoles) applyGuestCredit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.applyGuestCredit(tenantId, user.id, id);
  }
  @Patch('reservations/:id/room') @Roles(...hotelReceptionRoles) assignRoom(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignHotelRoomDto,
  ) {
    return this.service.assignRoom(tenantId, user.id, id, dto);
  }
  @Patch('reservations/:id/status') @Roles(...hotelReceptionRoles) updateStatus(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateHotelReservationStatusDto,
  ) {
    return this.service.updateStatus(tenantId, user.id, id, dto);
  }
  @Post('reservations/:id/payments') @Roles(...hotelPaymentRoles) recordPayment(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RecordHotelPaymentDto,
  ) {
    return this.service.recordPayment(tenantId, user.id, id, dto);
  }
  @Get('room-types') @Roles(...hotelReadRoles) roomTypes(@TenantId() tenantId: string) {
    return this.service.roomTypes(tenantId);
  }
  @Get('rooms') @Roles(...hotelReadRoles) rooms(@TenantId() tenantId: string) {
    return this.service.rooms(tenantId);
  }
  @Patch('rooms/:id/state') @Roles(...hotelReceptionRoles) updateRoomState(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateHotelRoomStateDto,
  ) {
    return this.service.updateRoomState(tenantId, user.id, id, dto);
  }
  @Get('housekeeping/rooms') @Roles(...hotelHousekeepingRoles) housekeepingRooms(
    @TenantId() tenantId: string,
  ) {
    return this.service.housekeepingRooms(tenantId);
  }
  @Get('housekeeping/rooms/:id') @Roles(...hotelHousekeepingRoles) housekeepingRoom(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.housekeepingRoom(tenantId, id);
  }
  @Patch('housekeeping/rooms/:id/confirm') @Roles(...hotelHousekeepingRoles) confirmCleaning(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.confirmCleaning(tenantId, user.id, id);
  }
  @Get('guests') @Roles(...hotelReadRoles) guests(@TenantId() tenantId: string) {
    return this.service.guests(tenantId);
  }
  @Patch('guests/:id') @Roles(...hotelReceptionRoles) updateGuest(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateHotelGuestDto,
  ) {
    return this.service.updateGuest(tenantId, user.id, id, dto);
  }
  @Get('channels') @Roles(...hotelReadRoles) channels(@TenantId() tenantId: string) {
    return this.service.channels(tenantId);
  }
  @Post('channels') @Roles(...hotelAdminRoles) createChannel(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateHotelChannelDto,
  ) {
    return this.service.createChannel(tenantId, user.id, dto);
  }
}

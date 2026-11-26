import {
  DocumentType,
  HotelBillingDocumentType,
  HotelChannelType,
  HotelReservationStatus,
  HotelRoomStatus,
  HousekeepingStatus,
  PaymentMethod,
} from '@qorvex/database';
import {
  IsDateString,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';

export class CreateHotelReservationDto {
  @IsOptional() @IsString() guestId?: string;
  @IsString() @MaxLength(80) firstName: string;
  @IsString() @MaxLength(80) lastName: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEnum(DocumentType) documentType?: DocumentType;
  @IsOptional() @IsString() @MaxLength(60) documentNumber?: string;
  @IsString() roomTypeId: string;
  @IsOptional() @IsString() roomId?: string;
  @IsString() channelId: string;
  @IsDateString() checkIn: string;
  @IsDateString() checkOut: string;
  @IsInt() @Min(1) adults: number;
  @IsOptional() @IsInt() @Min(0) children?: number;
  @IsNumber() @IsPositive() totalAmount: number;
  @IsOptional() @IsString() @MaxLength(500) specialRequests?: string;
}

/** Edición de una reservación antes del check-in. Todo es opcional: solo se cambia lo que se envía. */
export class UpdateHotelReservationDto {
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEnum(DocumentType) documentType?: DocumentType;
  @IsOptional() @IsString() @MaxLength(60) documentNumber?: string;
  @IsOptional() @IsString() roomTypeId?: string;
  /** Cadena vacía quita la habitación asignada. */
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() channelId?: string;
  @IsOptional() @IsDateString() checkIn?: string;
  @IsOptional() @IsDateString() checkOut?: string;
  @IsOptional() @IsInt() @Min(1) adults?: number;
  @IsOptional() @IsInt() @Min(0) children?: number;
  @IsOptional() @IsNumber() @IsPositive() totalAmount?: number;
  @IsOptional() @IsString() @MaxLength(500) specialRequests?: string;
  @IsOptional() @IsString() @MaxLength(20) arrivalTime?: string;
}

export class TaxIdentityLookupQueryDto {
  @IsIn(['RNC', 'CEDULA']) documentType: 'RNC' | 'CEDULA';
  @Matches(/^[\d\s-]{9,15}$/) documentNumber: string;
}

class PushKeysDto {
  @IsString() @MaxLength(200) p256dh: string;
  @IsString() @MaxLength(100) auth: string;
}

export class PushSubscriptionDto {
  @IsString() @MaxLength(2048) endpoint: string;
  @IsOptional() @IsNumber() expirationTime?: number | null;
  @IsObject() @ValidateNested() @Type(() => PushKeysDto) keys: PushKeysDto;
}

export class RevokePushSubscriptionDto {
  @IsString() @MaxLength(2048) endpoint: string;
}

export class AssignHotelRoomDto {
  @IsString() roomId: string;
}
export class UpdateHotelReservationStatusDto {
  @IsEnum(HotelReservationStatus) status: HotelReservationStatus;
  /** Check-out anticipado: generar crédito a favor por las noches no usadas (por defecto sí). */
  @IsOptional() @IsBoolean() grantCredit?: boolean;
  /** Check-in con balance pendiente: el huésped paga al final (al hacer check-out). */
  @IsOptional() @IsBoolean() payLater?: boolean;
}

/** Pago Express: factura rápida sin reservación. El monto ya incluye el ITBIS. */
export class CreateHotelExpressInvoiceDto {
  @IsIn([DocumentType.RNC, DocumentType.CEDULA]) documentType: 'RNC' | 'CEDULA';
  @Matches(/^[\d\s-]{9,15}$/) documentNumber: string;
  @IsString() @MinLength(2) @MaxLength(160) customerName: string;
  @IsOptional() @IsString() @MaxLength(40) customerPhone?: string;
  @IsString() @MinLength(2) @MaxLength(300) description: string;
  @IsNumber() @IsPositive() @Max(10_000_000) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsNumber() @IsPositive() cashReceived?: number;
  @IsIn([HotelBillingDocumentType.E31, HotelBillingDocumentType.E32]) billingDocumentType: 'E31' | 'E32';
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

export class RecordHotelPaymentDto {
  @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsNumber() @IsPositive() cashReceived?: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsEnum(HotelBillingDocumentType) billingDocumentType: HotelBillingDocumentType;
  @IsOptional()
  @IsEnum(DocumentType)
  @IsIn([DocumentType.RNC, DocumentType.CEDULA])
  fiscalDocumentType?: DocumentType;
  @IsOptional() @IsString() @MaxLength(20) fiscalDocumentNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class UpdateHotelRoomStateDto {
  @IsOptional() @IsEnum(HotelRoomStatus) status?: HotelRoomStatus;
  @IsOptional() @IsEnum(HousekeepingStatus) housekeepingStatus?: HousekeepingStatus;
}

export class CreateHotelChannelDto {
  @IsEnum(HotelChannelType) type: HotelChannelType;
  @IsString() @MaxLength(100) name: string;
}

// ---- Canal del sitio web (servidor a servidor, firmado con HMAC) ----
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class ChannelHotelStayQueryDto {
  @Matches(DATE_ONLY) checkIn: string;
  @Matches(DATE_ONLY) checkOut: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) adults?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(12) children?: number;
}

export class ChannelHotelCalendarQueryDto {
  @Matches(DATE_ONLY) from: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(186) days?: number;
}

/** Solicitud de reserva del sitio web. El precio lo calcula el ERP; el cliente nunca lo envía. */
export class ChannelHotelReservationDto {
  /** Clave de idempotencia generada por el sitio: reintentos con la misma referencia no duplican. */
  @Matches(/^[A-Za-z0-9_-]{16,64}$/) reference: string;
  @IsString() @MaxLength(40) roomTypeId: string;
  @Matches(DATE_ONLY) checkIn: string;
  @Matches(DATE_ONLY) checkOut: string;
  @IsInt() @Min(1) @Max(12) adults: number;
  @IsOptional() @IsInt() @Min(0) @Max(12) children?: number;
  @IsString() @MinLength(2) @MaxLength(80) firstName: string;
  @IsString() @MinLength(2) @MaxLength(80) lastName: string;
  /** Ya no se pide correo en la web (los huéspedes dan cédula/pasaporte y teléfono). */
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @Matches(/^\+?[0-9 ()-]{7,20}$/) phone: string;
  @IsOptional() @IsIn([DocumentType.CEDULA, DocumentType.PASSPORT]) documentType?: 'CEDULA' | 'PASSPORT';
  @IsOptional() @Matches(/^[A-Za-z0-9 -]{5,20}$/) documentNumber?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) arrivalTime?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  /** El sitio no acepta reservas sin pago: la pasarela (simulada) siempre envía el método. */
  @IsIn(['CARD']) paymentMethod: 'CARD';
  @IsOptional() @Matches(/^\d{4}$/) cardLast4?: string;
  @IsOptional() @IsString() @MaxLength(20) cardBrand?: string;
}

/** Edición de la ficha del huésped (directorio de Huéspedes). Solo se cambia lo que se envía. */
export class UpdateHotelGuestDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) lastName?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn([DocumentType.CEDULA, DocumentType.PASSPORT]) documentType?: 'CEDULA' | 'PASSPORT';
  /** Cadena vacía quita el documento. */
  @IsOptional() @IsString() @MaxLength(30) documentNumber?: string;
  @IsOptional() @IsString() @MaxLength(60) nationality?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

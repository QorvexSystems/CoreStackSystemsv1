import { ProductKind, ProductStatus, WebAvailabilityPolicy } from '@qorvex/database';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class OptionDefinitionDto {
  @IsString() @IsNotEmpty() @MaxLength(40) name: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(60, { each: true }) values: string[];
}

export class OptionValueDto {
  @IsString() @IsNotEmpty() @MaxLength(40) name: string;
  @IsString() @IsNotEmpty() @MaxLength(60) value: string;
}

export class NewImageDto {
  @IsString() @MaxLength(2048) url: string;
  @IsOptional() @IsString() @MaxLength(200) alt?: string;
  /** IDs comerciales de variantes del grupo a las que pertenece la imagen. */
  @IsOptional() @IsArray() @IsString({ each: true }) variantIds?: string[];
}

export class WebVariantDto {
  @IsString() @IsNotEmpty() @MaxLength(60) title: string;
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => OptionValueDto) options: OptionValueDto[];
  @IsString() @IsNotEmpty() @MaxLength(80) sku: string;
  /** Precio comercial tal cual: no se suma ni se descuenta ITBIS. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99999999) price: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99999999) compareAtPrice?: number;
  @IsOptional() @IsEnum(WebAvailabilityPolicy) webAvailability?: WebAvailabilityPolicy;
  @IsOptional() @IsBoolean() trackInventory?: boolean;
  @IsOptional() @IsEnum(ProductKind) kind?: ProductKind;
}

export class CreateWebProductDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) categoryLabel?: string;
  /** URL pública https autorizada. No se inventan ni se descargan imágenes. */
  @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string;
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => OptionDefinitionDto) options: OptionDefinitionDto[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => WebVariantDto) variants: WebVariantDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => NewImageDto) images?: NewImageDto[];
}

export class UpdateWebProductDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) categoryLabel?: string;
  @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => OptionDefinitionDto) options?: OptionDefinitionDto[];
  /** Agrega imágenes a la galería; las existentes (incluidas las importadas) se conservan. */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => NewImageDto) addImages?: NewImageDto[];
}

export class UpdateWebVariantDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) title?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => OptionValueDto) options?: OptionValueDto[];
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) sku?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99999999) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99999999) compareAtPrice?: number | null;
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @IsOptional() @IsEnum(WebAvailabilityPolicy) webAvailability?: WebAvailabilityPolicy;
  @IsOptional() @IsBoolean() trackInventory?: boolean;
  @IsOptional() @IsEnum(ProductKind) kind?: ProductKind;
}

export class ListWebProductsQueryDto {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsString() @Matches(/^(true|false)$/) published?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  /** Código de bloqueo (p. ej. GROUP_IMAGE_MISSING) o NONE para los publicables. */
  @IsOptional() @IsString() @Matches(/^[A-Z_]{3,60}$/) blocker?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(80) cursor?: string;
}

export class ChannelCatalogQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @IsString() @MaxLength(80) cursor?: string;
}

export class AvailabilityItemDto {
  @IsString() @IsNotEmpty() @MaxLength(120) variantId: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity?: number;
}

export class ChannelAvailabilityDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AvailabilityItemDto) items: AvailabilityItemDto[];
}

/** Campos de texto que acompañan al archivo (multipart: todo llega como cadena). */
export class UploadWebImageDto {
  @IsOptional() @IsString() @MaxLength(200) alt?: string;
  /** IDs comerciales de variantes separados por coma. */
  @IsOptional() @IsString() @MaxLength(1000) variantIds?: string;
  @IsOptional() @IsString() @Matches(/^(true|false)$/) primary?: string;
}

export class BulkIdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(80, { each: true }) ids: string[];
}

export class BulkCategoryDto extends BulkIdsDto {
  @IsString() @IsNotEmpty() @MaxLength(80) categoryLabel: string;
  /** Sin esta bandera solo se asigna a grupos que aún no tienen categoría. */
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export class BulkAvailabilityDto extends BulkIdsDto {
  @IsEnum({ STOCKED: 'STOCKED', MADE_TO_ORDER: 'MADE_TO_ORDER' }) policy: 'STOCKED' | 'MADE_TO_ORDER';
}

export class BulkPublishDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(25) @IsString({ each: true }) @MaxLength(80, { each: true }) ids: string[];
  @IsBoolean() confirm: boolean;
}

export class SkuReviewQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @IsString() @MaxLength(120) cursor?: string;
  @IsOptional() @IsString() @MaxLength(80) groupId?: string;
}

// ---- Pedidos solicitados desde el e-commerce (POST /channel/orders). Nunca incluyen precios ni totales. ----

export class ChannelOrderCustomerDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsString() @MinLength(7) @MaxLength(24) phone: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  /** Cédula opcional: si se envía se valida con el mismo algoritmo que Clientes. */
  @IsOptional() @IsString() @MaxLength(20) documentNumber?: string;
}

export class ChannelOrderDeliveryDto {
  @IsIn(['PICKUP', 'DELIVERY']) method: 'PICKUP' | 'DELIVERY';
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(200) addressReference?: string;
}

export class ChannelOrderItemDto {
  @IsString() @IsNotEmpty() @MaxLength(64) variantId: string;
  @IsInt() @Min(1) @Max(20) quantity: number;
  /** Texto de personalización de la línea (grabado, nombre, fecha...). */
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

export class ChannelCreateOrderDto {
  /** Clave de idempotencia generada por el e-commerce: el mismo valor nunca crea dos pedidos. */
  @IsString() @Matches(/^[A-Za-z0-9_-]{16,64}$/) reference: string;
  @ValidateNested() @Type(() => ChannelOrderCustomerDto) customer: ChannelOrderCustomerDto;
  @ValidateNested() @Type(() => ChannelOrderDeliveryDto) delivery: ChannelOrderDeliveryDto;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ChannelOrderItemDto) items: ChannelOrderItemDto[];
}

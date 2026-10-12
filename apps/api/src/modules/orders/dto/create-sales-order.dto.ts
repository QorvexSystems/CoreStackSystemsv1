import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CreditTermOption,
  DocumentType,
  InitialPaymentOption,
  ProductInventoryDestination,
  ProductUnit,
  SalePaymentMode,
  SalesOrderDestination,
  SalesOrderPriceLevel,
} from '@qorvex/database';

export class SalesOrderItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsOptional()
  @IsEnum(ProductUnit)
  unit?: ProductUnit;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  unitPrice?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  quantity: number;
}

export class CreateSalesOrderDto {
  @IsEnum(SalesOrderDestination)
  destination: SalesOrderDestination;

  @IsOptional()
  @IsEnum(ProductInventoryDestination)
  inventorySource?: ProductInventoryDestination;

  @IsOptional()
  @IsBoolean()
  electronicInvoiceRequested?: boolean;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  ecfRecipientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  clientName?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsEnum(SalesOrderPriceLevel)
  priceLevel?: SalesOrderPriceLevel;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  customDiscountPercent?: number;

  @IsOptional()
  @IsBoolean()
  requestCustomDiscount?: boolean;

  @IsOptional()
  @IsEnum(SalePaymentMode)
  paymentMode?: SalePaymentMode;

  @IsOptional()
  @IsEnum(InitialPaymentOption)
  initialPaymentOption?: InitialPaymentOption;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  customInitialPaymentAmount?: number;

  @IsOptional()
  @IsEnum(CreditTermOption)
  creditTermOption?: CreditTermOption;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  customDueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  creditRequestNote?: string;

  @IsOptional()
  @IsEnum(DocumentType)
  quotationDocumentType?: DocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  quotationDocumentNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalesOrderItemDto)
  items: SalesOrderItemDto[];
}

export class ClaimSalesOrderDto {
  @IsOptional()
  @IsString()
  cashSessionId?: string;
}

export class CancelSalesOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

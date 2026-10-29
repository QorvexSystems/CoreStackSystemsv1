import { PaymentMethod, ProductInventoryDestination } from '@qorvex/database';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateReturnRequestItemDto {
  @IsString()
  invoiceItemId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  quantity: number;

  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

export class CreateReturnRequestDto {
  @IsString()
  invoiceId: string;

  @IsString()
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  refundMethod?: PaymentMethod;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateReturnRequestItemDto)
  items: CreateReturnRequestItemDto[];
}

export class ApproveReturnRequestDto {
  @IsOptional()
  @IsEnum(ProductInventoryDestination)
  restockDestination?: ProductInventoryDestination;

  @IsOptional()
  @IsString()
  cashSessionId?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  refundMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adminNote?: string;
}

export class RejectReturnRequestDto {
  @IsString()
  @MaxLength(500)
  adminNote: string;
}

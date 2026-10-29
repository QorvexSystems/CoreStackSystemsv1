import { CorporateUnitStatus } from '@qorvex/database';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CorporateOrderUnitDto {
  @IsOptional()
  @IsString()
  salesOrderItemId?: string;

  @IsString()
  @MaxLength(160)
  recipientName: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsObject()
  personalization?: Record<string, string | number>;
}

export class AddCorporateOrderUnitsDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CorporateOrderUnitDto)
  units: CorporateOrderUnitDto[];
}

export class UpdateCorporateOrderUnitDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsObject()
  personalization?: Record<string, string | number>;

  @IsOptional()
  @IsEnum(CorporateUnitStatus)
  status?: CorporateUnitStatus;

  @IsOptional()
  @IsBoolean()
  delivered?: boolean;
}

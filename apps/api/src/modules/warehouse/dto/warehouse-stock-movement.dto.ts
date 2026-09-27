import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReceiveWarehouseStockDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  reference: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}

export class ReceiveWarehouseBatchItemDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;
}

export class ReceiveWarehouseBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveWarehouseBatchItemDto)
  items: ReceiveWarehouseBatchItemDto[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  reference: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}

export class CountWarehouseStockDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  countedQuantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  reference?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}

export class ConfirmWarehouseDispatchItemDto {
  @IsString()
  @IsNotEmpty()
  orderItemId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;
}

export class ConfirmWarehouseDispatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConfirmWarehouseDispatchItemDto)
  items: ConfirmWarehouseDispatchItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

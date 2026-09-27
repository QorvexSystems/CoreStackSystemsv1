import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';

export class DispatchWarehouseProductDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  reference: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;
}

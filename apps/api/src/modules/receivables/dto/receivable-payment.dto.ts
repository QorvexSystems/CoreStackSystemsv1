import { PaymentMethod } from '@qorvex/database';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateReceivablePaymentDto {
  @IsOptional()
  @IsIn([PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER])
  method?: PaymentMethod;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsString()
  cashSessionId: string;

  @IsOptional()
  @IsUUID('4')
  idempotencyKey?: string;
}

export class CancelReceivablePaymentDto {
  @IsString()
  cashSessionId: string;

  @IsString()
  @MaxLength(500)
  reason: string;
}

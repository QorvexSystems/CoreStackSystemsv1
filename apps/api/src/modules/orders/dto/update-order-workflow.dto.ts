import { OrderExceptionStatus, OrderPriority, ProductionStage } from '@qorvex/database';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateOrderWorkflowDto {
  @IsOptional()
  @IsBoolean()
  requiresProduction?: boolean;

  @IsOptional()
  @IsEnum(ProductionStage)
  stage?: ProductionStage;

  @IsOptional()
  @IsEnum(OrderExceptionStatus)
  exceptionStatus?: OrderExceptionStatus;

  @IsOptional()
  @IsEnum(OrderPriority)
  priority?: OrderPriority;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

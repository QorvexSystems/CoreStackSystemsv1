import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DecideDiscountApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

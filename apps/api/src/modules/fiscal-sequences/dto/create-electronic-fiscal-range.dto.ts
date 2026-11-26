import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const ELECTRONIC_ECF_TYPES = [31, 32, 33, 34, 41, 43, 44, 45, 46, 47] as const;
export type ElectronicEcfType = (typeof ELECTRONIC_ECF_TYPES)[number];

export class CreateElectronicFiscalRangeDto {
  @Type(() => Number)
  @IsInt()
  @IsIn(ELECTRONIC_ECF_TYPES)
  ecfType: ElectronicEcfType;

  @Matches(/^[1-9][0-9]{0,9}$/)
  startNumber: string;

  @Matches(/^[1-9][0-9]{0,9}$/)
  endNumber: string;

  @Matches(/^[1-9][0-9]{0,9}$/)
  nextNumber: string;

  @IsString()
  @MaxLength(120)
  authorizationNumber: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  authorizedAt?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  validUntil?: string;
}

import { DocumentType, InvoiceDocumentType } from '@qorvex/database';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

const supportedFiscalDocumentTypes = [
  InvoiceDocumentType.FISCAL_CREDIT_01,
  InvoiceDocumentType.CONSUMER_02,
  InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
  InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
] as const;

export class CreateFiscalSequenceDto {
  @IsEnum(InvoiceDocumentType)
  @IsIn(supportedFiscalDocumentTypes)
  documentType: InvoiceDocumentType;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  startNumber: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  endNumber: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  nextNumber: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  authorizationNumber?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsEnum(DocumentType)
  @IsIn([DocumentType.RNC, DocumentType.CEDULA])
  issuerDocumentType: DocumentType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  issuerDocumentNumber: string;

  /** Usar este bloque desde ya: el bloque activo se cierra en el último número usado. */
  @IsOptional()
  @IsBoolean()
  activateNow?: boolean;
}

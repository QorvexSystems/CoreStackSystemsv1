import { DocumentType, FiscalDocumentPurpose, InvoiceDocumentType } from '@qorvex/database';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePosFiscalDetailsDto {
  @IsEnum(FiscalDocumentPurpose)
  fiscalPurpose: FiscalDocumentPurpose;

  /** Concrete checkout choice. Order Taking no longer chooses NCF/e-CF. */
  @IsOptional()
  @IsIn([
    InvoiceDocumentType.LOCAL_SALE_NOTE,
    InvoiceDocumentType.CONSUMER_ELECTRONIC_32,
    InvoiceDocumentType.FISCAL_CREDIT_ELECTRONIC_31,
  ])
  invoiceDocumentType?: InvoiceDocumentType;

  /**
   * Backward-compatible assertion only. POS never changes the Customer link;
   * when supplied this value must equal the order's current customerId.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerId?: string | null;

  /**
   * One-time fiscal identity captured at checkout. It is persisted only in
   * the order/invoice snapshot and never creates a Customer record.
   */
  @IsOptional()
  @IsIn([DocumentType.RNC, DocumentType.CEDULA])
  documentType?: DocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  documentNumber?: string;

  /**
   * Short-lived, context-bound administrative authorization used only when a
   * fresh DGII registry cannot verify the document. The browser never sends a
   * fiscal name: the backend resolves it from DGII or this authorization.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxIdentityOverrideId?: string;
}

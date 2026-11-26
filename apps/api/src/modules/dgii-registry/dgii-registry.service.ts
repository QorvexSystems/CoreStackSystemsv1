import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DgiiRegistryDatasetStatus,
  DgiiRegistrySource,
  DgiiTaxpayerStatus,
  DocumentType,
  Prisma,
} from '@qorvex/database';
import { normalizeDominicanDocument, validateDominicanDocument } from '../../common/utils/dominican-documents';
import { PrismaService } from '../../prisma/prisma.service';

export type RncLookupResult = {
  documentType: 'RNC' | 'CEDULA';
  outcome: 'VERIFIED' | 'NOT_FOUND' | 'NON_ACTIVE' | 'REGISTRY_STALE' | 'UNAVAILABLE';
  documentNumber: string;
  fiscalName: string | null;
  registryStatus: string | null;
  sourceUpdatedAt: Date | null;
  checkedAt: Date;
};

@Injectable()
export class DgiiRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async lookupRnc(value: string, db: Pick<Prisma.TransactionClient, 'dgiiRegistryDataset'> = this.prisma): Promise<RncLookupResult> {
    return this.lookupIdentity(DocumentType.RNC, value, db);
  }

  async lookupIdentity(documentType: DocumentType, value: string, db: Pick<Prisma.TransactionClient, 'dgiiRegistryDataset'> = this.prisma): Promise<RncLookupResult> {
    if (documentType !== DocumentType.RNC && documentType !== DocumentType.CEDULA) {
      throw new BadRequestException('Selecciona RNC o cédula.');
    }
    if (!validateDominicanDocument(documentType, value)) {
      throw new BadRequestException(documentType === DocumentType.RNC ? 'El RNC no es válido.' : 'La cédula no es válida.');
    }
    const documentNumber = normalizeDominicanDocument(value);
    const checkedAt = new Date();
    const dataset = await db.dgiiRegistryDataset.findFirst({
      where: { status: DgiiRegistryDatasetStatus.ACTIVE, source: DgiiRegistrySource.DGII_OFFICIAL },
      select: {
        sourceUpdatedAt: true,
        records: {
          where: { documentType, documentNumber },
          select: { fiscalName: true, registryStatus: true, status: true },
          take: 1,
        },
      },
    });
    const record = dataset?.records[0];
    const result = (outcome: RncLookupResult['outcome']): RncLookupResult => ({
      outcome,
      documentType,
      documentNumber,
      fiscalName: record?.fiscalName ?? null,
      registryStatus: record?.registryStatus ?? null,
      sourceUpdatedAt: dataset?.sourceUpdatedAt ?? null,
      checkedAt,
    });
    if (!dataset) return result('UNAVAILABLE');
    const configuredHours = Number(this.config.get<string>('DGII_REGISTRY_MAX_AGE_HOURS') ?? '216');
    const maxAgeHours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : 216;
    if (checkedAt.getTime() - dataset.sourceUpdatedAt.getTime() > maxAgeHours * 60 * 60 * 1000) {
      return result('REGISTRY_STALE');
    }
    if (!record) return result('NOT_FOUND');
    return result(record.status === DgiiTaxpayerStatus.ACTIVE ? 'VERIFIED' : 'NON_ACTIVE');
  }

  async requireActiveRnc(value: string, db: Prisma.TransactionClient): Promise<RncLookupResult & { fiscalName: string }> {
    return this.requireActiveIdentity(DocumentType.RNC, value, db);
  }

  async requireActiveIdentity(documentType: DocumentType, value: string, db: Prisma.TransactionClient): Promise<RncLookupResult & { fiscalName: string }> {
    const result = await this.lookupIdentity(documentType, value, db);
    if (result.outcome === 'UNAVAILABLE' || result.outcome === 'REGISTRY_STALE') {
      throw new ServiceUnavailableException('La consulta del padrón DGII no está disponible o necesita actualizarse.');
    }
    if (result.outcome !== 'VERIFIED' || !result.fiscalName) {
      throw new BadRequestException('El RNC o la cédula no figura activo en el padrón DGII.');
    }
    return { ...result, fiscalName: result.fiscalName };
  }
}

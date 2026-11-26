import { Injectable } from '@nestjs/common';
import { DocumentType } from '@qorvex/database';
import { validateDominicanDocument } from '../../common/utils/dominican-documents';
import { PrismaService } from '../../prisma/prisma.service';

export type TaxIdentityLookup = {
  outcome: 'FOUND' | 'NOT_FOUND' | 'INVALID' | 'UNAVAILABLE';
  documentType: 'RNC' | 'CEDULA';
  documentNumber: string;
  name: string | null;
  commercialName: string | null;
  status: string | null;
};

/**
 * Nombre o razón social por RNC/cédula desde el padrón oficial de la DGII importado en DgiiTaxpayer.
 * El padrón solo incluye contribuyentes registrados: muchas cédulas de personas no aparecen.
 */
@Injectable()
export class HotelTaxService {
  private registryLoaded: { value: boolean; checkedAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async lookup(documentType: 'RNC' | 'CEDULA', raw: string): Promise<TaxIdentityLookup> {
    const documentNumber = raw.replace(/\D/g, '');
    const base = { documentType, documentNumber, name: null, commercialName: null, status: null };
    if (!validateDominicanDocument(documentType, documentNumber)) return { ...base, outcome: 'INVALID' };
    const record = await this.prisma.dgiiTaxpayer.findUnique({ where: { documentNumber } });
    if (record && record.documentType === (documentType === 'RNC' ? DocumentType.RNC : DocumentType.CEDULA))
      return {
        ...base,
        outcome: 'FOUND',
        name: record.name,
        commercialName: record.commercialName,
        status: record.status,
      };
    return { ...base, outcome: (await this.isRegistryLoaded()) ? 'NOT_FOUND' : 'UNAVAILABLE' };
  }

  private async isRegistryLoaded() {
    const now = Date.now();
    if (this.registryLoaded && now - this.registryLoaded.checkedAt < 10 * 60_000)
      return this.registryLoaded.value;
    const value = Boolean(await this.prisma.dgiiTaxpayer.findFirst({ select: { documentNumber: true } }));
    this.registryLoaded = { value, checkedAt: now };
    return value;
  }
}

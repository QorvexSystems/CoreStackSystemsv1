import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { FiscalSequenceStatus, InvoiceDocumentType, Prisma } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import {
  normalizeDominicanDocument,
  validateDominicanCedula,
  validateDominicanRnc,
} from '../../common/utils/dominican-documents';
import { CreateFiscalSequenceDto } from './dto/create-fiscal-sequence.dto';
import { CreateElectronicFiscalRangeDto } from './dto/create-electronic-fiscal-range.dto';
import { createElectronicRangeRegistrationClientFromEnvironment } from './electronic-range-registration.client';
import {
  currentBusinessDate,
  expectedLocalNcfPrefix,
  formatLocalNcf,
  isNcfExpirationPast,
  isFiscalCreditNcf,
  isLocalNcfDocumentType,
  parseNcfExpirationDate,
} from './fiscal-number';

@Injectable()
export class FiscalSequencesService {
  private readonly electronicRangeClient = createElectronicRangeRegistrationClientFromEnvironment();

  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    await this.refreshStatuses(tenantId);

    return this.prisma.fiscalSequence.findMany({
      where: { tenantId },
      orderBy: [{ status: 'asc' }, { documentType: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async create(tenantId: string, userId: string, dto: CreateFiscalSequenceDto) {
    if (!isLocalNcfDocumentType(dto.documentType)) {
      throw new BadRequestException('Only local B01 and B02 sequences can be configured.');
    }

    if (dto.startNumber > dto.endNumber) {
      throw new BadRequestException('Fiscal sequence start cannot exceed its end.');
    }

    if (dto.nextNumber < dto.startNumber || dto.nextNumber > dto.endNumber) {
      throw new BadRequestException('Next fiscal number must be inside the authorized range.');
    }

    const authorizationNumber = dto.authorizationNumber?.trim() || null;
    const validUntil = parseNcfExpirationDate(dto.validUntil);

    if (!authorizationNumber) {
      throw new BadRequestException('B01 and B02 require the DGII authorization number.');
    }

    if (isFiscalCreditNcf(dto.documentType) && !validUntil) {
      throw new BadRequestException('B01 requires its DGII expiration date.');
    }

    if (validUntil && isNcfExpirationPast(validUntil)) {
      throw new BadRequestException('The fiscal sequence authorization is already expired.');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { rnc: true },
    });
    if (
      !tenant?.rnc?.trim() ||
      (!validateDominicanRnc(tenant.rnc) && !validateDominicanCedula(tenant.rnc))
    ) {
      throw new BadRequestException(
        'Configure a valid issuer RNC or Dominican ID before registering fiscal sequences.',
      );
    }
    const issuerTaxId = normalizeDominicanDocument(tenant.rnc);

    const prefix = expectedLocalNcfPrefix(dto.documentType);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockSequenceLane(tx, tenantId, dto.documentType);
        await this.refreshSequenceStatuses(tx, tenantId, dto.documentType);

        const overlap = await tx.fiscalSequence.findFirst({
          where: {
            tenantId,
            documentType: dto.documentType,
            startNumber: { lte: dto.endNumber },
            endNumber: { gte: dto.startNumber },
          },
          select: { id: true },
        });

        if (overlap) {
          throw new ConflictException(
            'The authorized range overlaps a sequence already registered.',
          );
        }

        let active = await tx.fiscalSequence.findFirst({
          where: {
            tenantId,
            documentType: dto.documentType,
            status: FiscalSequenceStatus.ACTIVE,
          },
          select: { id: true, issuerTaxId: true, prefix: true },
        });

        if (active && (active.issuerTaxId !== issuerTaxId || active.prefix !== prefix)) {
          throw new ConflictException(
            'The active fiscal sequence belongs to a different issuer or prefix. Review it before adding another range.',
          );
        }

        if (!active) {
          active = await this.promoteNextInactive(tx, tenantId, dto.documentType, issuerTaxId);
        }

        const status = active ? FiscalSequenceStatus.INACTIVE : FiscalSequenceStatus.ACTIVE;
        const sequence = await tx.fiscalSequence.create({
          data: {
            tenantId,
            documentType: dto.documentType,
            prefix,
            startNumber: dto.startNumber,
            endNumber: dto.endNumber,
            nextNumber: dto.nextNumber,
            authorizationNumber,
            issuerTaxId,
            validUntil,
            status,
          },
        });

        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'FISCAL_SEQUENCE_CREATED',
            entity: 'FiscalSequence',
            entityId: sequence.id,
            metadata: {
              documentType: sequence.documentType,
              prefix: sequence.prefix,
              startNumber: sequence.startNumber,
              endNumber: sequence.endNumber,
              nextNumber: sequence.nextNumber,
              authorizationNumber: sequence.authorizationNumber,
              issuerTaxId: sequence.issuerTaxId,
              validUntil: sequence.validUntil?.toISOString().slice(0, 10) ?? null,
              status: sequence.status,
            },
          },
        });

        return sequence;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          'An active or overlapping fiscal sequence was created concurrently.',
        );
      }

      throw error;
    }
  }

  async findAllElectronic(tenantId: string) {
    const ranges = await this.prisma.electronicFiscalRange.findMany({
      where: { tenantId },
      orderBy: [{ ecfType: 'asc' }, { startNumber: 'asc' }, { createdAt: 'asc' }],
    });
    let authoritative = new Map<string, Awaited<ReturnType<NonNullable<typeof this.electronicRangeClient>['readRanges']>>[number]>();
    if (this.electronicRangeClient) {
      try {
        authoritative = new Map(
          (await this.electronicRangeClient.readRanges(tenantId)).map((range) => [
            range.registrationId,
            range,
          ]),
        );
      } catch {
        // Registration remains usable during a short VM4 outage, but the UI must
        // explicitly mark its counters as unavailable instead of presenting stale data.
      }
    }
    return ranges.map((range) => {
      const serialized = this.serializeElectronicRange(range);
      const current = authoritative.get(range.id);
      return {
        ...serialized,
        nextNumber: current?.nextNumber ?? serialized.nextNumber,
        remaining: current?.remaining ?? null,
        used: current?.used ?? null,
        exhausted: current?.exhausted ?? false,
        authoritative: Boolean(current),
      };
    });
  }

  async createElectronic(tenantId: string, userId: string, dto: CreateElectronicFiscalRangeDto) {
    const startNumber = BigInt(dto.startNumber);
    const endNumber = BigInt(dto.endNumber);
    const nextNumber = BigInt(dto.nextNumber);
    if (startNumber > endNumber) {
      throw new BadRequestException('Electronic fiscal range start cannot exceed its end.');
    }
    if (endNumber > 9_999_999_999n) {
      throw new BadRequestException('Electronic fiscal range cannot exceed 9,999,999,999.');
    }
    if (nextNumber < startNumber || nextNumber > endNumber) {
      throw new BadRequestException('Next electronic fiscal number must be inside the range.');
    }
    const authorizationNumber = dto.authorizationNumber.trim();
    if (!authorizationNumber) {
      throw new BadRequestException('DGII authorization is required.');
    }
    const authorizedAt = parseElectronicDate(dto.authorizedAt, 'authorization');
    const validUntil = parseElectronicDate(dto.validUntil, 'expiration');
    if (authorizedAt && validUntil && validUntil < authorizedAt) {
      throw new BadRequestException('Expiration cannot precede the authorization date.');
    }
    if (validUntil && isNcfExpirationPast(validUntil)) {
      throw new BadRequestException('The electronic fiscal authorization is already expired.');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { rnc: true },
    });
    if (
      !tenant?.rnc?.trim() ||
      (!validateDominicanRnc(tenant.rnc) && !validateDominicanCedula(tenant.rnc))
    ) {
      throw new BadRequestException(
        'A valid issuer RNC or Dominican ID is required for electronic ranges.',
      );
    }
    const issuerTaxId = normalizeDominicanDocument(tenant.rnc);
    const prefix = `E${dto.ecfType}`;

    try {
      const range = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${tenantId}:${issuerTaxId}:${dto.ecfType}`}, 0::bigint)
          ) IS NULL AS "locked"
        `;
        const overlap = await tx.electronicFiscalRange.findFirst({
          where: {
            tenantId,
            issuerTaxId,
            ecfType: dto.ecfType,
            startNumber: { lte: endNumber },
            endNumber: { gte: startNumber },
          },
          select: { id: true },
        });
        if (overlap) {
          throw new ConflictException('The authorized e-NCF range overlaps an existing range.');
        }
        const created = await tx.electronicFiscalRange.create({
          data: {
            tenantId,
            issuerTaxId,
            ecfType: dto.ecfType,
            prefix,
            startNumber,
            endNumber,
            nextNumber,
            authorizationNumber,
            authorizedAt,
            validUntil,
            createdById: userId,
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'ELECTRONIC_FISCAL_RANGE_CREATED',
            entity: 'ElectronicFiscalRange',
            entityId: created.id,
            metadata: {
              ecfType: created.ecfType,
              prefix: created.prefix,
              startNumber: created.startNumber.toString(),
              endNumber: created.endNumber.toString(),
              nextNumber: created.nextNumber.toString(),
              authorizationNumber: created.authorizationNumber,
              issuerTaxId: created.issuerTaxId,
              authorizedAt: created.authorizedAt?.toISOString().slice(0, 10) ?? null,
              validUntil: created.validUntil?.toISOString().slice(0, 10) ?? null,
              syncStatus: created.syncStatus,
            },
          },
        });
        return created;
      });
      return this.serializeElectronicRange(range);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2004', 'P2010'].includes(error.code)
      ) {
        throw new ConflictException('The authorized e-NCF range conflicts with an existing range.');
      }
      throw error;
    }
  }

  async retryElectronic(tenantId: string, rangeId: string, userId: string) {
    const range = await this.prisma.electronicFiscalRange.findFirst({
      where: { id: rangeId, tenantId },
    });
    if (!range) throw new BadRequestException('Electronic fiscal range was not found.');
    if (range.syncStatus === 'SYNCED') return this.serializeElectronicRange(range);
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.electronicFiscalRange.update({
        where: { id: range.id },
        data: { syncStatus: 'PENDING', nextSyncAt: new Date(), lastErrorCode: null },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'ELECTRONIC_FISCAL_RANGE_SYNC_RETRIED',
          entity: 'ElectronicFiscalRange',
          entityId: range.id,
        },
      });
      return result;
    });
    return this.serializeElectronicRange(updated);
  }

  async assertElectronicAvailable(tenantId: string, ecfType?: 31 | 32) {
    if (!this.electronicRangeClient) {
      throw new BadRequestException(
        'El núcleo fiscal electrónico no está configurado para este cliente.',
      );
    }
    let ranges: Awaited<ReturnType<typeof this.electronicRangeClient.readRanges>>;
    try {
      ranges = await this.electronicRangeClient.readRanges(tenantId);
    } catch {
      throw new BadRequestException(
        'No fue posible confirmar las secuencias e-NCF disponibles en el núcleo fiscal.',
      );
    }
    const today = currentBusinessDate().toISOString().slice(0, 10);
    const usable = ranges.some(
      (range) =>
        (ecfType === undefined ? range.ecfType === 31 || range.ecfType === 32 : range.ecfType === ecfType) &&
        !range.exhausted &&
        BigInt(range.remaining) > 0n &&
        (!range.authorizedAt || range.authorizedAt <= today) &&
        (!range.validUntil || range.validUntil >= today),
    );
    if (!usable) {
      throw new BadRequestException(
        ecfType
          ? `No hay una secuencia E${ecfType} vigente y disponible en el núcleo fiscal.`
          : 'No hay secuencias E31 o E32 vigentes y disponibles en el núcleo fiscal.',
      );
    }
  }

  private serializeElectronicRange<
    T extends {
      startNumber: bigint;
      endNumber: bigint;
      nextNumber: bigint;
    },
  >(range: T) {
    return {
      ...range,
      startNumber: range.startNumber.toString(),
      endNumber: range.endNumber.toString(),
      nextNumber: range.nextNumber.toString(),
    };
  }

  async reserve(tx: Prisma.TransactionClient, tenantId: string, documentType: InvoiceDocumentType) {
    if (!isLocalNcfDocumentType(documentType)) {
      throw new BadRequestException('Only local B01 and B02 invoices are enabled.');
    }

    await this.lockSequenceLane(tx, tenantId, documentType);
    await this.refreshSequenceStatuses(tx, tenantId, documentType);

    const issuer = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { rnc: true },
    });
    const currentIssuerTaxId = issuer?.rnc ? normalizeDominicanDocument(issuer.rnc) : '';
    let sequence = await tx.fiscalSequence.findFirst({
      where: {
        tenantId,
        documentType,
        status: FiscalSequenceStatus.ACTIVE,
      },
      orderBy: [{ startNumber: 'asc' }, { createdAt: 'asc' }],
    });

    if (sequence && (!sequence.issuerTaxId || sequence.issuerTaxId !== currentIssuerTaxId)) {
      throw new BadRequestException(
        `The active ${expectedLocalNcfPrefix(documentType)} sequence belongs to a different issuer tax identity.`,
      );
    }

    if (!sequence) {
      sequence = await this.promoteNextInactive(tx, tenantId, documentType, currentIssuerTaxId);
    }

    if (!sequence) {
      throw new BadRequestException(
        `No active or queued ${expectedLocalNcfPrefix(documentType)} sequence is configured.`,
      );
    }

    if (sequence.validUntil && isNcfExpirationPast(sequence.validUntil)) {
      throw new BadRequestException(
        `The active ${expectedLocalNcfPrefix(documentType)} sequence is expired.`,
      );
    }

    if (sequence.nextNumber > sequence.endNumber) {
      throw new BadRequestException(
        `The active ${expectedLocalNcfPrefix(documentType)} sequence is exhausted.`,
      );
    }

    const number = sequence.nextNumber;
    const ncf = formatLocalNcf(documentType, sequence.prefix, number);
    const exhausted = number >= sequence.endNumber;

    await tx.fiscalSequence.update({
      where: { id: sequence.id },
      data: {
        nextNumber: number + 1,
        ...(exhausted ? { status: FiscalSequenceStatus.EXHAUSTED } : {}),
      },
    });

    if (exhausted) {
      await this.promoteNextInactive(tx, tenantId, documentType, currentIssuerTaxId);
    }

    return {
      id: sequence.id,
      ncf,
      number,
      prefix: sequence.prefix,
      authorizationNumber: sequence.authorizationNumber,
      issuerTaxId: sequence.issuerTaxId,
      validUntil: sequence.validUntil,
    };
  }

  /**
   * Preflight only: verifies that checkout can later reserve this local NCF.
   * It intentionally does not consume a number; reserve() remains the sole
   * allocation point inside the final invoice transaction.
   */
  async assertAvailable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentType: InvoiceDocumentType,
  ) {
    if (!isLocalNcfDocumentType(documentType)) {
      throw new BadRequestException('Only local B01 and B02 invoices are enabled.');
    }

    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { rnc: true },
    });
    if (
      !tenant?.rnc?.trim() ||
      (!validateDominicanRnc(tenant.rnc) && !validateDominicanCedula(tenant.rnc))
    ) {
      throw new BadRequestException(
        'Configure a valid issuer RNC or Dominican ID before confirming fiscal details.',
      );
    }

    const prefix = expectedLocalNcfPrefix(documentType);
    const issuerTaxId = normalizeDominicanDocument(tenant.rnc);
    const sequence = await tx.fiscalSequence.findFirst({
      where: {
        tenantId,
        documentType,
        prefix,
        issuerTaxId,
        status: {
          in: [FiscalSequenceStatus.ACTIVE, FiscalSequenceStatus.INACTIVE],
        },
        nextNumber: { lte: tx.fiscalSequence.fields.endNumber },
        OR: [{ validUntil: null }, { validUntil: { gte: currentBusinessDate() } }],
      },
      select: { id: true },
    });

    if (!sequence) {
      throw new BadRequestException(
        `No usable ${prefix} sequence is configured. Register the DGII-authorized range before confirming this invoice type.`,
      );
    }
  }

  async refreshStatuses(tenantId: string) {
    await this.prisma.$transaction([
      this.prisma.fiscalSequence.updateMany({
        where: {
          tenantId,
          status: {
            in: [FiscalSequenceStatus.ACTIVE, FiscalSequenceStatus.INACTIVE],
          },
          validUntil: { lt: currentBusinessDate() },
        },
        data: { status: FiscalSequenceStatus.EXPIRED },
      }),
      this.prisma.fiscalSequence.updateMany({
        where: {
          tenantId,
          status: {
            in: [FiscalSequenceStatus.ACTIVE, FiscalSequenceStatus.INACTIVE],
          },
          nextNumber: { gt: this.prisma.fiscalSequence.fields.endNumber },
        },
        data: { status: FiscalSequenceStatus.EXHAUSTED },
      }),
    ]);
  }

  private async lockSequenceLane(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentType: InvoiceDocumentType,
  ) {
    await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${tenantId}:${documentType}`}, 0::bigint)
      ) IS NULL AS "locked"
    `;
  }

  private async refreshSequenceStatuses(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentType: InvoiceDocumentType,
  ) {
    await tx.fiscalSequence.updateMany({
      where: {
        tenantId,
        documentType,
        status: {
          in: [FiscalSequenceStatus.ACTIVE, FiscalSequenceStatus.INACTIVE],
        },
        validUntil: { lt: currentBusinessDate() },
      },
      data: { status: FiscalSequenceStatus.EXPIRED },
    });
    await tx.fiscalSequence.updateMany({
      where: {
        tenantId,
        documentType,
        status: {
          in: [FiscalSequenceStatus.ACTIVE, FiscalSequenceStatus.INACTIVE],
        },
        nextNumber: { gt: tx.fiscalSequence.fields.endNumber },
      },
      data: { status: FiscalSequenceStatus.EXHAUSTED },
    });
  }

  private async promoteNextInactive(
    tx: Prisma.TransactionClient,
    tenantId: string,
    documentType: InvoiceDocumentType,
    issuerTaxId: string,
  ) {
    if (!issuerTaxId) {
      return null;
    }

    const sequence = await tx.fiscalSequence.findFirst({
      where: {
        tenantId,
        documentType,
        prefix: expectedLocalNcfPrefix(documentType),
        issuerTaxId,
        status: FiscalSequenceStatus.INACTIVE,
        nextNumber: { lte: tx.fiscalSequence.fields.endNumber },
        OR: [{ validUntil: null }, { validUntil: { gte: currentBusinessDate() } }],
      },
      orderBy: [{ startNumber: 'asc' }, { createdAt: 'asc' }],
    });

    if (!sequence) {
      return null;
    }

    return tx.fiscalSequence.update({
      where: { id: sequence.id },
      data: { status: FiscalSequenceStatus.ACTIVE },
    });
  }
}

function parseElectronicDate(value: string | undefined, label: string) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BadRequestException(`Electronic fiscal ${label} date must use YYYY-MM-DD.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`Electronic fiscal ${label} date is invalid.`);
  }
  return date;
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createElectronicRangeRegistrationClientFromEnvironment,
  ElectronicRangeTransportError,
  type ElectronicRangeRegistration,
} from './electronic-range-registration.client';

type ClaimedRange = ElectronicRangeRegistration & { syncAttempts: number };

@Injectable()
export class ElectronicRangeSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ElectronicRangeSyncService.name);
  private readonly client = createElectronicRangeRegistrationClientFromEnvironment();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private started = false;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.start();
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.client) {
      this.logger.log('ELECTRONIC_RANGE_SYNC_DISABLED');
      return;
    }
    this.logger.log('ELECTRONIC_RANGE_SYNC_STARTED');
    this.run();
  }

  private schedule(delay = 5000) {
    if (this.stopped || !this.client) return;
    this.timer = setTimeout(() => this.run(), delay);
  }

  private run() {
    if (this.stopped || !this.client || this.running) return;
    this.running = this.tick()
      .catch(() => {
        this.logger.error('ELECTRONIC_RANGE_SYNC_TICK_FAILED');
      })
      .finally(() => {
        this.running = undefined;
        this.schedule();
      });
  }

  private async claim(): Promise<ClaimedRange | null> {
    const rows = await this.prisma.$queryRaw<ClaimedRange[]>`
      WITH candidate AS (
        SELECT "id" FROM "ElectronicFiscalRange"
        WHERE (
          (
            "syncStatus" = 'PENDING'
            AND "nextSyncAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          )
          OR (
            "syncStatus" = 'SYNCING'
            AND "updatedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 minutes'
          )
        )
        ORDER BY "nextSyncAt", "createdAt"
        LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE "ElectronicFiscalRange" range
      SET "syncStatus" = 'SYNCING', "syncAttempts" = "syncAttempts" + 1,
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC'), "lastErrorCode" = NULL
      FROM candidate WHERE range."id" = candidate."id"
      RETURNING range."id" AS "registrationId", range."tenantId", range."issuerTaxId" AS "issuerRnc",
        range."ecfType", range."startNumber"::text AS "startNumber",
        range."endNumber"::text AS "endNumber", range."nextNumber"::text AS "nextNumber",
        range."authorizationNumber",
        to_char(range."authorizedAt", 'YYYY-MM-DD') AS "authorizedAt",
        to_char(range."validUntil", 'YYYY-MM-DD') AS "validUntil",
        range."syncAttempts"
    `;
    return rows[0] ?? null;
  }

  private async tick() {
    const range = await this.claim();
    if (!range || !this.client) return;
    try {
      const ack = await this.client(range);
      await this.prisma.electronicFiscalRange.updateMany({
        where: { id: range.registrationId, syncStatus: 'SYNCING' },
        data: {
          syncStatus: 'SYNCED',
          remoteRangeId: ack.rangeId,
          syncedAt: new Date(),
          lastErrorCode: null,
        },
      });
      this.logger.log('ELECTRONIC_RANGE_SYNCED');
    } catch (error) {
      const rejected =
        error instanceof ElectronicRangeTransportError && error.outcome === 'REJECTED';
      const delaySeconds = Math.min(3600, 15 * 2 ** Math.min(range.syncAttempts, 8));
      await this.prisma.electronicFiscalRange.updateMany({
        where: { id: range.registrationId, syncStatus: 'SYNCING' },
        data: {
          syncStatus: rejected ? 'FAILED' : 'PENDING',
          lastErrorCode: rejected ? 'REMOTE_REJECTED' : 'REMOTE_UNCONFIRMED',
          ...(rejected ? {} : { nextSyncAt: new Date(Date.now() + delaySeconds * 1000) }),
        },
      });
      this.logger.warn(rejected ? 'ELECTRONIC_RANGE_REJECTED' : 'ELECTRONIC_RANGE_UNCONFIRMED');
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}

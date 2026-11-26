import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { assertSyntheticPreview, type PreviewPreparationRow } from './preview-preparation';
import { prepareRemotePreview } from './preview-remote';
import { recoverPreviewRehearsalOnce } from './preview-rehearsal';

const tenant = 'cmt397emm0002nm0ogb50l2q6';

/** Only recovers already-authorized, immutable preview operations. Does not
 * create orders/invoices, charge customers, sign or transmit to DGII. */
export async function recoverRemotePreparationOnce(
  tx: Prisma.TransactionClient,
  process = prepareRemotePreview,
) {
  assertSyntheticPreview();
  const rows = await tx.$queryRawUnsafe<PreviewPreparationRow[]>(
    `SELECT id::text,snapshot,planned_at,revision,state,result,error_code,execution_mode,remote_ack
     FROM corestack_preview_ecf.preparation
     WHERE tenant_id=$1 AND execution_mode='REMOTE_VM4' AND state='PENDING'
       AND recovery_attempts<10 AND recovery_after<=clock_timestamp()
     ORDER BY recovery_after,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    tenant,
  );
  if (!rows[0]) return 'IDLE';
  // Schedule BEFORE processing: terminal evidence cannot be updated afterwards.
  await tx.$executeRawUnsafe(
    `UPDATE corestack_preview_ecf.preparation
     SET recovery_attempts=recovery_attempts+1,
       recovery_after=clock_timestamp()+make_interval(secs=>least(300,5*(2^recovery_attempts)::integer))
     WHERE id=$1::bigint AND tenant_id=$2 AND state='PENDING'`,
    rows[0].id,
    tenant,
  );
  const result = await process(tx, rows[0], tenant);
  return result.state;
}

@Injectable()
export class PreviewRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreviewRecoveryService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running?: Promise<void>;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.RIVNU_PREVIEW_REMOTE_RECOVERY !== 'true') return;
    assertSyntheticPreview();
    if (process.env.RIVNU_PREVIEW_REMOTE_FISCAL !== 'true')
      throw new Error('PREVIEW_REMOTE_RECOVERY_REQUIRES_REMOTE_MODE');
    this.schedule();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, 5000);
    this.timer.unref();
  }

  private async tick() {
    try {
      await this.prisma.$transaction((tx) => recoverRemotePreparationOnce(tx), { timeout: 30000 });
      await this.prisma.$transaction((tx) => recoverPreviewRehearsalOnce(tx), { timeout: 15000 });
    } catch {
      // Never print tokens, XML, connection strings or uncontrolled error text.
      this.logger.warn('PREVIEW_REMOTE_RECOVERY_UNCONFIRMED');
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}

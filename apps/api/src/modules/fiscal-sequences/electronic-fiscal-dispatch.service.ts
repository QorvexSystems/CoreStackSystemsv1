import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ElectronicDocumentProvider,
  ElectronicDocumentStatus,
  InvoiceFiscalStatus,
} from '@qorvex/database';
import { PrismaService } from '../../prisma/prisma.service';
import { electronicSalesDigest, validateElectronicSalesRequest } from '../fiscal-documents/electronic-sales-guard';
import {
  createElectronicRangeRegistrationClientFromEnvironment,
  ElectronicRangeTransportError,
} from './electronic-range-registration.client';

type Claim = {
  id: string;
  tenantId: string;
  invoiceId: string;
  issuerRnc: string;
  operationId: string;
  requestText: string;
  payloadSha256: string;
  leaseToken: string;
  attempts: number;
};

@Injectable()
export class ElectronicFiscalDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ElectronicFiscalDispatchService.name);
  private readonly client = createElectronicRangeRegistrationClientFromEnvironment();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private reconciliationTimer?: ReturnType<typeof setTimeout>;
  private reconciling?: Promise<void>;
  private wakeRequested = false;
  private stopped = false;
  private reconcileCursor = 0n;
  private readonly reconcileAfter = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!this.client) {
      this.logger.warn('ELECTRONIC_FISCAL_DISPATCH_DISABLED');
      return;
    }
    this.schedule(1000);
    this.scheduleReconciliation(1000);
  }

  // A hint only: the committed outbox and periodic scans remain authoritative.
  // Never send inside the sale transaction or create another fiscal operation.
  wake() {
    if (this.stopped || !this.client) return;
    if (this.running) this.wakeRequested = true;
    else this.schedule(0);
    if (!this.reconciling) this.scheduleReconciliation(0);
  }

  private schedule(delay = 2000) {
    if (this.stopped || !this.client) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  }

  private run() {
    if (this.running || this.stopped || !this.client) return;
    let delay = 2000;
    this.running = this.tick()
      .then(worked => { if (worked) delay = 0; })
      .catch(() => {
        delay = 5000;
        this.logger.error('ELECTRONIC_FISCAL_DISPATCH_CYCLE_FAILED');
      })
      .finally(() => {
        this.running = undefined;
        this.schedule(this.wakeRequested ? 0 : delay);
        this.wakeRequested = false;
      });
  }

  private scheduleReconciliation(delay: number) {
    if (this.stopped || !this.client) return;
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    this.reconciliationTimer = setTimeout(() => this.runReconciliation(), delay);
  }

  private runReconciliation() {
    if (this.reconciling || this.stopped || !this.client) return;
    let delay = 2000;
    // Separate lane: a slow registration POST cannot hold up other invoices'
    // acceptance/printing. This lane performs GETs only, bounded to four at once.
    this.reconciling = this.reconcileOne()
      .then(active => { if (active) delay = 750; })
      .catch(() => {
        delay = 5000;
        this.logger.warn('ELECTRONIC_FISCAL_RECONCILIATION_CYCLE_FAILED');
      })
      .finally(() => {
        this.reconciling = undefined;
        this.scheduleReconciliation(delay);
      });
  }

  private async claim(): Promise<Claim | null> {
    const rows = await this.prisma.$queryRaw<Claim[]>`
      WITH candidate AS (
        SELECT id FROM corestack_erp_fiscal.dispatch
        WHERE environment='production' AND attempts<10
          AND ((state='PENDING' AND next_attempt_at<=clock_timestamp())
            OR (state='RUNNING' AND lease_until<clock_timestamp()))
        ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE corestack_erp_fiscal.dispatch d SET
        state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),
        lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      FROM candidate c WHERE d.id=c.id
      RETURNING d.id::text,d.tenant_id AS "tenantId",d.invoice_id AS "invoiceId",
        d.issuer_rnc AS "issuerRnc",d.request_text AS "requestText",
        d.operation_id AS "operationId",
        d.payload_sha256 AS "payloadSha256",d.lease_token::text AS "leaseToken",d.attempts
    `;
    return rows[0] ?? null;
  }

  private async tick() {
    await this.expireAbandonedLease();
    const claim = await this.claim();
    if (!claim || !this.client) return false;
    await this.dispatchClaim(claim);
    if (!this.reconciling) this.scheduleReconciliation(0);
    return true;
  }

  private async dispatchClaim(claim: Claim) {
    let requestBody: unknown;
    try {
      requestBody = JSON.parse(claim.requestText);
      const scope = { tenantId: claim.tenantId, issuerRnc: claim.issuerRnc, environment: 'production' as const };
      validateElectronicSalesRequest(requestBody, scope);
      const identity = requestBody as { source: { documentId: string }; operationId: string };
      if (identity.source.documentId !== claim.invoiceId || identity.operationId !== claim.operationId ||
          electronicSalesDigest(scope, requestBody) !== claim.payloadSha256) throw new Error('INVALID_SNAPSHOT');
    } catch {
      await this.fail(claim, true, 'INVALID_SNAPSHOT');
      return;
    }
    try {
      const ack = await this.client!.registerFiscalRequest(
        claim.tenantId,
        claim.issuerRnc,
        requestBody,
        claim.payloadSha256,
      );
      if (ack.payloadSha256 !== claim.payloadSha256 ||
          !new RegExp(`^E${(requestBody as { type: number }).type}\\d{10}$`).test(ack.encf)) {
        throw new ElectronicRangeTransportError('UNCONFIRMED', 'ACK_PAYLOAD_HASH_MISMATCH');
      }
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.$executeRaw`
          UPDATE corestack_erp_fiscal.dispatch SET state='REGISTERED',document_id=${ack.documentId},
            encf=${ack.encf},lease_token=NULL,lease_until=NULL,last_error=NULL,
            updated_at=clock_timestamp()
          WHERE id=${BigInt(claim.id)} AND lease_token=${claim.leaseToken}::uuid
            AND state='RUNNING' AND payload_sha256=${ack.payloadSha256}
        `;
        if (changed !== 1) throw new Error('FISCAL_DISPATCH_LEASE_LOST');
        const linked = await tx.invoice.updateMany({
          where: { id: claim.invoiceId, tenantId: claim.tenantId, eNcf: null, status: 'PENDING_ECF',
            fiscalStatus: { in: ['PENDING_SEQUENCE','FAILED'] } },
          data: {
            eNcf: ack.encf,
            invoiceNumber: `RIV-${ack.encf}`,
            fiscalStatus: InvoiceFiscalStatus.PENDING_SIGNATURE,
          },
        });
        if (linked.count !== 1) throw new Error('FISCAL_INVOICE_PROJECTION_CHANGED');
        await tx.electronicDocument.upsert({
          where: { invoiceId: claim.invoiceId },
          create: {
            tenantId: claim.tenantId,
            invoiceId: claim.invoiceId,
            provider: ElectronicDocumentProvider.DGII_DIRECT,
            status: ElectronicDocumentStatus.PROCESSING,
            externalId: ack.documentId,
          },
          update: {
            status: ElectronicDocumentStatus.PROCESSING,
            externalId: ack.documentId,
            errorMessage: null,
          },
        });
      });
      this.logger.log('ELECTRONIC_FISCAL_REQUEST_RESERVED');
    } catch (error) {
      const rejected =
        error instanceof ElectronicRangeTransportError && error.outcome === 'REJECTED';
      const digestMismatch = error instanceof ElectronicRangeTransportError &&
        error.diagnosticCode === 'ACK_PAYLOAD_HASH_MISMATCH';
      // A valid acknowledgement with a different digest is NOT a transient
      // network failure. The remote reservation may already exist. Preserve
      // evidence and stop for reconciliation instead of repeating ten POSTs.
      await this.fail(claim, rejected || digestMismatch,
        digestMismatch ? 'INVALID_SNAPSHOT' : undefined);
    }
  }

  private async reconcileOne() {
    if (!this.client) return false;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; tenantId: string; invoiceId: string; documentId: string; encf: string }>
    >`
        SELECT d.id::text AS id,d.tenant_id AS "tenantId",d.invoice_id AS "invoiceId",
          d.document_id AS "documentId",d.encf
        FROM corestack_erp_fiscal.dispatch d
        JOIN "Invoice" i ON i.id=d.invoice_id AND i."tenantId"=d.tenant_id
        WHERE d.environment='production' AND d.state='REGISTERED'
          -- FAILED/REJECTED may be a stale ERP projection after an operator
          -- safely retries the same durable core document. The isolated core
          -- remains authoritative, so reconcile those states as well instead
          -- of permanently hiding a later acceptance.
          AND i."fiscalStatus" IN ('PENDING_SIGNATURE','SIGNED','SENT','FAILED','REJECTED')
        ORDER BY (d.id>${this.reconcileCursor}) DESC,d.id LIMIT 4
    `;
    if (!rows.length) return false;
    this.reconcileCursor = BigInt(rows[rows.length - 1]!.id);
    const now = Date.now();
    const ready = rows.filter(candidate => (this.reconcileAfter.get(candidate.id) ?? 0) <= now);
    await Promise.all(ready.map(candidate => this.reconcileCandidate(candidate)));
    return true;
  }

  private deferReconciliation(id: string, delay: number) {
    // In-memory hints only. Bound memory even if operators leave old rejected
    // invoices open; restart simply resumes authoritative read-only queries.
    if (this.reconcileAfter.size >= 1024) {
      const oldest = this.reconcileAfter.keys().next().value;
      if (oldest !== undefined) this.reconcileAfter.delete(oldest);
    }
    this.reconcileAfter.delete(id);
    this.reconcileAfter.set(id, Date.now() + delay);
  }

  private async reconcileCandidate(candidate: {
    id: string; tenantId: string; invoiceId: string; documentId: string; encf: string;
  }) {
    try {
      const status = await this.client!.readDocumentStatus(
        candidate.tenantId,
        candidate.documentId,
      );
      if (status.sourceDocumentId !== candidate.invoiceId || status.encf !== candidate.encf) {
        this.deferReconciliation(candidate.id, 15_000);
        this.logger.error('ELECTRONIC_FISCAL_STATUS_IDENTITY_MISMATCH');
        return;
      }
      const fiscalStatus =
        status.delivery === 'ACCEPTED' || status.delivery === 'ACCEPTED_CONDITIONALLY'
          ? InvoiceFiscalStatus.ACCEPTED
          : status.delivery === 'REJECTED' || status.delivery === 'REVIEW_REQUIRED'
            ? InvoiceFiscalStatus.REJECTED
            : ['POLLING', 'RECONCILE', 'SENDING'].includes(status.delivery)
              ? InvoiceFiscalStatus.SENT
              : status.signing === 'FAILED' || status.preparation === 'FAILED'
                  ? InvoiceFiscalStatus.FAILED
                  : status.signing === 'ENQUEUED'
                    ? InvoiceFiscalStatus.SIGNED
                    : InvoiceFiscalStatus.PENDING_SIGNATURE;
      const electronicStatus =
        fiscalStatus === InvoiceFiscalStatus.ACCEPTED
          ? ElectronicDocumentStatus.ACCEPTED
          : fiscalStatus === InvoiceFiscalStatus.REJECTED
            ? ElectronicDocumentStatus.REJECTED
            : fiscalStatus === InvoiceFiscalStatus.FAILED
              ? ElectronicDocumentStatus.FAILED
              : fiscalStatus === InvoiceFiscalStatus.SIGNED
                ? ElectronicDocumentStatus.SIGNED
                : fiscalStatus === InvoiceFiscalStatus.SENT
                  ? ElectronicDocumentStatus.SENT
                  : ElectronicDocumentStatus.PROCESSING;
      if (fiscalStatus === InvoiceFiscalStatus.FAILED || fiscalStatus === InvoiceFiscalStatus.REJECTED) {
        this.deferReconciliation(candidate.id, 15_000);
      } else {
        this.reconcileAfter.delete(candidate.id);
      }
      await this.prisma.$transaction(async tx => {
        const changed = await tx.invoice.updateMany({
          where: { id: candidate.invoiceId, tenantId: candidate.tenantId, eNcf: candidate.encf,
            fiscalStatus: { in: ['PENDING_SIGNATURE','SIGNED','SENT','FAILED','REJECTED'] } },
          data: {
            fiscalStatus,
            ...(fiscalStatus === InvoiceFiscalStatus.ACCEPTED
              ? { status: 'ACCEPTED' as const }
              : fiscalStatus === InvoiceFiscalStatus.REJECTED ||
                  fiscalStatus === InvoiceFiscalStatus.FAILED
                ? { status: 'REJECTED' as const }
                : { status: 'PENDING_ECF' as const }),
          },
        });
        if (changed.count !== 1) return;
        await tx.electronicDocument.updateMany({
          where: { invoiceId: candidate.invoiceId, tenantId: candidate.tenantId, externalId: candidate.documentId },
          data: { status: electronicStatus, trackId: status.trackId,
            errorMessage: fiscalStatus === InvoiceFiscalStatus.FAILED || fiscalStatus === InvoiceFiscalStatus.REJECTED
              ? 'El documento fiscal requiere revisión. No repitas el cobro ni crees otra factura para esta venta.' : null },
        });
      });
    } catch {
      this.deferReconciliation(candidate.id, 5000);
      this.logger.warn('ELECTRONIC_FISCAL_STATUS_UNCONFIRMED');
      // Read-only reconciliation rotates to the next document; no fiscal POST.
    }
  }

  private async expireAbandonedLease() {
    await this.prisma.$transaction(async tx => {
      const expired = await tx.$queryRaw<Array<{ invoiceId: string; tenantId: string; id: string }>>`
        WITH candidate AS (
          SELECT id FROM corestack_erp_fiscal.dispatch
          WHERE environment='production' AND state='RUNNING' AND attempts>=10
            AND lease_until<clock_timestamp()
          ORDER BY lease_until,id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE corestack_erp_fiscal.dispatch d SET state='REVIEW_REQUIRED',
          lease_token=NULL,lease_until=NULL,last_error='ATTEMPTS_EXHAUSTED',updated_at=clock_timestamp()
        FROM candidate c WHERE d.id=c.id
        RETURNING d.id::text,d.invoice_id AS "invoiceId",d.tenant_id AS "tenantId"
      `;
      for (const row of expired) {
        const changed = await tx.invoice.updateMany({
          where: { id: row.invoiceId, tenantId: row.tenantId, eNcf: null, fiscalStatus: 'PENDING_SEQUENCE' },
          data: { fiscalStatus: InvoiceFiscalStatus.FAILED },
        });
        if (changed.count === 1) await tx.auditLog.create({data:{tenantId:row.tenantId,
          entity:'Invoice',entityId:row.invoiceId,action:'FISCAL_DISPATCH_ABANDONED_LEASE_REQUIRES_REVIEW',
          metadata:{dispatchId:row.id,noFiscalResubmission:true}}});
      }
    });
  }

  private async fail(claim: Claim, terminal: boolean, reason?: 'INVALID_SNAPSHOT') {
    await this.prisma.$transaction(async (tx) => {
      const exhausted = terminal || claim.attempts >= 10;
      const changed = await tx.$executeRaw`
        UPDATE corestack_erp_fiscal.dispatch SET
          state=${exhausted ? 'REVIEW_REQUIRED' : 'PENDING'},
          next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(300,30*attempts)),
          lease_token=NULL,lease_until=NULL,
          last_error=${reason ?? (terminal ? 'REJECTED' : exhausted ? 'ATTEMPTS_EXHAUSTED' : 'UNCONFIRMED')},
          updated_at=clock_timestamp()
        WHERE id=${BigInt(claim.id)} AND lease_token=${claim.leaseToken}::uuid AND state='RUNNING'
      `;
      // A stale worker must never downgrade an invoice after another worker
      // has already registered/accepted it or acquired a newer lease.
      if (changed !== 1) return;
      if (exhausted) {
        await tx.invoice.updateMany({
          where: { id: claim.invoiceId, tenantId: claim.tenantId, eNcf: null,
            fiscalStatus: { notIn: ['ACCEPTED','CANCELLED'] } },
          data: { fiscalStatus: InvoiceFiscalStatus.FAILED },
        });
        await tx.auditLog.create({data:{tenantId:claim.tenantId,entity:'Invoice',entityId:claim.invoiceId,
          action:'FISCAL_DISPATCH_REQUIRES_REVIEW',metadata:{dispatchId:claim.id,attempts:claim.attempts,
            reason:reason ?? (terminal?'REJECTED':'ATTEMPTS_EXHAUSTED'),noReplacementOperation:true}}});
      }
    });
    this.logger.warn(reason === 'INVALID_SNAPSHOT'
      ? 'ELECTRONIC_FISCAL_REQUEST_SNAPSHOT_REVIEW_REQUIRED'
      : terminal ? 'ELECTRONIC_FISCAL_REQUEST_REJECTED' : 'ELECTRONIC_FISCAL_REQUEST_DEFERRED');
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    await Promise.all([this.running, this.reconciling]);
  }
}

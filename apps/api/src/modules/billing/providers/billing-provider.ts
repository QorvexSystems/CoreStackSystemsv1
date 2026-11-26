import type { ElectronicDocumentProvider, ElectronicDocumentStatus } from '@qorvex/database';

export type BillingSubmissionInput = {
  tenantId: string;
  invoiceId: string;
};

export type BillingSubmissionResult = {
  provider: ElectronicDocumentProvider;
  status: ElectronicDocumentStatus;
  externalId?: string;
  errorMessage?: string;
};

export interface BillingProvider {
  readonly provider: ElectronicDocumentProvider;
  submit(input: BillingSubmissionInput): Promise<BillingSubmissionResult>;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

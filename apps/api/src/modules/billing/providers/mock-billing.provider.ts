import { ElectronicDocumentProvider, ElectronicDocumentStatus } from '@qorvex/database';
import {
  BillingProvider,
  BillingSubmissionInput,
  BillingSubmissionResult,
} from './billing-provider';

export class MockBillingProvider implements BillingProvider {
  readonly provider = ElectronicDocumentProvider.MOCK;

  async submit(input: BillingSubmissionInput): Promise<BillingSubmissionResult> {
    return {
      provider: this.provider,
      status: ElectronicDocumentStatus.PENDING,
      externalId: `mock-${input.invoiceId}`,
    };
  }
}

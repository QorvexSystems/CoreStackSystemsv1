import { Inject, Injectable } from '@nestjs/common';
import { BILLING_PROVIDER, BillingProvider } from './providers/billing-provider';

@Injectable()
export class BillingService {
  constructor(@Inject(BILLING_PROVIDER) private readonly provider: BillingProvider) {}

  getConfiguredProvider() {
    return {
      activeProvider: this.provider.provider,
      futureProviders: ['GAE', 'DGII'],
      note: 'Foundation only. No real DGII XML, signature or fiscal submission is implemented.',
    };
  }
}

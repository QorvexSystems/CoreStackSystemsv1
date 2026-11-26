import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BILLING_PROVIDER } from './providers/billing-provider';
import { MockBillingProvider } from './providers/mock-billing.provider';

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    {
      provide: BILLING_PROVIDER,
      useClass: MockBillingProvider,
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}

import { Module } from '@nestjs/common';
import { DiscountApprovalsController } from './discount-approvals.controller';
import { DiscountApprovalsService } from './discount-approvals.service';

@Module({
  controllers: [DiscountApprovalsController],
  providers: [DiscountApprovalsService],
})
export class DiscountApprovalsModule {}

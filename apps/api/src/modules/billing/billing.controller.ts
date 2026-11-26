import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { BillingService } from './billing.service';

@Controller('billing')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('provider')
  provider(@TenantId() tenantId: string) {
    return {
      tenantId,
      ...this.billingService.getConfiguredProvider(),
    };
  }
}

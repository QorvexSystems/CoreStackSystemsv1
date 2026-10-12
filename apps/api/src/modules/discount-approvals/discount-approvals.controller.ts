import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { DecideDiscountApprovalDto } from './dto/discount-approval.dto';
import { DiscountApprovalsService } from './discount-approvals.service';

@Controller('discount-approvals')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
export class DiscountApprovalsController {
  constructor(private readonly discountApprovalsService: DiscountApprovalsService) {}

  @Get('notifications')
  notifications(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.discountApprovalsService.notifications(tenantId, user);
  }

  @Post(':id/approve')
  approve(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideDiscountApprovalDto,
  ) {
    return this.discountApprovalsService.approve(tenantId, user, id, dto);
  }

  @Post(':id/reject')
  reject(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideDiscountApprovalDto,
  ) {
    return this.discountApprovalsService.reject(tenantId, user, id, dto);
  }

  @Delete(':id/notification')
  dismiss(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.discountApprovalsService.dismiss(tenantId, user, id);
  }
}

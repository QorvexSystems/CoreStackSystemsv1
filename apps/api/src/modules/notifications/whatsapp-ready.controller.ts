import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { WhatsappReadyService } from './whatsapp-ready.service';

@Controller('notifications/whatsapp')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
export class WhatsappReadyController {
  constructor(private readonly whatsapp: WhatsappReadyService) {}
  @Get('status')
  @RequirePermissions('workorders.view')
  status(@TenantId() tenantId: string) {
    return this.whatsapp.status(tenantId);
  }
}

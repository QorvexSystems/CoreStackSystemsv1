import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@qorvex/database';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { BulkAvailabilityDto, BulkCategoryDto, BulkIdsDto, BulkPublishDto, SkuReviewQueryDto } from './web-catalog.dto';
import { WebCatalogBulkService } from './web-catalog-bulk.service';

/** Preparación masiva del catálogo importado. Se registra ANTES que WebCatalogController para que `review` y `bulk/*` no se lean como :id. */
@Controller('web-products')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
export class WebCatalogBulkController {
  constructor(private readonly bulk: WebCatalogBulkService) {}

  @Get('review')
  review(@TenantId() tenantId: string) {
    return this.bulk.review(tenantId);
  }

  @Get('sku-review')
  skuReview(@TenantId() tenantId: string, @Query() query: SkuReviewQueryDto) {
    return this.bulk.skuReview(tenantId, { limit: query.limit, cursor: query.cursor, groupIds: query.groupId ? [query.groupId] : undefined });
  }

  @Post('bulk/category')
  @HttpCode(200)
  category(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: BulkCategoryDto) {
    return this.bulk.assignCategory(tenantId, user.id, dto.ids, dto.categoryLabel, dto.overwrite === true);
  }

  @Post('bulk/sku-approve')
  @HttpCode(200)
  approveSkus(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: BulkIdsDto) {
    return this.bulk.approveSkus(tenantId, user.id, dto.ids);
  }

  @Post('bulk/availability')
  @HttpCode(200)
  availability(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: BulkAvailabilityDto) {
    return this.bulk.setAvailability(tenantId, user.id, dto.ids, dto.policy);
  }

  @Post('bulk/activate')
  @HttpCode(200)
  activate(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: BulkIdsDto) {
    return this.bulk.activateVariants(tenantId, user.id, dto.ids);
  }

  @Post('bulk/publish')
  @HttpCode(200)
  publish(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: BulkPublishDto) {
    return this.bulk.publish(tenantId, user.id, dto.ids, dto.confirm);
  }
}

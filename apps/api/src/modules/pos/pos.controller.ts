import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { PosService } from './pos.service';

@Controller('pos')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
export class PosController {
  constructor(private readonly posService: PosService) {}

  @Get('products/search')
  searchProducts(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q = '',
  ) {
    return this.posService.searchProducts(tenantId, user, q);
  }

  @Get('products/barcode/:barcode')
  findByBarcode(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('barcode') barcode: string,
  ) {
    return this.posService.findByBarcode(tenantId, user, barcode);
  }

  @Get('store-credits/lookup')
  lookupStoreCredit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q = '',
  ) {
    return this.posService.lookupStoreCredit(tenantId, user, q);
  }

  @Post('sales/preview')
  previewSale(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteSaleDto,
  ) {
    return this.posService.previewSale(tenantId, user, dto);
  }

  @Post('sales/complete')
  completeSale(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteSaleDto,
  ) {
    return this.posService.completeSale(tenantId, user, dto);
  }
}

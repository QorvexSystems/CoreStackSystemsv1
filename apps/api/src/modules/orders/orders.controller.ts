import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { ProductInventoryDestination } from '@qorvex/database';
import {
  CancelSalesOrderDto,
  ClaimSalesOrderDto,
  CreateSalesOrderDto,
  SaveOrderTakingDraftDto,
} from './dto/create-sales-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('origin') origin?: string,
  ) {
    return this.ordersService.findAll(tenantId, user, status, origin);
  }

  @Get('drafts')
  findDrafts(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.findDrafts(tenantId, user);
  }

  @Post('drafts')
  createDraft(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaveOrderTakingDraftDto,
  ) {
    return this.ordersService.createDraft(tenantId, user, dto);
  }

  @Patch('drafts/:id')
  updateDraft(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SaveOrderTakingDraftDto,
  ) {
    return this.ordersService.updateDraft(tenantId, user, id, dto);
  }

  @Post('drafts/:id/discard')
  discardDraft(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.discardDraft(tenantId, user, id);
  }

  @Get('products/search')
  searchProducts(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q = '',
    @Query('inventorySource') inventorySource?: ProductInventoryDestination | 'ALL',
  ) {
    return this.ordersService.searchProducts(tenantId, user, q, inventorySource);
  }

  @Get('products/:productId')
  findOrderProduct(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Query('inventorySource') inventorySource?: ProductInventoryDestination,
  ) {
    return this.ordersService.findOrderProduct(tenantId, user, productId, inventorySource);
  }

  @Get('products/barcode/:barcode')
  findProductByBarcode(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('barcode') barcode: string,
    @Query('inventorySource') inventorySource?: ProductInventoryDestination | 'ALL',
  ) {
    return this.ordersService.findProductByBarcode(tenantId, user, barcode, inventorySource);
  }

  @Get(':id')
  findOne(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.findOne(tenantId, user, id);
  }

  @Post()
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSalesOrderDto,
  ) {
    return this.ordersService.create(tenantId, user, dto);
  }

  @Post(':id/claim')
  claim(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ClaimSalesOrderDto,
  ) {
    return this.ordersService.claim(tenantId, user, id, dto);
  }

  @Post(':id/release')
  release(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.release(tenantId, user, id);
  }

  @Post(':id/cancel')
  cancel(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelSalesOrderDto,
  ) {
    return this.ordersService.cancel(tenantId, user, id, dto);
  }

  @Post(':id/accept')
  accept(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.accept(tenantId, user, id);
  }

  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateSalesOrderDto,
  ) {
    return this.ordersService.update(tenantId, user, id, dto);
  }
}

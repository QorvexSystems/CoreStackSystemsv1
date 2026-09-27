import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@qorvex/database';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { DispatchWarehouseProductDto } from './dto/dispatch-warehouse-product.dto';
import { CreateWarehouseProductDto, UpdateWarehouseProductDto } from './dto/warehouse-product.dto';
import {
  ConfirmWarehouseDispatchDto,
  CountWarehouseStockDto,
  ReceiveWarehouseBatchDto,
  ReceiveWarehouseStockDto,
} from './dto/warehouse-stock-movement.dto';
import { WarehouseService } from './warehouse.service';

@Controller('warehouse')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
@Roles(
  Role.ACCOUNTANT,
  Role.WAREHOUSE_KEEPER,
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.QORVEX_SUPER_ADMIN,
)
export class WarehouseController {
  constructor(private readonly warehouseService: WarehouseService) {}

  @Get('stock')
  findStock(@TenantId() tenantId: string) {
    return this.warehouseService.findStock(tenantId);
  }

  @Get('products')
  findProducts(@TenantId() tenantId: string) {
    return this.warehouseService.findProducts(tenantId);
  }

  @Post('products')
  @Roles(
    Role.ACCOUNTANT,
    Role.WAREHOUSE_KEEPER,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.QORVEX_SUPER_ADMIN,
  )
  createProduct(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWarehouseProductDto,
  ) {
    return this.warehouseService.createProduct(tenantId, user.id, dto);
  }

  @Post('products/:id/dispatch')
  @Roles(Role.WAREHOUSE_KEEPER, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  dispatchProduct(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DispatchWarehouseProductDto,
  ) {
    return this.warehouseService.dispatchProduct(tenantId, user.id, id, dto);
  }

  @Post('products/:id/receive')
  @Roles(Role.WAREHOUSE_KEEPER, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  receiveStock(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReceiveWarehouseStockDto,
  ) {
    return this.warehouseService.receiveStock(tenantId, user.id, id, dto);
  }

  @Post('stock/receive-batch')
  @Roles(Role.WAREHOUSE_KEEPER, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  receiveStockBatch(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReceiveWarehouseBatchDto,
  ) {
    return this.warehouseService.receiveStockBatch(tenantId, user.id, dto);
  }

  @Post('products/:id/count')
  @Roles(Role.WAREHOUSE_KEEPER, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  countStock(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CountWarehouseStockDto,
  ) {
    return this.warehouseService.countStock(tenantId, user.id, id, dto);
  }

  @Patch('products/:id/activate')
  @Roles(Role.ACCOUNTANT, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  activateProduct(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.warehouseService.activateProduct(tenantId, id);
  }

  @Get('dispatches/pending')
  findPendingDispatches(@TenantId() tenantId: string) {
    return this.warehouseService.findPendingDispatches(tenantId);
  }

  @Post('dispatches/:id/confirm')
  @Roles(Role.WAREHOUSE_KEEPER, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  confirmOrderDispatch(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmWarehouseDispatchDto,
  ) {
    return this.warehouseService.confirmOrderDispatch(tenantId, user.id, id, dto);
  }

  @Patch('products/:id')
  @Roles(Role.ACCOUNTANT, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  updateProduct(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateWarehouseProductDto,
  ) {
    return this.warehouseService.updateProduct(tenantId, user.id, id, dto);
  }

  @Delete('products/:id')
  @Roles(Role.ACCOUNTANT, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  removeProduct(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.warehouseService.removeProduct(tenantId, user.id, id);
  }

  @Get('movements')
  findMovements(@TenantId() tenantId: string) {
    return this.warehouseService.findMovements(tenantId);
  }
}

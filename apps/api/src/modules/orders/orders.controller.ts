import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { ProductInventoryDestination } from '@qorvex/database';
import {
  AcceptSalesOrderDto,
  CancelSalesOrderDto,
  ClaimSalesOrderDto,
  CreateSalesOrderDto,
} from './dto/create-sales-order.dto';
import { OrdersService } from './orders.service';
import { UpdateOrderWorkflowDto } from './dto/update-order-workflow.dto';
import {
  AddCorporateOrderUnitsDto,
  UpdateCorporateOrderUnitDto,
} from './dto/corporate-order-unit.dto';

@Controller('orders')
@UseGuards(JwtAuthGuard, TenantMembershipGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ) {
    return this.ordersService.findAll(tenantId, user, status);
  }

  @Get('products/search')
  searchProducts(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q = '',
    @Query('inventorySource') inventorySource?: ProductInventoryDestination,
  ) {
    return this.ordersService.searchProducts(tenantId, user, q, inventorySource);
  }

  @Get('products/barcode/:barcode')
  findProductByBarcode(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('barcode') barcode: string,
    @Query('inventorySource') inventorySource?: ProductInventoryDestination,
  ) {
    return this.ordersService.findProductByBarcode(tenantId, user, barcode, inventorySource);
  }

  @Get('kanban/board')
  getKanban(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.getKanban(tenantId, user);
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
    @Body() dto: AcceptSalesOrderDto,
  ) {
    return this.ordersService.accept(tenantId, user, id, dto);
  }

  @Patch(':id/workflow')
  updateWorkflow(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderWorkflowDto,
  ) {
    return this.ordersService.updateWorkflow(tenantId, user, id, dto);
  }

  @Post(':id/design-approval')
  approveDesign(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.approveDesign(tenantId, user, id);
  }

  @Post(':id/quality-approval')
  approveQuality(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ordersService.approveQuality(tenantId, user, id);
  }

  @Post(':id/corporate-units')
  addCorporateUnits(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddCorporateOrderUnitsDto,
  ) {
    return this.ordersService.addCorporateUnits(tenantId, user, id, dto);
  }

  @Post(':id/corporate-units/import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
      fileFilter: (_request, file, callback) => {
        const valid = file.originalname.toLowerCase().endsWith('.xlsx');
        callback(
          valid ? null : new BadRequestException('Solo se permiten archivos Excel .xlsx.'),
          valid,
        );
      },
    }),
  )
  importCorporateUnits(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: { originalname: string; buffer: Buffer; size: number },
  ) {
    return this.ordersService.importCorporateUnits(tenantId, user, id, file);
  }

  @Delete(':id/corporate-units/:unitId')
  removeCorporateUnit(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('unitId') unitId: string) {
    return this.ordersService.removeCorporateUnit(tenantId, user, id, unitId);
  }

  @Patch(':id/corporate-units/:unitId')
  updateCorporateUnit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: UpdateCorporateOrderUnitDto,
  ) {
    return this.ordersService.updateCorporateUnit(tenantId, user, id, unitId, dto);
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

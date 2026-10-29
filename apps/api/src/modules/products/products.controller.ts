import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@qorvex/database';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import type { UploadedProductImageFile } from './products.service';

@Controller('products')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @Roles(
    Role.ACCOUNTANT,
    Role.CASHIER,
    Role.ORDER_TAKER,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.QORVEX_SUPER_ADMIN,
  )
  findAll(@TenantId() tenantId: string, @Query('q') q?: string) {
    return this.productsService.findAll(tenantId, q);
  }

  @Get('search')
  @Roles(
    Role.ACCOUNTANT,
    Role.CASHIER,
    Role.ORDER_TAKER,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.QORVEX_SUPER_ADMIN,
  )
  search(@TenantId() tenantId: string, @Query('q') q = '') {
    return this.productsService.search(tenantId, q);
  }

  @Get('barcode/:barcode')
  @Roles(Role.CASHIER, Role.ORDER_TAKER, Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
  findByBarcode(@TenantId() tenantId: string, @Param('barcode') barcode: string) {
    return this.productsService.findByBarcode(tenantId, barcode);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.ADMIN)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProductDto,
  ) {
    return this.productsService.create(tenantId, user.id, dto);
  }

  @Post('image')
  @Roles(Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedProductImageFile,
  ) {
    return this.productsService.uploadImage(tenantId, user.id, file);
  }

  @Get(':id')
  @Roles(
    Role.ACCOUNTANT,
    Role.CASHIER,
    Role.ORDER_TAKER,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.QORVEX_SUPER_ADMIN,
  )
  findOne(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.findOne(tenantId, id);
  }

  @Post(':id/generate-barcode')
  @Roles(Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.ADMIN)
  generateBarcode(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.productsService.generateBarcode(tenantId, user.id, id);
  }

  @Post(':id/label')
  @Roles(Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.ADMIN)
  getLabel(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.productsService.getLabel(tenantId, user.id, id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.ADMIN)
  update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(tenantId, user.id, id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN, Role.ADMIN)
  remove(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.productsService.remove(tenantId, user.id, id);
  }
}

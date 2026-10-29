import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@qorvex/database';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { TenantMembershipGuard } from '../../common/guards/tenant-membership.guard';
import { AuthenticatedUser } from '../../common/types/authenticated-request';
import { CreateWebProductDto, ListWebProductsQueryDto, UpdateWebProductDto, UpdateWebVariantDto, UploadWebImageDto, WebVariantDto } from './web-catalog.dto';
import { WebCatalogImagesService, type UploadedImage } from './web-catalog-images.service';
import { MAX_WEB_IMAGE_BYTES } from './web-image-storage';
import { WebCatalogService } from './web-catalog.service';

/** Administración de productos web desde el ERP (usuarios autenticados del tenant con rol administrativo). */
@Controller('web-products')
@UseGuards(JwtAuthGuard, TenantMembershipGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.QORVEX_SUPER_ADMIN)
export class WebCatalogController {
  constructor(
    private readonly service: WebCatalogService,
    private readonly images: WebCatalogImagesService,
  ) {}

  @Get()
  list(@TenantId() tenantId: string, @Query() query: ListWebProductsQueryDto) {
    return this.service.list(tenantId, query);
  }

  @Get('categories')
  categories(@TenantId() tenantId: string) {
    return this.service.categories(tenantId);
  }

  @Get(':id')
  get(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.service.get(tenantId, id);
  }

  @Post()
  create(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWebProductDto) {
    return this.service.create(tenantId, user.id, dto);
  }

  @Patch(':id')
  update(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateWebProductDto) {
    return this.service.update(tenantId, user.id, id, dto);
  }

  @Post(':id/variants')
  addVariant(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: WebVariantDto) {
    return this.service.addVariant(tenantId, user.id, id, dto);
  }

  @Patch(':id/variants/:variantId')
  updateVariant(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('variantId') variantId: string, @Body() dto: UpdateWebVariantDto) {
    return this.service.updateVariant(tenantId, user.id, id, variantId, dto);
  }

  /** Sube una imagen (JPG/PNG/WEBP, máx. 5 MB) al almacenamiento público y la agrega a la galería. */
  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_WEB_IMAGE_BYTES } }))
  uploadImage(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @UploadedFile() file: UploadedImage | undefined, @Body() body: UploadWebImageDto) {
    return this.images.upload(tenantId, user.id, id, file, {
      alt: body.alt,
      variantIds: body.variantIds ? body.variantIds.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
      primary: body.primary === 'true',
    });
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.publish(tenantId, user.id, id);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@TenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.unpublish(tenantId, user.id, id);
  }
}

import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ChannelOrdersService } from './channel-orders.service';
import { ChannelAuthGuard } from './channel-auth.guard';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';
import { WebCatalogBulkController } from './web-catalog-bulk.controller';
import { WebCatalogBulkService } from './web-catalog-bulk.service';
import { WebCatalogController } from './web-catalog.controller';
import { WebCatalogImagesService } from './web-catalog-images.service';
import { WebCatalogService } from './web-catalog.service';

@Module({
  imports: [OrdersModule],
  // El controlador masivo va primero: sus rutas fijas (`review`, `bulk/*`) no deben interpretarse como `:id`.
  controllers: [WebCatalogBulkController, WebCatalogController, ChannelController],
  providers: [WebCatalogService, WebCatalogBulkService, WebCatalogImagesService, ChannelService, ChannelOrdersService, ChannelAuthGuard],
})
export class WebCatalogModule {}

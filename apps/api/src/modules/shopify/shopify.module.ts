import { Module } from '@nestjs/common';
import { ShopifyAdminController, ShopifyWebhookController } from './shopify.controller';
import { ShopifyService } from './shopify.service';

@Module({
  controllers: [ShopifyWebhookController, ShopifyAdminController],
  providers: [ShopifyService],
  exports: [ShopifyService],
})
export class ShopifyModule {}

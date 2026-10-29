import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { ShopifyModule } from '../shopify/shopify.module';

@Module({
  imports: [NotificationsModule, ShopifyModule],
  controllers: [PosController],
  providers: [PosService],
})
export class PosModule {}

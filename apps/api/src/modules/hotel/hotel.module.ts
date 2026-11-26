import { Module } from '@nestjs/common';
import { ChannelAuthGuard } from '../web-catalog/channel-auth.guard';
import { HotelChannelController } from './hotel-channel.controller';
import { HotelChannelService } from './hotel-channel.service';
import { HotelDashboardService } from './hotel-dashboard.service';
import { HotelPushService } from './hotel-push.service';
import { HotelTaxService } from './hotel-tax.service';
import { HotelController } from './hotel.controller';
import { HotelService } from './hotel.service';

@Module({
  controllers: [HotelController, HotelChannelController],
  providers: [
    HotelService,
    HotelChannelService,
    HotelDashboardService,
    HotelPushService,
    HotelTaxService,
    ChannelAuthGuard,
  ],
  exports: [HotelService],
})
export class HotelModule {}

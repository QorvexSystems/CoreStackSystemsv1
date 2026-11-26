import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { FiscalSequencesModule } from '../fiscal-sequences/fiscal-sequences.module';

@Module({
  imports: [FiscalSequencesModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}

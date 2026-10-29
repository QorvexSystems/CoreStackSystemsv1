import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [ProductsModule, CustomersModule, OrdersModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}

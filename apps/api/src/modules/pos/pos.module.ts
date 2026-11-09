import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { DgiiRegistryModule } from '../dgii-registry/dgii-registry.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

@Module({
  imports: [NotificationsModule, DgiiRegistryModule],
  controllers: [PosController],
  providers: [PosService],
})
export class PosModule {}

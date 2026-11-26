import { WhatsappReadyService } from './whatsapp-ready.service';
import { WhatsappReadyController } from './whatsapp-ready.controller';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ResendService } from './resend.service';
import { DocumentEmailController } from './document-email.controller';
import { DocumentEmailService } from './document-email.service';

@Module({
  imports: [PrismaModule],
  controllers: [DocumentEmailController, WhatsappReadyController],
  providers: [ResendService, DocumentEmailService, WhatsappReadyService],
  exports: [ResendService],
})
export class NotificationsModule {}

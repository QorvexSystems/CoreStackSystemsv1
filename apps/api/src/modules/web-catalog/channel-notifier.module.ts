import { Global, Module } from '@nestjs/common';
import { ChannelNotifierService } from './channel-notifier.service';

/** Global para que los servicios existentes (p. ej. Productos) puedan avisar al e-commerce sin acoplarse al módulo web. */
@Global()
@Module({ providers: [ChannelNotifierService], exports: [ChannelNotifierService] })
export class ChannelNotifierModule {}

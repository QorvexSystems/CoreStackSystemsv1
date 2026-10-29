import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@qorvex/database';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ transactionOptions: { maxWait: 10000, timeout: 30000 } });
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

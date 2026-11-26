import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get()
  root() {
    return this.check();
  }

  @Get('health')
  check() {
    return {
      status: 'ok',
      service: 'corestack-api',
      timestamp: new Date().toISOString(),
    };
  }
}

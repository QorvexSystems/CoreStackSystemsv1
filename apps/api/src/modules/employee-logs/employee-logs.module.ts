import { Module } from '@nestjs/common';
import { EmployeeLogsController } from './employee-logs.controller';
import { EmployeeLogsService } from './employee-logs.service';

@Module({
  controllers: [EmployeeLogsController],
  providers: [EmployeeLogsService],
})
export class EmployeeLogsModule {}

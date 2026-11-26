import { Module } from '@nestjs/common';
import { FiscalSequencesController } from './fiscal-sequences.controller';
import { FiscalSequencesService } from './fiscal-sequences.service';
import { ElectronicRangeSyncService } from './electronic-range-sync.service';
import { ElectronicFiscalDispatchService } from './electronic-fiscal-dispatch.service';

@Module({
  controllers: [FiscalSequencesController],
  providers: [FiscalSequencesService, ElectronicRangeSyncService, ElectronicFiscalDispatchService],
  exports: [FiscalSequencesService, ElectronicFiscalDispatchService],
})
export class FiscalSequencesModule {}

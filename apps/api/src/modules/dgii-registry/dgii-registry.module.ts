import { Module } from '@nestjs/common';
import { DgiiRegistryImporterService } from './dgii-registry-importer.service';
import { DgiiRegistryService } from './dgii-registry.service';

@Module({
  providers: [DgiiRegistryImporterService, DgiiRegistryService],
  exports: [DgiiRegistryImporterService, DgiiRegistryService],
})
export class DgiiRegistryModule {}

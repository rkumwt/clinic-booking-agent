import { Module } from '@nestjs/common';
import { SlotLockService } from './slot-lock.service';
import { SlotsController } from './slots.controller';
import { SlotsJobs } from './slots.jobs';
import { SlotsService } from './slots.service';

@Module({
  controllers: [SlotsController],
  providers: [SlotsService, SlotLockService, SlotsJobs],
  exports: [SlotsService, SlotLockService],
})
export class SlotsModule {}

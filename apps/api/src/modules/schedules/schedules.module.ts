import { Module } from '@nestjs/common';
import {
  AvailabilityConfigService,
  HolidaysController,
  LocationScheduleController,
  ResourceScheduleController,
} from './availability-config.js';
import { BlocksController, BlocksService } from './blocks.js';

/** Agenda: horarios semanales, excepciones por fecha, feriados y bloqueos. */
@Module({
  controllers: [
    LocationScheduleController,
    ResourceScheduleController,
    HolidaysController,
    BlocksController,
  ],
  providers: [AvailabilityConfigService, BlocksService],
})
export class SchedulesModule {}

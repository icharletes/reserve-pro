import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from '../config/app-config.js';
import { DatabaseModule } from '../platform/database/database.module.js';
import { LoggingModule } from '../platform/logging/logger.js';
import { MaintenanceProcessor } from './maintenance/maintenance.processor.js';
import { MaintenanceService } from './maintenance/maintenance.service.js';

/**
 * Composición del PROCESO WORKER (ADR-002): mismo código y mismos módulos que la API, otro punto de entrada.
 * Los processors solo invocan casos de uso; no contienen lógica de negocio propia.
 */
@Module({
  imports: [ClsModule.forRoot({ global: true }), ConfigModule, LoggingModule, DatabaseModule],
  providers: [MaintenanceService, MaintenanceProcessor],
  exports: [MaintenanceProcessor, MaintenanceService],
})
export class WorkerModule {}

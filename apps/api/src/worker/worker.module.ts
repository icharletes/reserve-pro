import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from '../config/app-config.js';
import { DatabaseModule } from '../platform/database/database.module.js';
import { LoggingModule } from '../platform/logging/logger.js';
import { AuditModule } from '../platform/audit/audit.module.js';
import { SystemDb } from './maintenance/system-db.js';
import { EmailModule } from '../platform/email/email.module.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { DispatchService } from './notifications/dispatch.service.js';
import { NotificationsProcessor } from './notifications/notifications.processor.js';
import { MaintenanceProcessor } from './maintenance/maintenance.processor.js';
import { MaintenanceService } from './maintenance/maintenance.service.js';

/**
 * Composición del PROCESO WORKER (ADR-002): mismo código y mismos módulos que la API, otro punto de entrada.
 * Los processors solo invocan casos de uso; no contienen lógica de negocio propia.
 */
@Module({
  imports: [
    ClsModule.forRoot({ global: true }),
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    AuditModule,
    EmailModule,
  ],
  providers: [
    SystemDb,
    MaintenanceService,
    MaintenanceProcessor,
    NotificationsService,
    DispatchService,
    NotificationsProcessor,
  ],
  exports: [MaintenanceProcessor, MaintenanceService],
})
export class WorkerModule {}

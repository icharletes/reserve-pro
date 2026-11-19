import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import type { Request } from 'express';
import { ProblemFilter } from './common/problem.filter.js';
import { ConfigModule } from './config/app-config.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { SchedulesModule } from './modules/schedules/schedules.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module.js';
import { MembersModule } from './modules/members/members.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { TenantsModule } from './modules/tenants/tenants.module.js';
import { AuditModule } from './platform/audit/audit.module.js';
import { AuthGuard, PermissionsGuard } from './platform/auth/auth.guard.js';
import { AuthModule } from './platform/auth/auth.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { EmailModule } from './platform/email/email.module.js';
import { LoggingModule } from './platform/logging/logger.js';
import {
  PostAuthRateLimitGuard,
  PreAuthRateLimitGuard,
  RateLimitModule,
} from './platform/rate-limit/rate-limit.module.js';
import { RedisModule } from './platform/redis/redis.module.js';
import { OpenApiModule } from './platform/openapi/openapi.service.js';
import { RbacModule } from './platform/rbac/rbac.module.js';

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        // El id lo fija el middleware temprano de `configureApp` (cabecera x-request-id o uuid).
        idGenerator: (req: Request & { id?: string }) => req.id ?? crypto.randomUUID(),
        setup: (cls, req: Request) => {
          cls.set('ip', req.ip);
          cls.set('userAgent', req.get('user-agent'));
        },
      },
    }),
    ConfigModule,
    LoggingModule,
    RedisModule,
    RateLimitModule,
    DatabaseModule,
    RbacModule,
    AuditModule,
    EmailModule,
    AuthModule,
    TenantsModule,
    MembersModule,
    AuditLogsModule,
    CatalogModule,
    SchedulesModule,
    CalendarModule,
    ReservationsModule,
    HealthModule,
    OpenApiModule,
  ],
  providers: [
    // El ORDEN importa: límite por IP (barato, protege la BD) -> autenticación -> límite por usuario/empresa -> permisos.
    { provide: APP_GUARD, useClass: PreAuthRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PostAuthRateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}

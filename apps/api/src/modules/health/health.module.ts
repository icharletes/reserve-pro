import { Controller, Get, HttpException, Module } from '@nestjs/common';
import { TenantDb } from '../../platform/database/database.module.js';
import { Public } from '../../platform/rbac/authz.decorators.js';

@Controller('health')
export class HealthController {
  constructor(private readonly tdb: TenantDb) {}

  /** Liveness: el proceso responde. */
  @Public()
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: las dependencias críticas responden (base de datos). */
  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.tdb.global.$queryRaw`SELECT 1`;
      return { status: 'ok', checks: { database: 'up' } };
    } catch {
      throw new HttpException({ status: 'unavailable', checks: { database: 'down' } }, 503);
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { z as zod } from 'zod';
import { Controller, Get, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TenantDb } from '../../platform/database/database.module.js';
import { RedisService } from '../../platform/redis/redis.module.js';
import { Public } from '../../platform/rbac/authz.decorators.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: el proceso responde. */
  @ApiDoc({
    summary: 'Liveness: el proceso responde',
    response: zod.object({ status: zod.literal('ok') }),
  })
  @Public()
  @Get()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: las dependencias críticas responden (base de datos). */
  @ApiDoc({
    summary: 'Readiness: base de datos y Redis',
    description: 'Devuelve 503 con el detalle por dependencia si alguna falla.',
    response: zod.object({
      status: zod.enum(['ok', 'unavailable']),
      checks: zod.object({ database: zod.enum(['up', 'down']), redis: zod.enum(['up', 'down']) }),
    }),
    errors: { 503: 'Alguna dependencia no responde' },
  })
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = { database: 'up', redis: 'up' };
    try {
      await this.tdb.global.$queryRaw`SELECT 1`;
    } catch {
      checks.database = 'down';
    }
    if (!(await this.redis.ping())) checks.redis = 'down';
    const ok = Object.values(checks).every((v) => v === 'up');
    // 503 con el detalle por dependencia (un HttpException lo convertiría en problem+json y lo perdería).
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}

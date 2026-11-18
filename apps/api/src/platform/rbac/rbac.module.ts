import { Global, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { PERMISSIONS } from '@reservepro/contracts';
import { LOGGER } from '../logging/logger.js';
import { TenantDb } from '../database/database.module.js';

/** Sincroniza el catálogo de permisos del código con la tabla `permissions` en cada arranque. */
@Injectable()
export class PermissionsSyncService implements OnModuleInit {
  constructor(
    private readonly tdb: TenantDb,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    const db = this.tdb.global;
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      await db.permissions.upsert({ where: { key }, create: { key, description }, update: { description } });
    }
    // Los permisos obsoletos NO se borran automáticamente (podrían estar asignados a roles): solo se avisa.
    const known = new Set(Object.keys(PERMISSIONS));
    const stale = (await db.permissions.findMany({ select: { key: true } })).filter((p) => !known.has(p.key));
    if (stale.length > 0) {
      this.logger.warn({ stale: stale.map((s) => s.key) }, 'permisos en BD ausentes del catálogo del código');
    }
  }
}

@Global()
@Module({ providers: [PermissionsSyncService], exports: [PermissionsSyncService] })
export class RbacModule {}

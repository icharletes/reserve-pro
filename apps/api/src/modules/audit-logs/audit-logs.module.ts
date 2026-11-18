import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { type AuditLogView, type AuditQuery, auditQuery } from '@reservepro/contracts';
import { type Page, decodeCursor, toPage } from '../../common/pagination.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

@Injectable()
export class AuditLogsService {
  constructor(private readonly tdb: TenantDb) {}

  /**
   * Consulta de auditoría de la empresa activa, de lo más reciente a lo más antiguo.
   * Paginación por `id` descendente: los ids son UUIDv7, ordenables por tiempo (ver common/pagination.ts).
   * RLS garantiza que solo se vean filas del tenant activo, sin importar los filtros.
   */
  async list(query: AuditQuery): Promise<Page<AuditLogView>> {
    const before = decodeCursor(query.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.audit_logs.findMany({
        where: {
          ...(before ? { id: { lt: before } } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(query.entityType ? { entity_type: query.entityType } : {}),
          ...(query.entityId ? { entity_id: query.entityId } : {}),
          ...(query.actorId ? { actor_id: query.actorId } : {}),
          ...(query.from || query.to
            ? { created_at: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
            : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
    );

    const page = toPage(rows, query.limit, (r) => r.id);
    const actorIds = [...new Set(page.items.map((r) => r.actor_id).filter((x): x is string => !!x))];
    const names = new Map(
      (await this.tdb.global.users.findMany({ where: { id: { in: actorIds } }, select: { id: true, full_name: true } })).map(
        (u) => [u.id, u.full_name],
      ),
    );

    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorName: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
        before: r.before,
        after: r.after,
        requestId: r.request_id,
        ip: r.ip,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }
}

@Controller('tenants/current/audit-logs')
export class AuditLogsController {
  constructor(private readonly service: AuditLogsService) {}

  @RequirePermissions('audit:read')
  @Get()
  list(@Query(new ZodPipe(auditQuery)) query: AuditQuery) {
    return this.service.list(query);
  }
}

@Module({ controllers: [AuditLogsController], providers: [AuditLogsService] })
export class AuditLogsModule {}

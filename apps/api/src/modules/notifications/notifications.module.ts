import { Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import {
  type NotificationListQuery,
  type NotificationView,
  notificationListQuery,
  notificationView,
  pageOf,
  uuid,
} from '@reservepro/contracts';
import type { Prisma } from '@reservepro/database';
import { Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import { type Page, decodeCursor, toPage } from '../../common/pagination.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

const include = {
  reservations: { select: { code: true } },
  customers: { select: { first_name: true, last_name: true } },
} satisfies Prisma.notificationsInclude;
type Row = Prisma.notificationsGetPayload<{ include: typeof include }>;

const toView = (n: Row): NotificationView => ({
  id: n.id,
  channel: n.channel,
  type: n.type,
  recipient: n.recipient,
  subject: n.subject,
  status: n.status as NotificationView['status'],
  attempts: n.attempts,
  lastError: n.last_error,
  reservationId: n.reservation_id,
  reservationCode: n.reservations?.code ?? null,
  customerName: n.customers
    ? [n.customers.first_name, n.customers.last_name].filter(Boolean).join(' ')
    : null,
  createdAt: n.created_at.toISOString(),
  sentAt: n.sent_at?.toISOString() ?? null,
});

/**
 * Centro de comunicaciones (Fase 5B): qué se envió a cada cliente y en qué quedó. La API NO envía emails (solo
 * el worker, ADR-017): reintentar deja un evento en el outbox, en la misma transacción, y el worker lo procesa
 * por el mismo camino deduplicado.
 */
@Injectable()
export class NotificationsAdminService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: NotificationListQuery): Promise<Page<NotificationView>> {
    // Orden: más recientes primero. El cursor es el id (UUIDv7, ordenable por tiempo): `id < cursor`.
    const before = decodeCursor(q.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.notifications.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}),
          ...(q.reservationId ? { reservation_id: q.reservationId } : {}),
          ...(before ? { id: { lt: before } } : {}),
        },
        include,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
    );
    const page = toPage(rows, q.limit, (r) => r.id);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async retry(id: string): Promise<NotificationView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const row = await tx.notifications.findFirst({ where: { id }, include });
      if (!row) throw Errors.notFound('Comunicación');
      if (row.status !== 'failed') {
        throw Errors.invalidTransition('Solo se pueden reintentar las comunicaciones fallidas');
      }
      const updated = await tx.notifications.update({
        where: { id },
        data: { status: 'queued', last_error: null },
        include,
      });
      await tx.outbox_events.create({
        data: {
          id: uuidv7(),
          tenant_id: this.tdb.tenantId,
          aggregate_type: 'notification',
          aggregate_id: id,
          type: 'notification.retry',
          payload: { notificationId: id },
        },
      });
      await this.audit.record(tx, {
        action: 'notification.retry_requested',
        entityType: 'notification',
        entityId: id,
      });
      return toView(updated);
    });
  }
}

const idParam = new ZodPipe(uuid);

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsAdminService) {}

  @ApiDoc({
    summary: 'Centro de comunicaciones',
    description:
      'Emails enviados a clientes, más recientes primero. Filtros: `status`, `reservationId`.',
    response: pageOf(notificationView),
  })
  @RequirePermissions('notifications:read')
  @Get()
  list(@Query(new ZodPipe(notificationListQuery)) q: NotificationListQuery) {
    return this.notifications.list(q);
  }

  @ApiDoc({
    summary: 'Reintentar una comunicación fallida',
    description:
      'Tras agotarse los reintentos automáticos. El envío lo hace el worker en segundos; si entretanto ya se envió, no se repite.',
    response: notificationView,
    errors: { 404: 'Comunicación no encontrada', 409: 'Solo se reintentan las fallidas' },
  })
  @RequirePermissions('notifications:resend')
  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id', idParam) id: string) {
    return this.notifications.retry(id);
  }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsAdminService] })
export class NotificationsModule {}

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { LOGGER } from '../../platform/logging/logger.js';
import type { OutboxJob, ReminderJob } from '../../modules/notifications/notifications.service.js';
import { SystemDb } from '../maintenance/system-db.js';

const BATCH = 100;

export interface Enqueuer {
  /** `jobId` estable: encolar dos veces lo mismo no crea dos jobs (idempotente en BullMQ). */
  outbox(jobId: string, job: OutboxJob): Promise<void>;
  reminder(jobId: string, job: ReminderJob): Promise<void>;
}

/**
 * Lado "descubrir" de las comunicaciones (rol `rp_system`, entre empresas). NO envía nada ni lee datos
 * personales: solo encola trabajos con ids; el envío corre por empresa con RLS (NotificationsService).
 */
@Injectable()
export class DispatchService {
  constructor(
    private readonly system: SystemDb,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Publisher del outbox (ARCHITECTURE.md §6.5): toma pendientes con `FOR UPDATE SKIP LOCKED` (varias réplicas
   * del worker no se pisan), los encola con `jobId = outbox.id` y los marca publicados en la MISMA transacción.
   * Si el proceso muere entre encolar y marcar, el siguiente intento vuelve a encolar con el mismo jobId: BullMQ
   * lo ignora. Si encolar falla, la transacción se revierte y quedan pendientes.
   */
  async publishOutbox(enqueue: Enqueuer): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.system.client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            tenant_id: string;
            type: string;
            aggregate_id: string;
            payload: Record<string, unknown>;
          }[]
        >`SELECT id, tenant_id, type, aggregate_id, payload FROM outbox_events
           WHERE published_at IS NULL
           ORDER BY created_at
           LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED`;
        for (const r of rows) {
          await enqueue.outbox(r.id, {
            outboxId: r.id,
            tenantId: r.tenant_id,
            type: r.type,
            aggregateId: r.aggregate_id,
            payload: r.payload,
          });
        }
        if (rows.length > 0) {
          await tx.$executeRaw`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1
                                WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
        }
        return rows.length;
      });
      total += n;
      if (n < BATCH) break;
    }
    if (total > 0) this.logger.debug({ published: total }, 'outbox publicado');
    return total;
  }

  /**
   * Recordatorios: reservas CONFIRMADAS que empiezan dentro de las próximas `reminder_hours_before` horas de su
   * empresa y aún no tienen recordatorio para ESE inicio. No se recuerda una reserva hecha ya dentro de la
   * ventana (quien reserva para dentro de 2 h acaba de recibir la confirmación).
   */
  async scanReminders(enqueue: Enqueuer, now: Date = new Date()): Promise<number> {
    const due = await this.system.client.$queryRaw<
      { tenant_id: string; id: string; start_at: Date }[]
    >`SELECT r.tenant_id, r.id, r.start_at
        FROM reservations r
        JOIN tenant_settings s ON s.tenant_id = r.tenant_id
        JOIN customers c ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
                        AND c.email IS NOT NULL AND c.anonymized_at IS NULL
       WHERE r.status = 'confirmed'
         AND s.customer_emails_enabled
         AND s.reminder_hours_before IS NOT NULL
         AND r.start_at > ${now}
         AND r.start_at <= ${now}::timestamptz + make_interval(hours => s.reminder_hours_before)
         AND r.created_at < r.start_at - make_interval(hours => s.reminder_hours_before)
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
            WHERE n.tenant_id = r.tenant_id AND n.reservation_id = r.id
              AND n.type = 'reservation.reminder' AND n.reference_at = r.start_at)
       ORDER BY r.start_at
       LIMIT 500`;
    for (const r of due) {
      const startAt = r.start_at.toISOString();
      // BullMQ no admite ':' en ids propios.
      await enqueue.reminder(`reminder-${r.id}-${r.start_at.getTime()}`, {
        tenantId: r.tenant_id,
        reservationId: r.id,
        startAt,
      });
    }
    return due.length;
  }
}

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Tx } from '@reservepro/database';
import { uuidv7 } from '../../common/ids.js';
import { AppConfig } from '../../config/app-config.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { EMAIL_PROVIDER, type EmailProvider } from '../../platform/email/email.module.js';
import { LOGGER } from '../../platform/logging/logger.js';
import { issueAccessToken, manageUrl } from '../public/access-tokens.js';
import { loadSettings } from '../reservations/booking-context.js';
import { type ReservationEmailKind, renderReservationEmail } from './reservation-emails.js';

/** Evento del outbox tal como lo encola el publisher. */
export interface OutboxJob {
  outboxId: string;
  tenantId: string;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface ReminderJob {
  tenantId: string;
  reservationId: string;
  /** Inicio de la reserva al programar el recordatorio: si se reprogramó, este recordatorio ya no aplica. */
  startAt: string;
}

export type DeliveryResult = 'sent' | 'skipped' | 'suppressed' | 'duplicate';

/** Qué email (si alguno) corresponde a cada evento de reserva. */
export function emailKindFor(
  type: string,
  payload: Record<string, unknown>,
): ReservationEmailKind | null {
  switch (type) {
    case 'reservation.created':
      return payload['status'] === 'pending' ? 'created_pending' : 'created_confirmed';
    case 'reservation.status_changed':
      return payload['to'] === 'confirmed' ? 'confirmed' : null; // en curso / completada / no asistió: sin email
    case 'reservation.rescheduled':
      return 'rescheduled';
    case 'reservation.cancelled':
      return 'cancelled';
    case 'reservation.expired':
      return 'expired';
    default:
      return null;
  }
}

/** Solo estos llevan enlace de gestión: no tiene sentido "gestionar" una reserva cancelada o vencida. */
const WITH_LINK = new Set<ReservationEmailKind>([
  'created_confirmed',
  'created_pending',
  'confirmed',
  'rescheduled',
  'reminder',
]);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Error de envío sin datos personales (los proveedores SMTP suelen incluir la dirección en el mensaje). */
const safeError = (e: unknown) =>
  `${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e)
    .replace(/[^\s@<>]+@[^\s@<>]+/g, '<email>')
    .slice(0, 300)}`;

/**
 * Notificaciones al cliente (ARCHITECTURE.md §6.5, ADR-017). Corre en el WORKER, por empresa y con RLS.
 *
 * Entrega "al menos una vez" sin duplicar en el caso normal:
 *  1. (tx) se registra la notificación con `dedupe_key` único: un reintento del mismo job encuentra la fila;
 *     si ya se envió, no se repite;
 *  2. (fuera de tx) se envía;
 *  3. (tx) se marca enviada o fallida. Si falla, el job se reintenta (BullMQ, con espera creciente).
 * Solo si el proceso muere ENTRE 2 y 3 podría repetirse un email: preferible a perderlo.
 * Consentimiento y preferencias se comprueban AL ENVIAR, no al encolar.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly config: AppConfig,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async handleOutboxEvent(job: OutboxJob): Promise<DeliveryResult> {
    if (job.type === 'notification.retry') {
      return this.retry(job.tenantId, String(job.payload['notificationId'] ?? job.aggregateId));
    }
    if (!job.type.startsWith('reservation.')) return 'skipped';
    const kind = emailKindFor(job.type, job.payload);
    if (!kind) return 'skipped';
    return this.deliver(job.tenantId, job.aggregateId, kind, `outbox:${job.outboxId}`);
  }

  async handleReminder(job: ReminderJob): Promise<DeliveryResult> {
    // La clave incluye el inicio: si la reserva se reprograma, el recordatorio del nuevo horario es otro.
    return this.deliver(
      job.tenantId,
      job.reservationId,
      'reminder',
      `reminder:${job.startAt}`,
      job.startAt,
    );
  }

  /**
   * Reintento MANUAL desde el centro de comunicaciones (tras agotar los automáticos). Reutiliza la misma fila
   * (misma `dedupe_key`): si entretanto se envió, no se repite.
   */
  async retry(tenantId: string, notificationId: string): Promise<DeliveryResult> {
    const row = await this.tdb.run({ tenantId }, (tx) =>
      tx.notifications.findFirst({
        where: { id: notificationId },
        select: {
          reservation_id: true,
          type: true,
          dedupe_key: true,
          reference_at: true,
          status: true,
        },
      }),
    );
    if (!row?.reservation_id || !row.type.startsWith('reservation.')) return 'skipped';
    if (row.status === 'sent' || row.status === 'suppressed') return 'duplicate';
    const kind = row.type.slice('reservation.'.length) as ReservationEmailKind;
    return this.deliver(
      tenantId,
      row.reservation_id,
      kind,
      { dedupeKey: row.dedupe_key },
      row.reference_at?.toISOString(),
    );
  }

  private async deliver(
    tenantId: string,
    reservationId: string,
    kind: ReservationEmailKind,
    seed: string | { dedupeKey: string },
    reminderFor?: string,
  ): Promise<DeliveryResult> {
    const prepared = await this.tdb.run({ tenantId }, (tx) =>
      this.prepare(tx, tenantId, reservationId, kind, seed, reminderFor),
    );
    if (typeof prepared === 'string') return prepared;

    try {
      await this.email.send(prepared.message);
    } catch (e) {
      await this.tdb.run({ tenantId }, (tx) =>
        tx.notifications.update({
          where: { id: prepared.id },
          data: { status: 'failed', last_error: safeError(e) },
        }),
      );
      this.logger.warn(
        { notificationId: prepared.id, tenantId, kind },
        'email no enviado: se reintentará',
      );
      throw e; // BullMQ reintenta
    }
    await this.tdb.run({ tenantId }, (tx) =>
      tx.notifications.update({
        where: { id: prepared.id },
        data: { status: 'sent', sent_at: new Date(), last_error: null },
      }),
    );
    this.logger.info({ notificationId: prepared.id, tenantId, kind }, 'email enviado');
    return 'sent';
  }

  private async prepare(
    tx: Tx,
    tenantId: string,
    reservationId: string,
    kind: ReservationEmailKind,
    seed: string | { dedupeKey: string },
    reminderFor?: string,
  ) {
    const settings = await loadSettings(tx);
    if (!settings.customer_emails_enabled) return 'skipped' as const;

    const r = await tx.reservations.findFirst({
      where: { id: reservationId },
      include: {
        customers: { select: { id: true, first_name: true, email: true, anonymized_at: true } },
        reservation_items: { orderBy: { position: 'asc' } },
        reservation_resources: { select: { resource_id: true } },
        locations: { select: { name: true, address: true } },
      },
    });
    if (!r || !r.customers.email || r.customers.anonymized_at) return 'skipped' as const;
    // Un aviso "positivo" de una reserva que ya se canceló (p. ej. cancelada segundos después) no se envía.
    if (WITH_LINK.has(kind) && r.status === 'cancelled') return 'skipped' as const;
    if (kind === 'reminder') {
      if (r.status !== 'confirmed') return 'skipped' as const;
      if (reminderFor && r.start_at.getTime() !== new Date(reminderFor).getTime()) {
        return 'skipped' as const; // se reprogramó: este recordatorio quedó obsoleto
      }
    }

    const recipient = r.customers.email;
    const dedupeKey =
      typeof seed === 'string'
        ? sha256(`${seed}|email|${recipient.toLowerCase()}|${kind}`)
        : seed.dedupeKey;
    const type = kind === 'reminder' ? 'reservation.reminder' : `reservation.${kind}`;
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO notifications (id, tenant_id, reservation_id, customer_id, channel, type, recipient, dedupe_key, reference_at)
      VALUES (${uuidv7()}::uuid, ${tenantId}::uuid, ${r.id}::uuid, ${r.customers.id}::uuid, 'email', ${type},
              ${recipient}, ${dedupeKey}, ${reminderFor ? new Date(reminderFor) : null})
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
      RETURNING id`;
    let id = inserted[0]?.id;
    if (!id) {
      const existing = await tx.notifications.findFirstOrThrow({
        where: { dedupe_key: dedupeKey },
        select: { id: true, status: true },
      });
      if (existing.status === 'sent' || existing.status === 'suppressed')
        return 'duplicate' as const;
      id = existing.id; // un intento anterior falló: se reintenta sobre la misma fila
    }

    // Consentimiento vigente (última fila). Sin filas = transaccional permitido (relación contractual).
    const consent = await tx.notification_consents.findFirst({
      where: { customer_id: r.customers.id, channel: 'email', purpose: 'transactional' },
      orderBy: { occurred_at: 'desc' },
      select: { status: true },
    });
    if (consent?.status === 'revoked') {
      await tx.notifications.update({
        where: { id },
        data: { status: 'suppressed', last_error: 'El cliente revocó los emails' },
      });
      return 'suppressed' as const;
    }

    const tenant = await tx.tenants.findFirstOrThrow({ select: { name: true } });
    const resource = await tx.resources.findFirst({
      where: { id: r.reservation_resources[0]?.resource_id ?? '' },
      select: { name: true },
    });
    const address = (r.locations.address ?? {}) as Record<string, unknown>;
    const token = WITH_LINK.has(kind) ? await issueAccessToken(tx, tenantId, r.id, settings) : null;
    const message = renderReservationEmail({
      to: recipient,
      kind,
      customerFirstName: r.customers.first_name,
      tenantName: tenant.name,
      code: r.code,
      serviceName: r.reservation_items.map((i) => i.service_name).join(', '),
      resourceName: resource?.name ?? '',
      locationName: r.locations.name,
      locationAddress: ['line1', 'city']
        .map((k) => address[k])
        .filter((v): v is string => typeof v === 'string' && v !== '')
        .join(', '),
      startAt: r.start_at,
      endAt: r.end_at,
      timeZone: r.time_zone,
      holdExpiresAt: r.hold_expires_at,
      manageUrl: token ? manageUrl(this.config.env.PORTAL_URL, token) : null,
      cancelWindowHours: settings.cancel_window_hours,
    });
    await tx.notifications.update({
      where: { id },
      data: { status: 'sending', attempts: { increment: 1 }, subject: message.subject },
    });
    return { id, message };
  }
}

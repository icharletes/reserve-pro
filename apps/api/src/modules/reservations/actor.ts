import type { Prisma, Tx } from '@reservepro/database';
import { uuidv7 } from '../../common/ids.js';
import type { AuditService } from '../../platform/audit/audit.module.js';
import type { BookingSource } from './booking-context.js';

/**
 * Quién hace un cambio sobre una reserva y por qué canal. El motor no lee la sesión: lo recibe explícito, así
 * sirve igual para el panel (usuario), el portal público (cliente sin cuenta) y el worker (sistema).
 * `tenantId` SIEMPRE viene del servidor (sesión, slug resuelto o token), nunca del cuerpo de la petición.
 */
export interface Actor {
  tenantId: string;
  source: BookingSource;
  type: 'user' | 'customer' | 'system';
  userId: string | null;
  membershipId: string | null;
  /** Filtro de visibilidad (p. ej. solo las reservas propias de un profesional). `{}` = todas. */
  scope: Prisma.reservationsWhereInput;
}

export const systemActor = (tenantId: string): Actor => ({
  tenantId,
  source: 'api',
  type: 'system',
  userId: null,
  membershipId: null,
  scope: {},
});

/**
 * Historial inmutable + outbox (ADR-005) + auditoría, en la MISMA transacción del cambio.
 * El payload no lleva datos personales: el outbox lo leerán procesos de notificación.
 */
export async function recordReservationEvent(
  tx: Tx,
  audit: AuditService,
  actor: Actor,
  reservationId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.reservation_events.create({
    data: {
      id: uuidv7(),
      tenant_id: actor.tenantId,
      reservation_id: reservationId,
      type,
      actor_type: actor.type,
      actor_id: actor.userId,
      channel: actor.source,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  await tx.outbox_events.create({
    data: {
      id: uuidv7(),
      tenant_id: actor.tenantId,
      aggregate_type: 'reservation',
      aggregate_id: reservationId,
      type: `reservation.${type}`,
      payload: { reservationId, ...payload } as Prisma.InputJsonValue,
    },
  });
  await audit.record(tx, {
    tenantId: actor.tenantId,
    actorType: actor.type,
    ...(actor.userId ? { actorId: actor.userId } : {}),
    action: `reservation.${type}`,
    entityType: 'reservation',
    entityId: reservationId,
    after: payload as Prisma.InputJsonValue,
  });
}

/**
 * Libera las reservas `pending` cuya retención venció (las pasa a `cancelled` por el sistema). Se llama:
 *  - dentro de la transacción de reserva, con los recursos YA bloqueados, para que una retención vencida no
 *    impida reservar aunque el barrido del worker aún no haya pasado;
 *  - desde el worker, periódicamente, para el resto.
 * Devuelve cuántas liberó.
 */
export async function expireHolds(
  tx: Tx,
  audit: AuditService,
  tenantId: string,
  where: Prisma.reservationsWhereInput,
  now: Date = new Date(),
): Promise<number> {
  const stale = await tx.reservations.findMany({
    where: { AND: [where, { status: 'pending', hold_expires_at: { lte: now } }] },
    select: { id: true },
  });
  let n = 0;
  for (const { id } of stale) {
    // Condición repetida en el UPDATE: si alguien la confirmó entre medio, no se toca.
    const res = await tx.reservations.updateMany({
      where: { id, status: 'pending', hold_expires_at: { lte: now } },
      data: {
        status: 'cancelled',
        cancelled_at: now,
        cancelled_by_type: 'system',
        cancellation_reason: 'La reserva no se confirmó a tiempo',
        hold_expires_at: null,
        version: { increment: 1 },
      },
    });
    if (res.count === 1) {
      n++;
      await recordReservationEvent(tx, audit, systemActor(tenantId), id, 'expired', {
        from: 'pending',
        to: 'cancelled',
      });
    }
  }
  return n;
}

import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  type FitProblem,
  type ReservationStatus,
  addCalendarDays,
  canTransition,
  checkFit,
  chooseResource,
  localDateOf,
  reservationCode,
} from '@reservepro/booking-domain';
import type {
  CancelReservationRequest,
  ChangeStatusRequest,
  CreateReservationRequest,
  ReservationEventView,
  ReservationListQuery,
  ReservationView,
  RescheduleReservationRequest,
} from '@reservepro/contracts';
import type { Prisma, Tx } from '@reservepro/database';
import { AppError, Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import type { Page } from '../../common/pagination.js';
import { PG, isRetryable, isUniqueViolation, pgCode } from '../../common/pg-errors.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { IdempotencyService, hashBody } from '../../platform/idempotency/idempotency.js';
import { type Actor, expireHolds, recordReservationEvent } from './actor.js';
import {
  UPCOMING_STATUSES,
  bookedMinutes,
  bookingWindow,
  busyOf,
  loadBookable,
  loadBusy,
  loadResourceContexts,
  loadSettings,
  localWindow,
  lockResources,
  workingRanges,
} from './booking-context.js';
import { findOrCreateCustomer } from './customers.js';

const DAY = 86_400_000;
const MIN = 60_000;
const MAX_ATTEMPTS = 3;
const PUBLIC_SOURCES = ['public_web', 'whatsapp', 'api'];

export const reservationInclude = {
  customers: {
    select: { id: true, first_name: true, last_name: true, phone_e164: true, email: true },
  },
  reservation_items: { orderBy: { position: 'asc' as const } },
  reservation_resources: { orderBy: { occupy_start: 'asc' as const } },
} satisfies Prisma.reservationsInclude;
const include = reservationInclude;
export type ReservationRow = Prisma.reservationsGetPayload<{ include: typeof include }>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toReservationView(r: ReservationRow): ReservationView {
  return {
    id: r.id,
    code: r.code,
    status: r.status as ReservationView['status'],
    source: r.source,
    locationId: r.location_id,
    customer: {
      id: r.customers.id,
      firstName: r.customers.first_name,
      lastName: r.customers.last_name,
      phoneE164: r.customers.phone_e164,
      email: r.customers.email,
    },
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    timeZone: r.time_zone,
    totalAmount: r.total_amount.toFixed(2),
    currency: r.currency,
    paidAmount: r.paid_amount.toFixed(2),
    rescheduleCount: r.reschedule_count,
    customerNotes: r.customer_notes,
    internalNotes: r.internal_notes,
    cancelledAt: iso(r.cancelled_at),
    cancellationReason: r.cancellation_reason,
    version: r.version,
    items: r.reservation_items.map((i) => ({
      serviceId: i.service_id,
      serviceName: i.service_name,
      durationMinutes: i.duration_minutes,
      unitPrice: i.unit_price.toFixed(2),
      startAt: i.start_at.toISOString(),
      endAt: i.end_at.toISOString(),
    })),
    resources: r.reservation_resources.map((x) => ({
      resourceId: x.resource_id,
      occupyStart: x.occupy_start.toISOString(),
      occupyEnd: x.occupy_end.toISOString(),
    })),
    createdAt: r.created_at.toISOString(),
  };
}

function fitError(problem: FitProblem): AppError {
  switch (problem) {
    case 'TOO_SOON':
      return Errors.outsideBookingWindow('Ese horario ya pasó o no cumple la antelación mínima');
    case 'TOO_FAR':
      return Errors.outsideBookingWindow(
        'Ese horario está más allá de la antelación máxima permitida',
      );
    case 'OUTSIDE_WORKING_HOURS':
      return Errors.slotUnavailable('Ese horario está fuera del horario de atención');
    case 'CONFLICT':
      return Errors.slotUnavailable();
  }
}

function assertWholeMinute(start: Date): void {
  if (start.getTime() % MIN !== 0) {
    throw Errors.validation([
      { path: 'startAt', message: 'La hora de inicio no puede tener segundos' },
    ]);
  }
}

/** Cursor de listado por (start_at, id): ordena por fecha sin repetir ni saltar filas. */
const encodeCursor = (r: { start_at: Date; id: string }): string =>
  Buffer.from(`${r.start_at.toISOString()}|${r.id}`).toString('base64url');
function decodeCursor(c: string | undefined): { start: Date; id: string } | undefined {
  if (!c) return undefined;
  const [s, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const start = new Date(s ?? '');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(start.getTime())) {
    throw Errors.validation([{ path: 'cursor', message: 'Cursor inválido' }]);
  }
  return { start, id };
}

export interface CreateOptions<E> {
  /** Ámbito de la Idempotency-Key (el panel y el portal no comparten claves). */
  idempotencyScope: string;
  /** Canales públicos: solo recursos reservables online. */
  onlineOnly?: boolean;
  /** Anti-acaparamiento: máximo de reservas futuras activas por cliente desde canales públicos. */
  maxActivePerCustomer?: number;
  /** Se ejecuta en la MISMA transacción, al crear y también al repetir (p. ej. emitir el enlace de gestión). */
  after?: (tx: Tx, reservationId: string, replayed: boolean) => Promise<E>;
}

export interface RescheduleOptions {
  /** Reglas extra sobre la reserva actual (p. ej. políticas de autogestión del cliente). */
  guard?: (row: ReservationRow, tx: Tx) => Promise<void> | void;
  /** En la misma transacción, tras mover la reserva. */
  after?: (tx: Tx, row: ReservationRow, start: Date, end: Date) => Promise<void>;
}

/**
 * Motor de reservas (ARCHITECTURE.md §6, ADR-014/015). Toda escritura:
 *  1. corre en UNA transacción con contexto de tenant (RLS) — el de `actor.tenantId`, que fija el servidor;
 *  2. bloquea las filas de los recursos implicados en orden fijo (sin deadlocks) y RE-VALIDA el horario dentro;
 *  3. deja la última palabra a PostgreSQL (EXCLUDE): un solape que se colara da 409, nunca una doble reserva;
 *  4. registra evento, outbox y auditoría en esa misma transacción.
 * Los métodos `*As(actor, …)` los usan el portal público y el worker; los demás son los del panel.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly cls: ClsService,
    private readonly audit: AuditService,
    private readonly idem: IdempotencyService,
  ) {}

  /** Actor del panel: el usuario de la sesión. Con solo `reservations:read:own`, ve únicamente SU recurso. */
  staff(): Actor {
    const p = this.cls.get('principal');
    if (!p) throw Errors.unauthenticated();
    if (!p.tenantId) throw Errors.tenantRequired();
    const scope: Prisma.reservationsWhereInput = p.permissions.has('reservations:read')
      ? {}
      : {
          reservation_resources: {
            some: {
              resources: {
                membership_id: p.membershipId ?? '00000000-0000-0000-0000-000000000000',
              },
            },
          },
        };
    return {
      tenantId: p.tenantId,
      source: 'admin',
      type: 'user',
      userId: p.userId,
      membershipId: p.membershipId ?? null,
      scope,
    };
  }

  private run<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tdb.run({ tenantId: actor.tenantId }, fn);
  }

  // --- lectura ------------------------------------------------------------------------------------------------

  async list(q: ReservationListQuery): Promise<Page<ReservationView>> {
    const actor = this.staff();
    const after = decodeCursor(q.cursor);
    const where: Prisma.reservationsWhereInput = {
      AND: [
        actor.scope,
        q.from || q.to
          ? {
              start_at: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lt: new Date(q.to) } : {}),
              },
            }
          : {},
        q.status ? { status: q.status } : {},
        q.locationId ? { location_id: q.locationId } : {},
        q.customerId ? { customer_id: q.customerId } : {},
        q.resourceId ? { reservation_resources: { some: { resource_id: q.resourceId } } } : {},
        after
          ? {
              OR: [
                { start_at: { gt: after.start } },
                { start_at: after.start, id: { gt: after.id } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.run(actor, (tx) =>
      tx.reservations.findMany({
        where,
        include,
        orderBy: [{ start_at: 'asc' }, { id: 'asc' }],
        take: q.limit + 1,
      }),
    );
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toReservationView),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  async get(id: string): Promise<ReservationView> {
    const actor = this.staff();
    const row = await this.run(actor, (tx) =>
      tx.reservations.findFirst({ where: { AND: [{ id }, actor.scope] }, include }),
    );
    if (!row) throw Errors.notFound('Reserva');
    return toReservationView(row);
  }

  async events(id: string): Promise<ReservationEventView[]> {
    const actor = this.staff();
    return this.run(actor, async (tx) => {
      const r = await tx.reservations.findFirst({
        where: { AND: [{ id }, actor.scope] },
        select: { id: true },
      });
      if (!r) throw Errors.notFound('Reserva');
      const rows = await tx.reservation_events.findMany({
        where: { reservation_id: id },
        orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }],
      });
      return rows.map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actor_type,
        actorId: e.actor_id,
        payload: e.payload,
        occurredAt: e.occurred_at.toISOString(),
      }));
    });
  }

  // --- escritura -----------------------------------------------------------------------------------------------

  /** Reintenta la transacción completa ante deadlocks/serialización y traduce el EXCLUDE a 409. */
  private async write<T>(fn: () => Promise<T>, retryUnique = false): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof AppError) throw e;
        if (pgCode(e) === PG.exclusionViolation) throw Errors.slotUnavailable();
        // Choque de código de reserva o alta simultánea del mismo teléfono: el reintento lo resuelve.
        if (attempt < MAX_ATTEMPTS && (isRetryable(e) || (retryUnique && isUniqueViolation(e))))
          continue;
        throw e;
      }
    }
  }

  create(
    dto: CreateReservationRequest,
    idempotencyKey: string,
  ): Promise<{ view: ReservationView; replayed: boolean }> {
    return this.createAs(this.staff(), dto, idempotencyKey, {
      idempotencyScope: 'reservation.create',
    });
  }

  async createAs<E = undefined>(
    actor: Actor,
    dto: CreateReservationRequest,
    idempotencyKey: string,
    opts: CreateOptions<E>,
  ): Promise<{ view: ReservationView; replayed: boolean; extra: E }> {
    const start = new Date(dto.startAt);
    assertWholeMinute(start);
    const requestHash = hashBody(dto);
    const after = opts.after ?? (async () => undefined as E);

    return this.write(
      () =>
        this.run(actor, async (tx) => {
          const claim = await this.idem.claim(
            tx,
            opts.idempotencyScope,
            idempotencyKey,
            requestHash,
          );
          if (claim.replay) {
            const view = claim.replay.body as ReservationView;
            return { view, replayed: true, extra: await after(tx, view.id, true) };
          }

          const { service, location, resourceIds, autoAssignable } = await loadBookable(
            tx,
            dto.serviceId,
            dto.locationId,
            opts.onlineOnly,
          );
          let candidates: string[];
          if (dto.resourceId) {
            if (!resourceIds.includes(dto.resourceId)) {
              throw Errors.validation([
                {
                  path: 'resourceId',
                  message: 'Ese recurso no presta este servicio en esa sucursal',
                },
              ]);
            }
            candidates = [dto.resourceId];
          } else {
            candidates = resourceIds.filter((id) => autoAssignable.has(id));
          }
          if (candidates.length === 0) {
            throw Errors.slotUnavailable(
              'No hay profesionales o recursos que presten este servicio en esa sucursal',
            );
          }

          // ★ Bloqueo de los recursos y RE-validación con los datos actuales, dentro de la transacción.
          await lockResources(tx, candidates);
          // Una retención vencida no debe impedir reservar aunque el worker aún no la haya liberado.
          await expireHolds(tx, this.audit, actor.tenantId, {
            reservation_resources: { some: { resource_id: { in: candidates } } },
          });
          const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
          const timezone = location.timezone ?? tenant.timezone;
          const localDate = localDateOf(start, timezone);
          const fromDate = addCalendarDays(localDate, -1);
          const toDate = addCalendarDays(localDate, 1);
          const contexts = await loadResourceContexts(tx, candidates, fromDate, toDate);
          const busy = await loadBusy(tx, candidates, {
            start: new Date(start.getTime() - DAY),
            end: new Date(start.getTime() + 2 * DAY),
          });
          const settings = await loadSettings(tx);
          const timing = {
            durationMinutes: service.duration_minutes,
            bufferBeforeMinutes: service.buffer_before_minutes,
            bufferAfterMinutes: service.buffer_after_minutes,
          };
          const now = new Date();
          const limits = bookingWindow(actor.source, settings, service, now);
          const checked = candidates.map((id) => ({
            id,
            problem: checkFit(
              {
                ...timing,
                ...limits,
                working: workingRanges(contexts.get(id)!, fromDate, toDate),
                busy: busyOf(busy, id),
              },
              start,
            ),
          }));
          const day = localWindow(timezone, localDate, localDate);
          const chosen = chooseResource(
            checked
              .filter((c) => c.problem === null)
              .map((c) => ({
                id: c.id,
                sortOrder: contexts.get(c.id)!.sortOrder,
                bookedMinutes: bookedMinutes(busy, c.id, day),
              })),
          );
          if (!chosen) {
            const problems = checked.map((c) => c.problem!);
            throw fitError(
              problems.find((p) => p === 'TOO_SOON' || p === 'TOO_FAR') ??
                (problems.includes('CONFLICT') ? 'CONFLICT' : problems[0]!),
            );
          }

          // Cliente: existente por id, o se reutiliza/crea por teléfono.
          let customerId: string;
          let customerCreated = false;
          if ('id' in dto.customer) {
            const c = await tx.customers.findFirst({
              where: { id: dto.customer.id, anonymized_at: null },
              select: { id: true },
            });
            if (!c)
              throw Errors.validation([{ path: 'customer.id', message: 'El cliente no existe' }]);
            customerId = c.id;
          } else {
            const r = await findOrCreateCustomer(tx, actor.tenantId, dto.customer);
            customerId = r.id;
            customerCreated = r.created;
          }

          if (opts.maxActivePerCustomer !== undefined) {
            // Bloqueo del cliente: dos reservas simultáneas del mismo teléfono no pueden saltarse el límite.
            await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId}::uuid FOR UPDATE`;
            const active = await tx.reservations.count({
              where: {
                customer_id: customerId,
                source: { in: PUBLIC_SOURCES },
                status: { in: UPCOMING_STATUSES },
                end_at: { gt: now },
              },
            });
            if (active >= opts.maxActivePerCustomer) {
              throw Errors.limitReached(
                'reservas activas para este teléfono. Cancela alguna o contacta al negocio',
              );
            }
          }

          // Estado inicial: lo que crea el personal queda confirmado; los canales del cliente siguen la configuración.
          const needsApproval = service.requires_confirmation ?? !settings.auto_confirm;
          const status: ReservationStatus =
            actor.source === 'admin' || !needsApproval ? 'confirmed' : 'pending';

          const id = uuidv7();
          const itemId = uuidv7();
          const end = new Date(start.getTime() + service.duration_minutes * MIN);
          const tenantId = actor.tenantId;
          await tx.reservations.create({
            data: {
              id,
              tenant_id: tenantId,
              code: reservationCode(randomBytes(6)),
              location_id: location.id,
              customer_id: customerId,
              status,
              source: actor.source,
              start_at: start,
              end_at: end,
              time_zone: timezone,
              total_amount: service.price,
              currency: service.currency,
              // Una solicitud pendiente retiene el horario solo un tiempo: si nadie la confirma, se libera.
              hold_expires_at:
                status === 'pending'
                  ? new Date(now.getTime() + settings.pending_hold_minutes * MIN)
                  : null,
              customer_notes: dto.customerNotes ?? null,
              internal_notes: dto.internalNotes ?? null,
              created_by_membership_id: actor.membershipId,
            },
          });
          await tx.reservation_items.create({
            data: {
              id: itemId,
              tenant_id: tenantId,
              reservation_id: id,
              service_id: service.id,
              service_name: service.name,
              duration_minutes: service.duration_minutes,
              buffer_before_minutes: service.buffer_before_minutes,
              buffer_after_minutes: service.buffer_after_minutes,
              unit_price: service.price,
              currency: service.currency,
              start_at: start,
              end_at: end,
            },
          });
          await tx.reservation_resources.create({
            data: {
              id: uuidv7(),
              tenant_id: tenantId,
              reservation_id: id,
              reservation_item_id: itemId,
              resource_id: chosen.id,
              occupy_start: new Date(start.getTime() - service.buffer_before_minutes * MIN),
              occupy_end: new Date(end.getTime() + service.buffer_after_minutes * MIN),
              is_exclusive: true, // ADR-006: en el MVP todo recurso tiene capacidad 1
            },
          });
          await recordReservationEvent(tx, this.audit, actor, id, 'created', {
            status,
            resourceId: chosen.id,
            startAt: start.toISOString(),
            customerCreated,
          });

          const view = toReservationView(
            await tx.reservations.findFirstOrThrow({ where: { id }, include }),
          );
          await this.idem.complete(tx, opts.idempotencyScope, idempotencyKey, 201, view);
          return { view, replayed: false, extra: await after(tx, id, false) };
        }),
      true,
    );
  }

  /**
   * Cambio de estado con control optimista: la versión enviada debe ser la actual. El UPDATE vuelve a exigirla
   * (`WHERE version = …`), así que dos cambios simultáneos nunca se pisan: el segundo recibe 409.
   */
  async transitionAs(
    actor: Actor,
    id: string,
    version: number,
    to: ReservationStatus,
    extra: (row: ReservationRow) => Prisma.reservationsUpdateManyMutationInput,
    payload: Record<string, unknown> = {},
  ): Promise<ReservationView> {
    return this.write(() =>
      this.run(actor, async (tx) => {
        const row = await tx.reservations.findFirst({
          where: { AND: [{ id }, actor.scope] },
          include,
        });
        if (!row) throw Errors.notFound('Reserva');
        if (row.version !== version) throw Errors.versionConflict();
        const from = row.status as ReservationStatus;
        if (!canTransition(from, to)) {
          throw Errors.invalidTransition(`No se puede pasar una reserva de "${from}" a "${to}"`);
        }
        const res = await tx.reservations.updateMany({
          where: { id, version },
          data: { ...extra(row), status: to, version: { increment: 1 } },
        });
        if (res.count === 0) throw Errors.versionConflict();
        await recordReservationEvent(
          tx,
          this.audit,
          actor,
          id,
          to === 'cancelled' ? 'cancelled' : 'status_changed',
          { from, to, ...payload },
        );
        return toReservationView(
          await tx.reservations.findFirstOrThrow({ where: { id }, include }),
        );
      }),
    );
  }

  confirm(id: string, version: number): Promise<ReservationView> {
    return this.transitionAs(this.staff(), id, version, 'confirmed', () => ({
      hold_expires_at: null,
    }));
  }

  cancel(id: string, dto: CancelReservationRequest): Promise<ReservationView> {
    return this.cancelAs(this.staff(), id, dto.version, dto.reason ?? null);
  }

  cancelAs(
    actor: Actor,
    id: string,
    version: number,
    reason: string | null,
  ): Promise<ReservationView> {
    return this.transitionAs(
      actor,
      id,
      version,
      'cancelled',
      () => ({
        cancelled_at: new Date(),
        cancelled_by_type: actor.type,
        cancellation_reason: reason,
        hold_expires_at: null,
      }),
      { reason },
    );
  }

  changeStatus(id: string, dto: ChangeStatusRequest): Promise<ReservationView> {
    return this.transitionAs(this.staff(), id, dto.version, dto.status, (row) => {
      // "No asistió" solo tiene sentido una vez pasada la hora de inicio.
      if (dto.status === 'no_show' && row.start_at.getTime() > Date.now()) {
        throw Errors.invalidTransition(
          'Solo se puede marcar "no asistió" después de la hora de inicio',
        );
      }
      return {};
    });
  }

  reschedule(id: string, dto: RescheduleReservationRequest): Promise<ReservationView> {
    return this.rescheduleAs(this.staff(), id, dto.version, dto.startAt, dto.resourceId);
  }

  /** Mueve la reserva a otro horario (y opcionalmente a otro recurso), con la misma duración reservada. */
  async rescheduleAs(
    actor: Actor,
    id: string,
    version: number,
    startAt: string,
    resourceId: string | undefined,
    opts: RescheduleOptions = {},
  ): Promise<ReservationView> {
    const start = new Date(startAt);
    assertWholeMinute(start);
    return this.write(() =>
      this.run(actor, async (tx) => {
        const row = await tx.reservations.findFirst({
          where: { AND: [{ id }, actor.scope] },
          include,
        });
        if (!row) throw Errors.notFound('Reserva');
        if (row.version !== version) throw Errors.versionConflict();
        if (row.status !== 'pending' && row.status !== 'confirmed') {
          throw Errors.invalidTransition(
            'Solo se pueden reprogramar reservas pendientes o confirmadas',
          );
        }
        await opts.guard?.(row, tx);
        const item = row.reservation_items[0]!;
        const rr = row.reservation_resources[0]!;
        const target = resourceId ?? rr.resource_id;
        if (target !== rr.resource_id) {
          const ok = await tx.service_resources.findFirst({
            where: {
              service_id: item.service_id,
              resource_id: target,
              resources: { location_id: row.location_id, is_active: true },
            },
          });
          if (!ok) {
            throw Errors.validation([
              {
                path: 'resourceId',
                message: 'Ese recurso no presta este servicio en esa sucursal',
              },
            ]);
          }
        }
        await lockResources(tx, [rr.resource_id, target]);
        await expireHolds(tx, this.audit, actor.tenantId, {
          id: { not: id },
          reservation_resources: { some: { resource_id: target } },
        });

        const localDate = localDateOf(start, row.time_zone);
        const fromDate = addCalendarDays(localDate, -1);
        const toDate = addCalendarDays(localDate, 1);
        const contexts = await loadResourceContexts(tx, [target], fromDate, toDate);
        const busy = await loadBusy(
          tx,
          [target],
          { start: new Date(start.getTime() - DAY), end: new Date(start.getTime() + 2 * DAY) },
          id,
        );
        // Se respeta lo reservado (snapshot), no el servicio actual: el precio y la duración no cambian al mover.
        const timing = {
          durationMinutes: item.duration_minutes,
          bufferBeforeMinutes: item.buffer_before_minutes,
          bufferAfterMinutes: item.buffer_after_minutes,
        };
        const notice = await tx.services.findFirst({
          where: { id: item.service_id },
          select: { min_notice_minutes: true, max_advance_days: true },
        });
        const limits = bookingWindow(
          actor.source,
          await loadSettings(tx),
          notice ?? { min_notice_minutes: null, max_advance_days: null },
          new Date(),
        );
        const problem = checkFit(
          {
            ...timing,
            ...limits,
            working: workingRanges(contexts.get(target)!, fromDate, toDate),
            busy: busyOf(busy, target),
          },
          start,
        );
        if (problem) throw fitError(problem);

        const end = new Date(start.getTime() + item.duration_minutes * MIN);
        const res = await tx.reservations.updateMany({
          where: { id, version },
          data: {
            start_at: start,
            end_at: end,
            reschedule_count: { increment: 1 },
            version: { increment: 1 },
          },
        });
        if (res.count === 0) throw Errors.versionConflict();
        await tx.reservation_items.update({
          where: { id: item.id },
          data: { start_at: start, end_at: end },
        });
        await tx.reservation_resources.update({
          where: { id: rr.id },
          data: {
            resource_id: target,
            occupy_start: new Date(start.getTime() - item.buffer_before_minutes * MIN),
            occupy_end: new Date(end.getTime() + item.buffer_after_minutes * MIN),
          },
        });
        await recordReservationEvent(tx, this.audit, actor, id, 'rescheduled', {
          from: { startAt: row.start_at.toISOString(), resourceId: rr.resource_id },
          to: { startAt: start.toISOString(), resourceId: target },
        });
        await opts.after?.(tx, row, start, end);
        return toReservationView(
          await tx.reservations.findFirstOrThrow({ where: { id }, include }),
        );
      }),
    );
  }
}

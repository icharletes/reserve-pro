import {
  type DayOverride,
  localIntervalsToUtc,
  type ScheduleInput,
  type UtcRange,
  type WeeklyRule,
  resolveWorkingRanges,
} from '@reservepro/booking-domain';
import type { Tx } from '@reservepro/database';
import { Errors } from '../../common/errors.js';

/**
 * Carga, en pocas consultas, todo lo necesario para resolver el horario de varios recursos en un rango de fechas,
 * y lo traduce al formato puro del dominio. La compartirán calendario, disponibilidad, creación y reprogramación:
 * todos deben ver EXACTAMENTE el mismo horario.
 */

const dateStr = (d: Date): string => d.toISOString().slice(0, 10);
const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export interface ResourceContext {
  id: string;
  name: string;
  kind: string;
  locationId: string;
  sortOrder: number;
  isActive: boolean;
  timezone: string;
  locationActive: boolean;
  input: ScheduleInput;
}

function overridesMap(
  rows: { on_date: Date; is_closed: boolean; start_minute: number; end_minute: number }[],
): Map<string, DayOverride[]> {
  const map = new Map<string, DayOverride[]>();
  for (const r of rows) {
    const key = dateStr(r.on_date);
    const list = map.get(key) ?? [];
    list.push({ startMinute: r.start_minute, endMinute: r.end_minute, isClosed: r.is_closed });
    map.set(key, list);
  }
  return map;
}

export async function loadResourceContexts(
  tx: Tx,
  resourceIds: string[],
  fromDate: string,
  toDate_: string,
): Promise<Map<string, ResourceContext>> {
  if (resourceIds.length === 0) return new Map();
  const from = toDate(fromDate);
  const to = toDate(toDate_);
  const resources = await tx.resources.findMany({ where: { id: { in: resourceIds } } });
  const locationIds = [...new Set(resources.map((r) => r.location_id))];
  // Secuencial a propósito: una transacción usa UNA conexión, así que en paralelo no se gana nada y `pg`
  // desaconseja (y en pg@9 prohibirá) consultas simultáneas sobre el mismo cliente.
  const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
  const locations = await tx.locations.findMany({ where: { id: { in: locationIds } } });
  const hours = await tx.business_hours.findMany({ where: { location_id: { in: locationIds } } });
  const locOverrides = await tx.schedule_overrides.findMany({
    where: { location_id: { in: locationIds }, on_date: { gte: from, lte: to } },
  });
  const holidays = await tx.holidays.findMany({ where: { on_date: { gte: from, lte: to } } });
  const schedules = await tx.resource_schedules.findMany({
    where: { resource_id: { in: resourceIds } },
  });
  const resOverrides = await tx.schedule_overrides.findMany({
    where: { resource_id: { in: resourceIds }, on_date: { gte: from, lte: to } },
  });
  const holidaySet = new Set(holidays.map((h) => dateStr(h.on_date)));

  const out = new Map<string, ResourceContext>();
  for (const r of resources) {
    const location = locations.find((l) => l.id === r.location_id)!;
    out.set(r.id, {
      id: r.id,
      name: r.name,
      kind: r.kind,
      locationId: r.location_id,
      sortOrder: r.sort_order,
      isActive: r.is_active,
      timezone: location.timezone ?? tenant.timezone,
      locationActive: location.is_active,
      input: {
        timezone: location.timezone ?? tenant.timezone,
        holidays: holidaySet,
        location: {
          weekly: hours
            .filter((h) => h.location_id === location.id)
            .map((h): WeeklyRule => ({
              weekday: h.weekday,
              startMinute: h.start_minute,
              endMinute: h.end_minute,
            })),
          overrides: overridesMap(locOverrides.filter((o) => o.location_id === location.id)),
        },
        resource: {
          weekly: schedules
            .filter((s) => s.resource_id === r.id)
            .map((s): WeeklyRule => ({
              weekday: s.weekday,
              startMinute: s.start_minute,
              endMinute: s.end_minute,
              validFrom: s.valid_from ? dateStr(s.valid_from) : null,
              validTo: s.valid_to ? dateStr(s.valid_to) : null,
            })),
          overrides: overridesMap(resOverrides.filter((o) => o.resource_id === r.id)),
        },
      },
    });
  }
  return out;
}

/** Rangos de trabajo de un recurso. Una sucursal o un recurso desactivados no atienden. */
export function workingRanges(ctx: ResourceContext, fromDate: string, toDate_: string): UtcRange[] {
  return ctx.locationActive && ctx.isActive
    ? resolveWorkingRanges(ctx.input, fromDate, toDate_)
    : [];
}

export interface Busy {
  /** Ocupación de reservas activas (con buffers), por recurso. */
  reservations: Map<string, UtcRange[]>;
  /** Bloqueos (ausencias, mantenimiento), por recurso. */
  blocks: Map<string, UtcRange[]>;
}

/**
 * Lo ocupado de cada recurso en una ventana: reservas activas (con sus buffers) y bloqueos.
 * `excludeReservationId` permite ignorar la propia reserva al reprogramarla.
 */
export async function loadBusy(
  tx: Tx,
  resourceIds: string[],
  window: UtcRange,
  excludeReservationId?: string,
): Promise<Busy> {
  const occupied = await tx.reservation_resources.findMany({
    where: {
      resource_id: { in: resourceIds },
      is_active: true,
      occupy_start: { lt: window.end },
      occupy_end: { gt: window.start },
      ...(excludeReservationId ? { reservation_id: { not: excludeReservationId } } : {}),
      // Una retención vencida ya no ocupa, aunque el worker aún no la haya liberado (la escritura la libera
      // bajo el lock antes de comprobar). OR explícito: evita la lógica de tres valores de NOT con NULL.
      reservations: {
        OR: [
          { status: { not: 'pending' } },
          { hold_expires_at: null },
          { hold_expires_at: { gt: new Date() } },
        ],
      },
    },
    select: { resource_id: true, occupy_start: true, occupy_end: true },
  });
  const blocks = await tx.availability_blocks.findMany({
    where: {
      resource_id: { in: resourceIds },
      start_at: { lt: window.end },
      end_at: { gt: window.start },
    },
    select: { resource_id: true, start_at: true, end_at: true },
  });
  const busy: Busy = {
    reservations: new Map(resourceIds.map((id) => [id, []])),
    blocks: new Map(resourceIds.map((id) => [id, []])),
  };
  for (const o of occupied)
    busy.reservations.get(o.resource_id)!.push({ start: o.occupy_start, end: o.occupy_end });
  for (const b of blocks)
    busy.blocks.get(b.resource_id)!.push({ start: b.start_at, end: b.end_at });
  return busy;
}

export const busyOf = (busy: Busy, resourceId: string): UtcRange[] => [
  ...(busy.reservations.get(resourceId) ?? []),
  ...(busy.blocks.get(resourceId) ?? []),
];

/** Minutos ya reservados de un recurso dentro de una ventana (para repartir la carga al asignar). */
export function bookedMinutes(busy: Busy, resourceId: string, window: UtcRange): number {
  let ms = 0;
  for (const r of busy.reservations.get(resourceId) ?? []) {
    const s = Math.max(r.start.getTime(), window.start.getTime());
    const e = Math.min(r.end.getTime(), window.end.getTime());
    if (e > s) ms += e - s;
  }
  return Math.round(ms / 60_000);
}

/** Ventana UTC que cubre los días locales [fromDate, toDate] en una zona horaria. */
export function localWindow(timezone: string, fromDate: string, toDate_: string): UtcRange {
  const [first] = localIntervalsToUtc(timezone, fromDate, [{ start: 0, end: 1440 }]);
  const [last] = localIntervalsToUtc(timezone, toDate_, [{ start: 0, end: 1440 }]);
  return { start: first!.start, end: last!.end };
}

export type BookingSource = 'admin' | 'public_web' | 'whatsapp' | 'api';

/**
 * Desde cuándo y hasta cuándo se puede reservar (ADR-014).
 *  - Canales del cliente (web, WhatsApp, API): antelación mínima y máxima del servicio o, si no tiene, de la empresa.
 *  - Panel (personal de la empresa): sin antelación mínima (atiende llamadas y clientes en el local), pero nunca en
 *    el pasado; hasta 365 días.
 */
export function bookingWindow(
  source: BookingSource,
  settings: { booking_min_notice_minutes: number; booking_max_advance_days: number },
  service: { min_notice_minutes: number | null; max_advance_days: number | null },
  now: Date,
): { earliestStart: Date; latestStart: Date } {
  if (source === 'admin') {
    return { earliestStart: now, latestStart: new Date(now.getTime() + 365 * 86_400_000) };
  }
  const minNotice = service.min_notice_minutes ?? settings.booking_min_notice_minutes;
  const maxDays = service.max_advance_days ?? settings.booking_max_advance_days;
  return {
    earliestStart: new Date(now.getTime() + minNotice * 60_000),
    latestStart: new Date(now.getTime() + maxDays * 86_400_000),
  };
}

export const DEFAULT_SETTINGS = {
  booking_min_notice_minutes: 60,
  booking_max_advance_days: 90,
  slot_step_minutes: 15,
  auto_confirm: true,
  pending_hold_minutes: 30,
  cancel_window_hours: 24,
  cancel_requires_approval: false,
  reschedule_window_hours: 24,
  max_reschedules: 2,
  self_service_actions: { cancel: true, confirm: true, details: true, reschedule: true } as unknown,
  public_booking_enabled: true,
  max_active_public_per_customer: 3,
};
export type BookingSettings = typeof DEFAULT_SETTINGS;

/** Configuración de reservas de la empresa (la fila existe desde el registro; si no, los valores por defecto). */
export async function loadSettings(tx: Tx): Promise<BookingSettings> {
  const s = await tx.tenant_settings.findFirst();
  return s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;
}

/**
 * Servicio reservable en una sucursal, con los recursos que pueden prestarlo allí (activos).
 * Lanza 404/400 con mensajes para el usuario si el servicio no se ofrece.
 */
export async function loadBookable(
  tx: Tx,
  serviceId: string,
  locationId: string,
  /** Canales públicos: solo recursos reservables online. */
  onlineOnly = false,
) {
  const service = await tx.services.findFirst({
    where: { id: serviceId },
    include: {
      service_locations: { where: { location_id: locationId }, select: { location_id: true } },
      service_resources: {
        where: {
          resources: {
            location_id: locationId,
            is_active: true,
            ...(onlineOnly ? { is_bookable_online: true } : {}),
          },
        },
        select: { resource_id: true, resources: { select: { auto_assignable: true } } },
      },
    },
  });
  if (!service) throw Errors.notFound('Servicio');
  const location = await tx.locations.findFirst({ where: { id: locationId } });
  if (!location) throw Errors.notFound('Sucursal');
  if (!service.is_active || !location.is_active || service.service_locations.length === 0) {
    throw Errors.validation([
      { path: 'serviceId', message: 'Ese servicio no está disponible en esa sucursal' },
    ]);
  }
  return {
    service,
    location,
    resourceIds: service.service_resources.map((r) => r.resource_id).sort(),
    autoAssignable: new Set(
      service.service_resources
        .filter((r) => r.resources.auto_assignable)
        .map((r) => r.resource_id),
    ),
  };
}

/** Bloquea las filas de los recursos (orden fijo por id => sin deadlocks) hasta el fin de la transacción. */
export async function lockResources(tx: Tx, resourceIds: string[]): Promise<void> {
  if (resourceIds.length === 0) return;
  const sorted = [...new Set(resourceIds)].sort();
  await tx.$queryRaw`SELECT id FROM resources WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
}

/** Estados que aún van a ocurrir (o están ocurriendo): los que impiden desactivar un recurso o una sucursal. */
export const UPCOMING_STATUSES = ['pending', 'confirmed', 'in_progress'];

/**
 * ¿Hay reservas activas que ocupen estos recursos en el rango? Llamar CON los recursos bloqueados
 * (`lockResources`): así nadie puede reservar entre la comprobación y el cambio que se protege.
 */
export async function overlappingReservations(
  tx: Tx,
  resourceIds: string[],
  range: UtcRange,
): Promise<number> {
  return tx.reservation_resources.count({
    where: {
      resource_id: { in: resourceIds },
      is_active: true,
      occupy_start: { lt: range.end },
      occupy_end: { gt: range.start },
    },
  });
}

/** Reservas futuras (o en curso) de unos recursos o de una sucursal. */
export async function upcomingReservations(
  tx: Tx,
  filter: { resourceIds: string[] } | { locationId: string },
): Promise<number> {
  return tx.reservations.count({
    where: {
      status: { in: UPCOMING_STATUSES },
      end_at: { gt: new Date() },
      ...('locationId' in filter
        ? { location_id: filter.locationId }
        : { reservation_resources: { some: { resource_id: { in: filter.resourceIds } } } }),
    },
  });
}

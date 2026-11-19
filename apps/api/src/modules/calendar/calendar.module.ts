import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  type CalendarQuery,
  type CalendarResponse,
  calendarQuery,
  calendarResponse,
} from '@reservepro/contracts';
import {
  type DayOverride,
  type ScheduleInput,
  type WeeklyRule,
  localIntervalsToUtc,
  resolveWorkingRanges,
} from '@reservepro/booking-domain';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequireAnyPermission } from '../../platform/rbac/authz.decorators.js';

const dateStr = (d: Date): string => d.toISOString().slice(0, 10);
const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

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

/**
 * Calendario administrativo (solo lectura). Hoy muestra, por recurso, sus rangos de trabajo (horario semanal +
 * excepciones + feriados + cambio de hora) y sus bloqueos. La Fase 3 añadirá las reservas.
 * La lógica de horarios vive en `@reservepro/booking-domain` (pura y probada): aquí solo se cargan los datos.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly cls: ClsService,
  ) {}

  async get(q: CalendarQuery): Promise<CalendarResponse> {
    const principal = this.cls.get('principal');
    if (!principal?.tenantId) throw Errors.tenantRequired();
    // calendar:read ve todo; solo calendar:read:own ve únicamente SU agenda (el recurso vinculado a su usuario).
    const seesAll = principal.permissions.has('calendar:read');
    const ownOnly = !seesAll;

    return this.tdb.runAsPrincipal(async (tx) => {
      const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
      const resources = await tx.resources.findMany({
        where: {
          is_active: true,
          ...(q.locationId ? { location_id: q.locationId } : {}),
          ...(q.resourceId ? { id: q.resourceId } : {}),
          ...(ownOnly ? { membership_id: principal.membershipId } : {}),
        },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      if (q.resourceId && resources.length === 0) throw Errors.notFound('Recurso');

      const resourceIds = resources.map((r) => r.id);
      const locationIds = [...new Set(resources.map((r) => r.location_id))];
      const from = toDate(q.from);
      const to = toDate(q.to);

      const [locations, hours, locOverrides, holidays, schedules, resOverrides] = await Promise.all(
        [
          tx.locations.findMany({ where: { id: { in: locationIds } } }),
          tx.business_hours.findMany({ where: { location_id: { in: locationIds } } }),
          tx.schedule_overrides.findMany({
            where: { location_id: { in: locationIds }, on_date: { gte: from, lte: to } },
          }),
          tx.holidays.findMany({ where: { on_date: { gte: from, lte: to } } }),
          tx.resource_schedules.findMany({ where: { resource_id: { in: resourceIds } } }),
          tx.schedule_overrides.findMany({
            where: { resource_id: { in: resourceIds }, on_date: { gte: from, lte: to } },
          }),
        ],
      );
      const holidaySet = new Set(holidays.map((h) => dateStr(h.on_date)));

      // Los bloqueos se piden con un margen de 1 día por cada lado (las zonas horarias desplazan el día local).
      const blocks = await tx.availability_blocks.findMany({
        where: {
          resource_id: { in: resourceIds },
          start_at: { lt: new Date(to.getTime() + 2 * 86_400_000) },
          end_at: { gt: new Date(from.getTime() - 86_400_000) },
        },
        orderBy: { start_at: 'asc' },
      });

      const out: CalendarResponse['resources'] = resources.map((r) => {
        const location = locations.find((l) => l.id === r.location_id)!;
        const timezone = location.timezone ?? tenant.timezone;
        const input: ScheduleInput = {
          timezone,
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
        };

        // Una sucursal desactivada no atiende: sin tiempo de trabajo.
        const working = location.is_active ? resolveWorkingRanges(input, q.from, q.to) : [];

        // Ventana real del rango pedido en la zona del recurso (para no devolver bloqueos de días vecinos).
        const [first] = localIntervalsToUtc(timezone, q.from, [{ start: 0, end: 1440 }]);
        const [last] = localIntervalsToUtc(timezone, q.to, [{ start: 0, end: 1440 }]);
        const windowStart = first!.start.getTime();
        const windowEnd = last!.end.getTime();

        return {
          resourceId: r.id,
          name: r.name,
          kind: r.kind,
          locationId: r.location_id,
          timezone,
          working: working.map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() })),
          blocks: blocks
            .filter(
              (b) =>
                b.resource_id === r.id &&
                b.start_at.getTime() < windowEnd &&
                b.end_at.getTime() > windowStart,
            )
            .map((b) => ({
              id: b.id,
              kind: b.kind as 'time_off',
              start: b.start_at.toISOString(),
              end: b.end_at.toISOString(),
              reason: b.reason,
            })),
        };
      });

      return { from: q.from, to: q.to, resources: out };
    });
  }
}

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @ApiDoc({
    summary: 'Calendario de recursos (solo lectura)',
    description:
      'Rangos de trabajo (UTC) y bloqueos de cada recurso activo entre dos fechas locales, máximo 31 días. ' +
      'Con `calendar:read` se ve todo; con solo `calendar:read:own`, únicamente la agenda del recurso vinculado al propio usuario.',
    response: calendarResponse,
    errors: { 404: 'Recurso no encontrado o no visible para el usuario' },
  })
  @RequireAnyPermission('calendar:read', 'calendar:read:own')
  @Get()
  get(@Query(new ZodPipe(calendarQuery)) q: CalendarQuery) {
    return this.calendar.get(q);
  }
}

@Module({ controllers: [CalendarController], providers: [CalendarService] })
export class CalendarModule {}

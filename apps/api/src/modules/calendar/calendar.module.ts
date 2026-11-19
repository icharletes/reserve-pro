import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  type CalendarQuery,
  type CalendarResponse,
  calendarQuery,
  calendarResponse,
} from '@reservepro/contracts';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequireAnyPermission } from '../../platform/rbac/authz.decorators.js';
import {
  loadResourceContexts,
  localWindow,
  workingRanges,
} from '../reservations/booking-context.js';

const DAY = 86_400_000;

/**
 * Calendario administrativo (solo lectura): por recurso, sus rangos de trabajo (horario semanal + excepciones +
 * feriados + cambio de hora), sus bloqueos y sus reservas activas. Usa el MISMO cargador de horarios que la
 * disponibilidad y el motor de reservas, así que el calendario nunca muestra un horario distinto al que se reserva.
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
    const ownOnly = !principal.permissions.has('calendar:read');

    return this.tdb.runAsPrincipal(async (tx) => {
      const resources = await tx.resources.findMany({
        where: {
          is_active: true,
          ...(q.locationId ? { location_id: q.locationId } : {}),
          ...(q.resourceId ? { id: q.resourceId } : {}),
          ...(ownOnly ? { membership_id: principal.membershipId } : {}),
        },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        take: 500,
        select: { id: true },
      });
      if (q.resourceId && resources.length === 0) throw Errors.notFound('Recurso');
      const ids = resources.map((r) => r.id);
      const contexts = await loadResourceContexts(tx, ids, q.from, q.to);

      // Margen de 1 día por cada lado (las zonas horarias desplazan el día local); luego se recorta por recurso.
      const outer = {
        start: new Date(Date.parse(`${q.from}T00:00:00Z`) - DAY),
        end: new Date(Date.parse(`${q.to}T00:00:00Z`) + 2 * DAY),
      };
      const blocks = await tx.availability_blocks.findMany({
        where: {
          resource_id: { in: ids },
          start_at: { lt: outer.end },
          end_at: { gt: outer.start },
        },
        orderBy: { start_at: 'asc' },
      });
      const booked = await tx.reservation_resources.findMany({
        where: {
          resource_id: { in: ids },
          is_active: true,
          occupy_start: { lt: outer.end },
          occupy_end: { gt: outer.start },
        },
        select: {
          resource_id: true,
          reservations: {
            select: {
              id: true,
              code: true,
              status: true,
              start_at: true,
              end_at: true,
              customers: { select: { first_name: true, last_name: true } },
              reservation_items: { select: { service_name: true }, orderBy: { position: 'asc' } },
            },
          },
        },
        orderBy: { occupy_start: 'asc' },
      });

      const out: CalendarResponse['resources'] = ids.map((id) => {
        const ctx = contexts.get(id)!;
        const window = localWindow(ctx.timezone, q.from, q.to);
        const inWindow = (s: Date, e: Date) => s < window.end && e > window.start;
        return {
          resourceId: ctx.id,
          name: ctx.name,
          kind: ctx.kind,
          locationId: ctx.locationId,
          timezone: ctx.timezone,
          working: workingRanges(ctx, q.from, q.to).map((w) => ({
            start: w.start.toISOString(),
            end: w.end.toISOString(),
          })),
          blocks: blocks
            .filter((b) => b.resource_id === id && inWindow(b.start_at, b.end_at))
            .map((b) => ({
              id: b.id,
              kind: b.kind as CalendarResponse['resources'][number]['blocks'][number]['kind'],
              start: b.start_at.toISOString(),
              end: b.end_at.toISOString(),
              reason: b.reason,
            })),
          reservations: booked
            .filter(
              (x) =>
                x.resource_id === id && inWindow(x.reservations.start_at, x.reservations.end_at),
            )
            .map(({ reservations: r }) => ({
              id: r.id,
              code: r.code,
              status: r.status,
              start: r.start_at.toISOString(),
              end: r.end_at.toISOString(),
              customerName: [r.customers.first_name, r.customers.last_name]
                .filter(Boolean)
                .join(' '),
              serviceName: r.reservation_items.map((i) => i.service_name).join(', '),
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
      'Rangos de trabajo (UTC), bloqueos y reservas activas de cada recurso activo entre dos fechas locales, máximo 31 días. ' +
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

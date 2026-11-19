import { Controller, Get, Injectable, Query } from '@nestjs/common';
import {
  type AvailabilityQuery,
  type AvailabilityResponse,
  availabilityQuery,
  availabilityResponse,
} from '@reservepro/contracts';
import { addCalendarDays, availableSlots } from '@reservepro/booking-domain';
import { ZodPipe } from '../../common/zod.pipe.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequireAnyPermission } from '../../platform/rbac/authz.decorators.js';
import { Errors } from '../../common/errors.js';
import {
  type BookingSource,
  bookingWindow,
  busyOf,
  loadBookable,
  loadBusy,
  loadResourceContexts,
  loadSettings,
  localWindow,
  workingRanges,
} from './booking-context.js';

const DAY = 86_400_000;

/**
 * Horarios libres de un servicio en una sucursal, por recurso. Es SOLO informativo: crear la reserva vuelve a
 * validarlo todo dentro de la transacción con el recurso bloqueado (ARCHITECTURE.md §6).
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly tdb: TenantDb) {}

  /**
   * Panel: la empresa de la sesión. Portal: la del slug (`tenantId` explícito), con la antelación de los canales
   * públicos y solo recursos reservables online.
   */
  async get(
    q: AvailabilityQuery,
    opts: {
      tenantId?: string;
      source?: BookingSource;
      onlineOnly?: boolean;
      /** Al reprogramar: la propia reserva no cuenta como ocupada. */
      excludeReservationId?: string;
    } = {},
  ): Promise<AvailabilityResponse> {
    const source = opts.source ?? 'admin';
    const tenantId = opts.tenantId ?? this.tdb.tenantId;
    return this.tdb.run({ tenantId }, async (tx) => {
      const { service, location, resourceIds } = await loadBookable(
        tx,
        q.serviceId,
        q.locationId,
        opts.onlineOnly,
      );
      if (q.resourceId && !resourceIds.includes(q.resourceId)) throw Errors.notFound('Recurso');
      const ids = q.resourceId ? [q.resourceId] : resourceIds;
      const settings = await loadSettings(tx);
      const lastDate = addCalendarDays(q.from, q.days - 1);
      // Un día antes: un turno que empieza la noche anterior puede ocupar la madrugada del primer día.
      const contexts = await loadResourceContexts(tx, ids, addCalendarDays(q.from, -1), lastDate);
      const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
      const timezone = location.timezone ?? tenant.timezone;
      const window = localWindow(timezone, q.from, lastDate);
      const busy = await loadBusy(
        tx,
        ids,
        {
          start: new Date(window.start.getTime() - DAY),
          end: new Date(window.end.getTime() + DAY),
        },
        opts.excludeReservationId,
      );
      const limits = bookingWindow(source, settings, service, new Date());
      const timing = {
        durationMinutes: service.duration_minutes,
        bufferBeforeMinutes: service.buffer_before_minutes,
        bufferAfterMinutes: service.buffer_after_minutes,
      };

      const resources = ids
        .map((id) => contexts.get(id)!)
        .sort(
          (a, b) =>
            a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
        .map((ctx) => {
          const slots = availableSlots({
            ...timing,
            ...limits,
            stepMinutes: settings.slot_step_minutes,
            working: workingRanges(ctx, addCalendarDays(q.from, -1), lastDate),
            busy: busyOf(busy, ctx.id),
          }).filter((s) => s.start >= window.start && s.start < window.end);
          return {
            resourceId: ctx.id,
            name: ctx.name,
            slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
          };
        });
      return { timezone, stepMinutes: settings.slot_step_minutes, resources };
    });
  }
}

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @ApiDoc({
    summary: 'Horarios disponibles',
    description:
      'Horarios libres (UTC) de un servicio en una sucursal, por recurso, desde la fecha local `from` durante `days` días (máx. 14). ' +
      'Es informativo: al reservar se vuelve a validar.',
    response: availabilityResponse,
    errors: {
      400: 'El servicio no se ofrece en esa sucursal',
      404: 'Servicio, sucursal o recurso no encontrado',
    },
  })
  @RequireAnyPermission('reservations:create', 'reservations:reschedule')
  @Get()
  get(@Query(new ZodPipe(availabilityQuery)) q: AvailabilityQuery) {
    return this.availability.get(q);
  }
}

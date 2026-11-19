import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  type BusinessHoursView,
  type HolidayListQuery,
  type HolidayView,
  type OverrideListQuery,
  type OverrideView,
  type PutHolidayRequest,
  type PutOverrideRequest,
  type ResourceScheduleView,
  type SetBusinessHoursRequest,
  type SetResourceScheduleRequest,
  businessHoursView,
  clockToMinutes,
  holidayListQuery,
  holidayView,
  isoDate,
  overrideListQuery,
  overrideView,
  putHolidayRequest,
  putOverrideRequest,
  resourceScheduleView,
  setBusinessHoursRequest,
  setResourceScheduleRequest,
  uuid,
} from '@reservepro/contracts';
import { formatClock } from '@reservepro/booking-domain';
import type { Prisma } from '@reservepro/database';
import { z } from 'zod';
import { Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';
import { assertNoOverlap, lockRow } from './schedules.helpers.js';

const asJson = (v: unknown) => v as Prisma.InputJsonValue;
const dateStr = (d: Date): string => d.toISOString().slice(0, 10);
const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

@Injectable()
export class AvailabilityConfigService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  // ===== Horario semanal de la sucursal ==========================================================
  async getBusinessHours(locationId: string): Promise<BusinessHoursView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      if (!(await tx.locations.findFirst({ where: { id: locationId }, select: { id: true } })))
        throw Errors.notFound('Sucursal');
      const rows = await tx.business_hours.findMany({
        where: { location_id: locationId },
        orderBy: [{ weekday: 'asc' }, { start_minute: 'asc' }],
      });
      return {
        intervals: rows.map((r) => ({
          weekday: r.weekday,
          start: formatClock(r.start_minute),
          end: formatClock(r.end_minute),
        })),
      };
    });
  }

  /** Reemplaza TODO el horario semanal (un solo PUT atómico: lo que envía el editor semanal). */
  async setBusinessHours(
    locationId: string,
    dto: SetBusinessHoursRequest,
  ): Promise<BusinessHoursView> {
    assertNoOverlap(dto.intervals);
    return this.tdb.runAsPrincipal(async (tx) => {
      if (!(await tx.locations.findFirst({ where: { id: locationId }, select: { id: true } })))
        throw Errors.notFound('Sucursal');
      await lockRow(tx, 'locations', locationId);
      const before = await this.getBusinessHoursTx(tx, locationId);
      await tx.business_hours.deleteMany({ where: { location_id: locationId } });
      await tx.business_hours.createMany({
        data: dto.intervals.map((i) => ({
          id: uuidv7(),
          tenant_id: this.tdb.tenantId,
          location_id: locationId,
          weekday: i.weekday,
          start_minute: clockToMinutes(i.start),
          end_minute: clockToMinutes(i.end),
        })),
      });
      const after = await this.getBusinessHoursTx(tx, locationId);
      await this.audit.record(tx, {
        action: 'business_hours.updated',
        entityType: 'location',
        entityId: locationId,
        before: asJson(before),
        after: asJson(after),
      });
      return after;
    });
  }

  private async getBusinessHoursTx(
    tx: Prisma.TransactionClient,
    locationId: string,
  ): Promise<BusinessHoursView> {
    const rows = await tx.business_hours.findMany({
      where: { location_id: locationId },
      orderBy: [{ weekday: 'asc' }, { start_minute: 'asc' }],
    });
    return {
      intervals: rows.map((r) => ({
        weekday: r.weekday,
        start: formatClock(r.start_minute),
        end: formatClock(r.end_minute),
      })),
    };
  }

  // ===== Horario semanal del recurso (con vigencia) ================================================
  private async getScheduleTx(
    tx: Prisma.TransactionClient,
    resourceId: string,
  ): Promise<ResourceScheduleView> {
    const rows = await tx.resource_schedules.findMany({
      where: { resource_id: resourceId },
      orderBy: [{ weekday: 'asc' }, { start_minute: 'asc' }],
    });
    return {
      intervals: rows.map((r) => ({
        weekday: r.weekday,
        start: formatClock(r.start_minute),
        end: formatClock(r.end_minute),
        validFrom: r.valid_from ? dateStr(r.valid_from) : null,
        validTo: r.valid_to ? dateStr(r.valid_to) : null,
      })),
    };
  }

  async getResourceSchedule(resourceId: string): Promise<ResourceScheduleView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      if (!(await tx.resources.findFirst({ where: { id: resourceId }, select: { id: true } })))
        throw Errors.notFound('Recurso');
      return this.getScheduleTx(tx, resourceId);
    });
  }

  async setResourceSchedule(
    resourceId: string,
    dto: SetResourceScheduleRequest,
  ): Promise<ResourceScheduleView> {
    assertNoOverlap(dto.intervals);
    return this.tdb.runAsPrincipal(async (tx) => {
      if (!(await tx.resources.findFirst({ where: { id: resourceId }, select: { id: true } })))
        throw Errors.notFound('Recurso');
      await lockRow(tx, 'resources', resourceId);
      const before = await this.getScheduleTx(tx, resourceId);
      await tx.resource_schedules.deleteMany({ where: { resource_id: resourceId } });
      await tx.resource_schedules.createMany({
        data: dto.intervals.map((i) => ({
          id: uuidv7(),
          tenant_id: this.tdb.tenantId,
          resource_id: resourceId,
          weekday: i.weekday,
          start_minute: clockToMinutes(i.start),
          end_minute: clockToMinutes(i.end),
          valid_from: i.validFrom ? toDate(i.validFrom) : null,
          valid_to: i.validTo ? toDate(i.validTo) : null,
        })),
      });
      const after = await this.getScheduleTx(tx, resourceId);
      await this.audit.record(tx, {
        action: 'resource_schedule.updated',
        entityType: 'resource',
        entityId: resourceId,
        before: asJson(before),
        after: asJson(after),
      });
      return after;
    });
  }

  // ===== Excepciones por fecha (sucursal o recurso) ================================================
  private async scopeExists(
    tx: Prisma.TransactionClient,
    scope: 'location' | 'resource',
    id: string,
  ): Promise<void> {
    const found =
      scope === 'location'
        ? await tx.locations.findFirst({ where: { id }, select: { id: true } })
        : await tx.resources.findFirst({ where: { id }, select: { id: true } });
    if (!found) throw Errors.notFound(scope === 'location' ? 'Sucursal' : 'Recurso');
  }

  private groupOverrides(
    rows: {
      on_date: Date;
      is_closed: boolean;
      start_minute: number;
      end_minute: number;
      reason: string | null;
    }[],
  ): OverrideView[] {
    const byDate = new Map<string, OverrideView>();
    for (const r of rows) {
      const date = dateStr(r.on_date);
      const v = byDate.get(date) ?? { date, closed: r.is_closed, intervals: [], reason: r.reason };
      if (!r.is_closed)
        v.intervals.push({ start: formatClock(r.start_minute), end: formatClock(r.end_minute) });
      byDate.set(date, v);
    }
    return [...byDate.values()];
  }

  async listOverrides(
    scope: 'location' | 'resource',
    id: string,
    q: OverrideListQuery,
  ): Promise<OverrideView[]> {
    return this.tdb.runAsPrincipal(async (tx) => {
      await this.scopeExists(tx, scope, id);
      const rows = await tx.schedule_overrides.findMany({
        where: {
          ...(scope === 'location' ? { location_id: id } : { resource_id: id }),
          on_date: { gte: toDate(q.from), lte: toDate(q.to) },
        },
        orderBy: [{ on_date: 'asc' }, { start_minute: 'asc' }],
      });
      return this.groupOverrides(rows);
    });
  }

  /** Reemplaza TODA la excepción de ese día (cerrado, o uno o varios tramos abiertos). */
  async putOverride(
    scope: 'location' | 'resource',
    id: string,
    date: string,
    dto: PutOverrideRequest,
  ): Promise<OverrideView> {
    assertNoOverlap(dto.intervals);
    return this.tdb.runAsPrincipal(async (tx) => {
      await this.scopeExists(tx, scope, id);
      await lockRow(tx, scope === 'location' ? 'locations' : 'resources', id);
      const where = {
        ...(scope === 'location' ? { location_id: id } : { resource_id: id }),
        on_date: toDate(date),
      };
      const before = this.groupOverrides(await tx.schedule_overrides.findMany({ where }));
      await tx.schedule_overrides.deleteMany({ where });
      const base = {
        tenant_id: this.tdb.tenantId,
        location_id: scope === 'location' ? id : null,
        resource_id: scope === 'resource' ? id : null,
        on_date: toDate(date),
        reason: dto.reason ?? null,
      };
      await tx.schedule_overrides.createMany({
        data: dto.closed
          ? [{ id: uuidv7(), ...base, is_closed: true, start_minute: 0, end_minute: 1440 }]
          : dto.intervals.map((i) => ({
              id: uuidv7(),
              ...base,
              is_closed: false,
              start_minute: clockToMinutes(i.start),
              end_minute: clockToMinutes(i.end),
            })),
      });
      const after = this.groupOverrides(
        await tx.schedule_overrides.findMany({ where, orderBy: { start_minute: 'asc' } }),
      )[0]!;
      await this.audit.record(tx, {
        action: 'schedule_override.set',
        entityType: scope,
        entityId: id,
        before: asJson({ date, override: before[0] ?? null }),
        after: asJson({ date, override: after }),
      });
      return after;
    });
  }

  async removeOverride(scope: 'location' | 'resource', id: string, date: string): Promise<void> {
    await this.tdb.runAsPrincipal(async (tx) => {
      await this.scopeExists(tx, scope, id);
      const res = await tx.schedule_overrides.deleteMany({
        where: {
          ...(scope === 'location' ? { location_id: id } : { resource_id: id }),
          on_date: toDate(date),
        },
      });
      if (res.count === 0) throw Errors.notFound('Excepción');
      await this.audit.record(tx, {
        action: 'schedule_override.removed',
        entityType: scope,
        entityId: id,
        before: asJson({ date }),
      });
    });
  }

  // ===== Feriados ====================================================================================
  async listHolidays(q: HolidayListQuery): Promise<HolidayView[]> {
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.holidays.findMany({
        where: { on_date: { gte: toDate(`${q.year}-01-01`), lte: toDate(`${q.year}-12-31`) } },
        orderBy: { on_date: 'asc' },
      }),
    );
    return rows.map((h) => ({ date: dateStr(h.on_date), name: h.name }));
  }

  async putHoliday(date: string, dto: PutHolidayRequest): Promise<HolidayView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const where = { tenant_id_on_date: { tenant_id: this.tdb.tenantId, on_date: toDate(date) } };
      const row = await tx.holidays.upsert({
        where,
        create: { tenant_id: this.tdb.tenantId, on_date: toDate(date), name: dto.name },
        update: { name: dto.name },
      });
      await this.audit.record(tx, {
        action: 'holiday.set',
        entityType: 'holiday',
        after: asJson({ date, name: dto.name }),
      });
      return { date: dateStr(row.on_date), name: row.name };
    });
  }

  async removeHoliday(date: string): Promise<void> {
    await this.tdb.runAsPrincipal(async (tx) => {
      const res = await tx.holidays.deleteMany({ where: { on_date: toDate(date) } });
      if (res.count === 0) throw Errors.notFound('Feriado');
      await this.audit.record(tx, {
        action: 'holiday.removed',
        entityType: 'holiday',
        before: asJson({ date }),
      });
    });
  }
}

const idParam = new ZodPipe(uuid);
const dateParam = new ZodPipe(isoDate);

@Controller('locations')
export class LocationScheduleController {
  constructor(private readonly svc: AvailabilityConfigService) {}

  @ApiDoc({
    summary: 'Horario semanal de una sucursal',
    description:
      'Días ISO (1 = lunes … 7 = domingo), hora local de la sucursal. Una sucursal sin tramos está cerrada.',
    response: businessHoursView,
    errors: { 404: 'Sucursal no encontrada' },
  })
  @RequirePermissions('schedules:read')
  @Get(':id/business-hours')
  get(@Param('id', idParam) id: string) {
    return this.svc.getBusinessHours(id);
  }

  @ApiDoc({
    summary: 'Definir el horario semanal de una sucursal',
    description:
      'Reemplaza TODO el horario. Los tramos de un mismo día no pueden superponerse (pueden tocarse: 09-13 y 13-18).',
    response: businessHoursView,
    errors: { 404: 'Sucursal no encontrada' },
  })
  @RequirePermissions('schedules:write')
  @Put(':id/business-hours')
  set(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(setBusinessHoursRequest)) body: SetBusinessHoursRequest,
  ) {
    return this.svc.setBusinessHours(id, body);
  }

  @ApiDoc({
    summary: 'Excepciones de horario de una sucursal en un rango de fechas',
    response: z.array(overrideView),
  })
  @RequirePermissions('schedules:read')
  @Get(':id/overrides')
  listOverrides(
    @Param('id', idParam) id: string,
    @Query(new ZodPipe(overrideListQuery)) q: OverrideListQuery,
  ) {
    return this.svc.listOverrides('location', id, q);
  }

  @ApiDoc({
    summary: 'Definir la excepción de una fecha para la sucursal',
    description:
      'Cerrar el día, o abrir con tramos especiales (reemplaza el horario semanal ese día). Reemplaza la excepción previa de esa fecha.',
    response: overrideView,
    errors: { 404: 'Sucursal no encontrada' },
  })
  @RequirePermissions('schedules:write')
  @Put(':id/overrides/:date')
  putOverride(
    @Param('id', idParam) id: string,
    @Param('date', dateParam) date: string,
    @Body(new ZodPipe(putOverrideRequest)) body: PutOverrideRequest,
  ) {
    return this.svc.putOverride('location', id, date, body);
  }

  @ApiDoc({
    summary: 'Quitar la excepción de una fecha de la sucursal',
    response: null,
    errors: { 404: 'No hay excepción en esa fecha' },
  })
  @RequirePermissions('schedules:write')
  @Delete(':id/overrides/:date')
  @HttpCode(204)
  async removeOverride(
    @Param('id', idParam) id: string,
    @Param('date', dateParam) date: string,
  ): Promise<void> {
    await this.svc.removeOverride('location', id, date);
  }
}

@Controller('resources')
export class ResourceScheduleController {
  constructor(private readonly svc: AvailabilityConfigService) {}

  @ApiDoc({
    summary: 'Horario semanal de un recurso',
    description: 'Sin tramos, el recurso sigue el horario de su sucursal.',
    response: resourceScheduleView,
    errors: { 404: 'Recurso no encontrado' },
  })
  @RequirePermissions('schedules:read')
  @Get(':id/schedule')
  get(@Param('id', idParam) id: string) {
    return this.svc.getResourceSchedule(id);
  }

  @ApiDoc({
    summary: 'Definir el horario semanal de un recurso',
    description:
      'Reemplaza TODO el horario. Cada tramo puede tener vigencia (`validFrom`/`validTo`, inclusivas). Se intersecta siempre con el horario de la sucursal.',
    response: resourceScheduleView,
    errors: { 404: 'Recurso no encontrado' },
  })
  @RequirePermissions('schedules:write')
  @Put(':id/schedule')
  set(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(setResourceScheduleRequest)) body: SetResourceScheduleRequest,
  ) {
    return this.svc.setResourceSchedule(id, body);
  }

  @ApiDoc({
    summary: 'Excepciones de horario de un recurso en un rango de fechas',
    response: z.array(overrideView),
  })
  @RequirePermissions('schedules:read')
  @Get(':id/overrides')
  listOverrides(
    @Param('id', idParam) id: string,
    @Query(new ZodPipe(overrideListQuery)) q: OverrideListQuery,
  ) {
    return this.svc.listOverrides('resource', id, q);
  }

  @ApiDoc({
    summary: 'Definir la excepción de una fecha para el recurso',
    description:
      'Día libre o tramos especiales. Sigue limitado por el horario efectivo de la sucursal.',
    response: overrideView,
    errors: { 404: 'Recurso no encontrado' },
  })
  @RequirePermissions('schedules:write')
  @Put(':id/overrides/:date')
  putOverride(
    @Param('id', idParam) id: string,
    @Param('date', dateParam) date: string,
    @Body(new ZodPipe(putOverrideRequest)) body: PutOverrideRequest,
  ) {
    return this.svc.putOverride('resource', id, date, body);
  }

  @ApiDoc({
    summary: 'Quitar la excepción de una fecha del recurso',
    response: null,
    errors: { 404: 'No hay excepción en esa fecha' },
  })
  @RequirePermissions('schedules:write')
  @Delete(':id/overrides/:date')
  @HttpCode(204)
  async removeOverride(
    @Param('id', idParam) id: string,
    @Param('date', dateParam) date: string,
  ): Promise<void> {
    await this.svc.removeOverride('resource', id, date);
  }
}

@Controller('holidays')
export class HolidaysController {
  constructor(private readonly svc: AvailabilityConfigService) {}

  @ApiDoc({
    summary: 'Feriados de un año',
    description:
      'Un feriado cierra todas las sucursales ese día, salvo que una sucursal tenga una excepción propia para esa fecha.',
    response: z.array(holidayView),
  })
  @RequirePermissions('schedules:read')
  @Get()
  list(@Query(new ZodPipe(holidayListQuery)) q: HolidayListQuery) {
    return this.svc.listHolidays(q);
  }

  @ApiDoc({ summary: 'Crear o renombrar un feriado', response: holidayView })
  @RequirePermissions('schedules:write')
  @Put(':date')
  put(
    @Param('date', dateParam) date: string,
    @Body(new ZodPipe(putHolidayRequest)) body: PutHolidayRequest,
  ) {
    return this.svc.putHoliday(date, body);
  }

  @ApiDoc({
    summary: 'Quitar un feriado',
    response: null,
    errors: { 404: 'No hay feriado en esa fecha' },
  })
  @RequirePermissions('schedules:write')
  @Delete(':date')
  @HttpCode(204)
  async remove(@Param('date', dateParam) date: string): Promise<void> {
    await this.svc.removeHoliday(date);
  }
}

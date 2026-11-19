import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  type Address,
  type CatalogListQuery,
  type CreateLocationRequest,
  type LocationView,
  type UpdateLocationRequest,
  catalogListQuery,
  createLocationRequest,
  locationView,
  pageOf,
  updateLocationRequest,
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
import { guarded, iso, nameAndStatus } from './catalog.helpers.js';

type Row = {
  id: string;
  name: string;
  address: Prisma.JsonValue;
  phone: string | null;
  email: string | null;
  timezone: string | null;
  is_active: boolean;
  created_at: Date;
};

export const toLocationView = (l: Row, tenantTimezone: string): LocationView => ({
  id: l.id,
  name: l.name,
  address: (l.address ?? {}) as Address,
  phone: l.phone,
  email: l.email,
  timezone: l.timezone,
  effectiveTimezone: l.timezone ?? tenantTimezone,
  isActive: l.is_active,
  createdAt: iso(l.created_at),
});

@Injectable()
export class LocationsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: CatalogListQuery): Promise<Page<LocationView>> {
    const after = decodeCursor(q.cursor);
    return this.tdb.runAsPrincipal(async (tx) => {
      const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
      const rows = await tx.locations.findMany({
        where: { ...nameAndStatus(q), ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      });
      const page = toPage(rows, q.limit, (r) => r.id);
      return {
        items: page.items.map((r) => toLocationView(r, tenant.timezone)),
        nextCursor: page.nextCursor,
      };
    });
  }

  async get(id: string): Promise<LocationView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
      const row = await tx.locations.findFirst({ where: { id } });
      if (!row) throw Errors.notFound('Sucursal');
      return toLocationView(row, tenant.timezone);
    });
  }

  async create(dto: CreateLocationRequest): Promise<LocationView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
          const row = await tx.locations.create({
            data: {
              id: uuidv7(),
              tenant_id: this.tdb.tenantId,
              name: dto.name,
              address: dto.address as Prisma.InputJsonValue,
              phone: dto.phone ?? null,
              email: dto.email ?? null,
              timezone: dto.timezone ?? null,
            },
          });
          const view = toLocationView(row, tenant.timezone);
          await this.audit.record(tx, {
            action: 'location.created',
            entityType: 'location',
            entityId: row.id,
            after: view as unknown as Prisma.InputJsonValue,
          });
          return view;
        }),
      { duplicateMessage: 'Ya existe una sucursal con ese nombre' },
    );
  }

  async update(id: string, dto: UpdateLocationRequest): Promise<LocationView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const tenant = await tx.tenants.findFirstOrThrow({ select: { timezone: true } });
          const before = await tx.locations.findFirst({ where: { id } });
          if (!before) throw Errors.notFound('Sucursal');
          const after = await tx.locations.update({
            where: { id },
            data: {
              ...(dto.name !== undefined ? { name: dto.name } : {}),
              ...(dto.address !== undefined
                ? { address: dto.address as Prisma.InputJsonValue }
                : {}),
              ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
              ...(dto.email !== undefined ? { email: dto.email } : {}),
              ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
              ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
            },
          });
          await this.audit.record(tx, {
            action: 'location.updated',
            entityType: 'location',
            entityId: id,
            before: toLocationView(before, tenant.timezone) as unknown as Prisma.InputJsonValue,
            after: toLocationView(after, tenant.timezone) as unknown as Prisma.InputJsonValue,
          });
          return toLocationView(after, tenant.timezone);
        }),
      { duplicateMessage: 'Ya existe una sucursal con ese nombre' },
    );
  }

  /** Borra la sucursal y su configuración (horarios, excepciones, vínculos). Falla con IN_USE si tiene recursos. */
  async remove(id: string): Promise<void> {
    await guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const row = await tx.locations.findFirst({ where: { id } });
          if (!row) throw Errors.notFound('Sucursal');
          await tx.business_hours.deleteMany({ where: { location_id: id } });
          await tx.schedule_overrides.deleteMany({ where: { location_id: id } });
          await tx.service_locations.deleteMany({ where: { location_id: id } });
          await tx.locations.delete({ where: { id } }); // P2003 si aún tiene recursos (o, más adelante, reservas)
          await this.audit.record(tx, {
            action: 'location.deleted',
            entityType: 'location',
            entityId: id,
            before: { name: row.name },
          });
        }),
      {
        op: 'delete',
        inUseMessage:
          'No se puede eliminar: la sucursal tiene profesionales o recursos. Desactívala en su lugar.',
      },
    );
  }
}

const idParam = new ZodPipe(uuid);

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @ApiDoc({
    summary: 'Listar sucursales',
    description: 'Paginado por cursor; filtros `q` (nombre) e `isActive`.',
    response: pageOf(locationView),
  })
  @RequirePermissions('locations:read')
  @Get()
  list(@Query(new ZodPipe(catalogListQuery)) q: CatalogListQuery) {
    return this.locations.list(q);
  }

  @ApiDoc({
    summary: 'Ver una sucursal',
    response: locationView,
    errors: { 404: 'Sucursal no encontrada' },
  })
  @RequirePermissions('locations:read')
  @Get(':id')
  get(@Param('id', idParam) id: string) {
    return this.locations.get(id);
  }

  @ApiDoc({
    summary: 'Crear una sucursal',
    description: 'Sin `timezone` hereda la de la empresa.',
    response: locationView,
    errors: { 409: 'Ya existe una sucursal con ese nombre (DUPLICATE)' },
  })
  @RequirePermissions('locations:write')
  @Post()
  create(@Body(new ZodPipe(createLocationRequest)) body: CreateLocationRequest) {
    return this.locations.create(body);
  }

  @ApiDoc({
    summary: 'Editar o (des)activar una sucursal',
    response: locationView,
    errors: { 404: 'Sucursal no encontrada', 409: 'Nombre duplicado (DUPLICATE)' },
  })
  @RequirePermissions('locations:write')
  @Patch(':id')
  update(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateLocationRequest)) body: UpdateLocationRequest,
  ) {
    return this.locations.update(id, body);
  }

  @ApiDoc({
    summary: 'Eliminar una sucursal',
    description: 'Solo si no tiene recursos ni reservas; si no, desactívala.',
    response: null,
    errors: { 404: 'Sucursal no encontrada', 409: 'Está en uso (IN_USE)' },
  })
  @RequirePermissions('locations:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', idParam) id: string): Promise<void> {
    await this.locations.remove(id);
  }
}

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
  Put,
  Query,
} from '@nestjs/common';
import {
  type CreateServiceRequest,
  type ServiceListQuery,
  type ServiceView,
  type SetServiceLocationsRequest,
  type SetServiceResourcesRequest,
  type UpdateServiceRequest,
  createServiceRequest,
  pageOf,
  serviceListQuery,
  serviceView,
  setServiceLocationsRequest,
  setServiceResourcesRequest,
  updateServiceRequest,
  uuid,
} from '@reservepro/contracts';
import { Prisma, type Tx } from '@reservepro/database';
import { Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import { type Page, decodeCursor, toPage } from '../../common/pagination.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';
import { guarded, iso, nameAndStatus } from './catalog.helpers.js';

const include = {
  service_locations: { select: { location_id: true } },
  service_resources: { select: { resource_id: true } },
} as const;

type Row = Prisma.servicesGetPayload<{ include: typeof include }>;

const toView = (s: Row): ServiceView => ({
  id: s.id,
  name: s.name,
  description: s.description,
  categoryId: s.category_id,
  durationMinutes: s.duration_minutes,
  bufferBeforeMinutes: s.buffer_before_minutes,
  bufferAfterMinutes: s.buffer_after_minutes,
  price: s.price.toFixed(2),
  currency: s.currency,
  minNoticeMinutes: s.min_notice_minutes,
  maxAdvanceDays: s.max_advance_days,
  requiresConfirmation: s.requires_confirmation,
  imageUrl: s.image_url,
  isActive: s.is_active,
  locationIds: s.service_locations.map((l) => l.location_id).sort(),
  resourceIds: s.service_resources.map((r) => r.resource_id).sort(),
  createdAt: iso(s.created_at),
});

const asJson = (v: unknown) => v as Prisma.InputJsonValue;

@Injectable()
export class ServicesService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: ServiceListQuery): Promise<Page<ServiceView>> {
    const after = decodeCursor(q.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.services.findMany({
        where: {
          ...nameAndStatus(q),
          ...(q.categoryId ? { category_id: q.categoryId } : {}),
          ...(q.locationId ? { service_locations: { some: { location_id: q.locationId } } } : {}),
          ...(after ? { id: { gt: after } } : {}),
        },
        include,
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      }),
    );
    const page = toPage(rows, q.limit, (r) => r.id);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<ServiceView> {
    const row = await this.tdb.runAsPrincipal((tx) =>
      tx.services.findFirst({ where: { id }, include }),
    );
    if (!row) throw Errors.notFound('Servicio');
    return toView(row);
  }

  private async assertCategory(tx: Tx, categoryId: string | null | undefined): Promise<void> {
    if (!categoryId) return;
    if (
      !(await tx.service_categories.findFirst({ where: { id: categoryId }, select: { id: true } }))
    ) {
      throw Errors.validation([{ path: 'categoryId', message: 'La categoría no existe' }]);
    }
  }

  async create(dto: CreateServiceRequest): Promise<ServiceView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          await this.assertCategory(tx, dto.categoryId);
          // El servidor fija la moneda: la de la empresa. El cliente jamás la envía (ni precio ya "con moneda").
          const tenant = await tx.tenants.findFirstOrThrow({ select: { currency: true } });
          const row = await tx.services.create({
            data: {
              id: uuidv7(),
              tenant_id: this.tdb.tenantId,
              name: dto.name,
              description: dto.description ?? null,
              category_id: dto.categoryId ?? null,
              duration_minutes: dto.durationMinutes,
              buffer_before_minutes: dto.bufferBeforeMinutes,
              buffer_after_minutes: dto.bufferAfterMinutes,
              price: new Prisma.Decimal(dto.price),
              currency: tenant.currency,
              min_notice_minutes: dto.minNoticeMinutes ?? null,
              max_advance_days: dto.maxAdvanceDays ?? null,
              requires_confirmation: dto.requiresConfirmation ?? null,
              image_url: dto.imageUrl ?? null,
            },
            include,
          });
          await this.audit.record(tx, {
            action: 'service.created',
            entityType: 'service',
            entityId: row.id,
            after: asJson(toView(row)),
          });
          return toView(row);
        }),
      { duplicateMessage: 'Ya existe un servicio con ese nombre' },
    );
  }

  async update(id: string, dto: UpdateServiceRequest): Promise<ServiceView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const before = await tx.services.findFirst({ where: { id }, include });
          if (!before) throw Errors.notFound('Servicio');
          await this.assertCategory(tx, dto.categoryId);
          const after = await tx.services.update({
            where: { id },
            include,
            data: {
              ...(dto.name !== undefined ? { name: dto.name } : {}),
              ...(dto.description !== undefined ? { description: dto.description } : {}),
              ...(dto.categoryId !== undefined ? { category_id: dto.categoryId } : {}),
              ...(dto.durationMinutes !== undefined
                ? { duration_minutes: dto.durationMinutes }
                : {}),
              ...(dto.bufferBeforeMinutes !== undefined
                ? { buffer_before_minutes: dto.bufferBeforeMinutes }
                : {}),
              ...(dto.bufferAfterMinutes !== undefined
                ? { buffer_after_minutes: dto.bufferAfterMinutes }
                : {}),
              ...(dto.price !== undefined ? { price: new Prisma.Decimal(dto.price) } : {}),
              ...(dto.minNoticeMinutes !== undefined
                ? { min_notice_minutes: dto.minNoticeMinutes }
                : {}),
              ...(dto.maxAdvanceDays !== undefined ? { max_advance_days: dto.maxAdvanceDays } : {}),
              ...(dto.requiresConfirmation !== undefined
                ? { requires_confirmation: dto.requiresConfirmation }
                : {}),
              ...(dto.imageUrl !== undefined ? { image_url: dto.imageUrl } : {}),
              ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
            },
          });
          await this.audit.record(tx, {
            action: 'service.updated',
            entityType: 'service',
            entityId: id,
            before: asJson(toView(before)),
            after: asJson(toView(after)),
          });
          return toView(after);
        }),
      { duplicateMessage: 'Ya existe un servicio con ese nombre' },
    );
  }

  async remove(id: string): Promise<void> {
    await guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const row = await tx.services.findFirst({ where: { id } });
          if (!row) throw Errors.notFound('Servicio');
          await tx.service_resources.deleteMany({ where: { service_id: id } });
          await tx.service_locations.deleteMany({ where: { service_id: id } });
          await tx.services.delete({ where: { id } }); // P2003 si tiene reservas (Fase 3): se desactiva en su lugar
          await this.audit.record(tx, {
            action: 'service.deleted',
            entityType: 'service',
            entityId: id,
            before: { name: row.name },
          });
        }),
      {
        op: 'delete',
        inUseMessage: 'No se puede eliminar: el servicio tiene reservas. Desactívalo en su lugar.',
      },
    );
  }

  /**
   * Reemplaza las sucursales donde se ofrece el servicio. Los recursos vinculados que estén en una sucursal
   * que se QUITA se desvinculan en la misma transacción (un servicio no puede usar un recurso de una sucursal
   * donde ya no se ofrece).
   */
  async setLocations(id: string, dto: SetServiceLocationsRequest): Promise<ServiceView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const before = await tx.services.findFirst({ where: { id }, include });
      if (!before) throw Errors.notFound('Servicio');
      const wanted = [...new Set(dto.locationIds)];
      const found = await tx.locations.findMany({
        where: { id: { in: wanted } },
        select: { id: true },
      });
      if (found.length !== wanted.length) {
        throw Errors.validation([
          { path: 'locationIds', message: 'Una o más sucursales no existen' },
        ]);
      }
      const current = before.service_locations.map((l) => l.location_id);
      const removed = current.filter((l) => !wanted.includes(l));
      const added = wanted.filter((l) => !current.includes(l));

      if (removed.length > 0) {
        await tx.service_resources.deleteMany({
          where: { service_id: id, resources: { location_id: { in: removed } } },
        });
        await tx.service_locations.deleteMany({
          where: { service_id: id, location_id: { in: removed } },
        });
      }
      if (added.length > 0) {
        await tx.service_locations.createMany({
          data: added.map((location_id) => ({
            tenant_id: this.tdb.tenantId,
            service_id: id,
            location_id,
          })),
        });
      }
      const after = await tx.services.findFirstOrThrow({ where: { id }, include });
      await this.audit.record(tx, {
        action: 'service.locations_updated',
        entityType: 'service',
        entityId: id,
        before: asJson({
          locationIds: toView(before).locationIds,
          resourceIds: toView(before).resourceIds,
        }),
        after: asJson({
          locationIds: toView(after).locationIds,
          resourceIds: toView(after).resourceIds,
        }),
      });
      return toView(after);
    });
  }

  /** Reemplaza los recursos que pueden prestar el servicio. Cada uno debe estar en una sucursal donde se ofrece. */
  async setResources(id: string, dto: SetServiceResourcesRequest): Promise<ServiceView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const before = await tx.services.findFirst({ where: { id }, include });
      if (!before) throw Errors.notFound('Servicio');
      const wanted = [...new Set(dto.resourceIds)];
      const resources = await tx.resources.findMany({
        where: { id: { in: wanted } },
        select: { id: true, location_id: true },
      });
      if (resources.length !== wanted.length) {
        throw Errors.validation([
          { path: 'resourceIds', message: 'Uno o más recursos no existen' },
        ]);
      }
      const offered = new Set(before.service_locations.map((l) => l.location_id));
      const outside = resources.filter((r) => !offered.has(r.location_id));
      if (outside.length > 0) {
        throw Errors.validation([
          {
            path: 'resourceIds',
            message:
              'Hay recursos en sucursales donde el servicio no se ofrece. Asigna primero la sucursal al servicio.',
          },
        ]);
      }
      const current = before.service_resources.map((r) => r.resource_id);
      const removed = current.filter((r) => !wanted.includes(r));
      const added = wanted.filter((r) => !current.includes(r));
      if (removed.length > 0)
        await tx.service_resources.deleteMany({
          where: { service_id: id, resource_id: { in: removed } },
        });
      if (added.length > 0) {
        await tx.service_resources.createMany({
          data: added.map((resource_id) => ({
            tenant_id: this.tdb.tenantId,
            service_id: id,
            resource_id,
          })),
        });
      }
      const after = await tx.services.findFirstOrThrow({ where: { id }, include });
      await this.audit.record(tx, {
        action: 'service.resources_updated',
        entityType: 'service',
        entityId: id,
        before: asJson({ resourceIds: toView(before).resourceIds }),
        after: asJson({ resourceIds: toView(after).resourceIds }),
      });
      return toView(after);
    });
  }
}

const idParam = new ZodPipe(uuid);

@Controller('services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @ApiDoc({
    summary: 'Listar servicios',
    description:
      'Filtros: `q`, `isActive`, `categoryId`, `locationId`. Incluye las sucursales y recursos vinculados.',
    response: pageOf(serviceView),
  })
  @RequirePermissions('services:read')
  @Get()
  list(@Query(new ZodPipe(serviceListQuery)) q: ServiceListQuery) {
    return this.services.list(q);
  }

  @ApiDoc({
    summary: 'Ver un servicio',
    response: serviceView,
    errors: { 404: 'Servicio no encontrado' },
  })
  @RequirePermissions('services:read')
  @Get(':id')
  get(@Param('id', idParam) id: string) {
    return this.services.get(id);
  }

  @ApiDoc({
    summary: 'Crear un servicio',
    description:
      'El precio es un texto decimal ("12990" o "12990.50"). La moneda la fija el servidor (la de la empresa). Las sucursales y recursos se asignan después.',
    response: serviceView,
    errors: { 409: 'Nombre duplicado (DUPLICATE)' },
  })
  @RequirePermissions('services:write')
  @Post()
  create(@Body(new ZodPipe(createServiceRequest)) body: CreateServiceRequest) {
    return this.services.create(body);
  }

  @ApiDoc({
    summary: 'Editar o (des)activar un servicio',
    response: serviceView,
    errors: { 404: 'Servicio no encontrado', 409: 'Nombre duplicado (DUPLICATE)' },
  })
  @RequirePermissions('services:write')
  @Patch(':id')
  update(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateServiceRequest)) body: UpdateServiceRequest,
  ) {
    return this.services.update(id, body);
  }

  @ApiDoc({
    summary: 'Eliminar un servicio',
    description: 'Solo si no tiene reservas; si no, desactívalo.',
    response: null,
    errors: { 404: 'Servicio no encontrado', 409: 'Está en uso (IN_USE)' },
  })
  @RequirePermissions('services:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', idParam) id: string): Promise<void> {
    await this.services.remove(id);
  }

  @ApiDoc({
    summary: 'Definir las sucursales donde se ofrece el servicio',
    description:
      'Reemplaza el conjunto. Los recursos vinculados en sucursales que se quitan se desvinculan automáticamente.',
    response: serviceView,
    errors: { 404: 'Servicio no encontrado' },
  })
  @RequirePermissions('services:write')
  @Put(':id/locations')
  setLocations(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(setServiceLocationsRequest)) body: SetServiceLocationsRequest,
  ) {
    return this.services.setLocations(id, body);
  }

  @ApiDoc({
    summary: 'Definir los recursos que pueden prestar el servicio',
    description:
      'Reemplaza el conjunto. Cada recurso debe estar en una sucursal donde el servicio se ofrece.',
    response: serviceView,
    errors: { 404: 'Servicio no encontrado' },
  })
  @RequirePermissions('services:write')
  @Put(':id/resources')
  setResources(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(setServiceResourcesRequest)) body: SetServiceResourcesRequest,
  ) {
    return this.services.setResources(id, body);
  }
}

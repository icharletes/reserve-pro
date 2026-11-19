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
  type CreateResourceRequest,
  type ResourceListQuery,
  type ResourceView,
  type UpdateResourceRequest,
  createResourceRequest,
  pageOf,
  resourceListQuery,
  resourceView,
  updateResourceRequest,
  uuid,
} from '@reservepro/contracts';
import type { Prisma, Tx } from '@reservepro/database';
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
  location_id: string;
  kind: string;
  name: string;
  capacity: number;
  membership_id: string | null;
  is_bookable_online: boolean;
  auto_assignable: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: Date;
};

export const toResourceView = (r: Row): ResourceView => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind as ResourceView['kind'],
  name: r.name,
  capacity: r.capacity,
  membershipId: r.membership_id,
  isBookableOnline: r.is_bookable_online,
  autoAssignable: r.auto_assignable,
  isActive: r.is_active,
  sortOrder: r.sort_order,
  createdAt: iso(r.created_at),
});

const asJson = (v: unknown) => v as Prisma.InputJsonValue;

@Injectable()
export class ResourcesService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: ResourceListQuery): Promise<Page<ResourceView>> {
    const after = decodeCursor(q.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.resources.findMany({
        where: {
          ...nameAndStatus(q),
          ...(q.locationId ? { location_id: q.locationId } : {}),
          ...(q.kind ? { kind: q.kind } : {}),
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      }),
    );
    const page = toPage(rows, q.limit, (r) => r.id);
    return { items: page.items.map(toResourceView), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<ResourceView> {
    const row = await this.tdb.runAsPrincipal((tx) => tx.resources.findFirst({ where: { id } }));
    if (!row) throw Errors.notFound('Recurso');
    return toResourceView(row);
  }

  /** El usuario vinculado debe ser un miembro ACTIVO de esta empresa (RLS ya limita la búsqueda a ella). */
  private async assertMembership(tx: Tx, membershipId: string | null | undefined): Promise<void> {
    if (!membershipId) return;
    const m = await tx.tenant_memberships.findFirst({
      where: { id: membershipId, status: 'active' },
      select: { id: true },
    });
    if (!m)
      throw Errors.validation([
        { path: 'membershipId', message: 'El miembro no existe o está desactivado' },
      ]);
  }

  async create(dto: CreateResourceRequest): Promise<ResourceView> {
    if (dto.membershipId && dto.kind !== 'staff') {
      throw Errors.validation([
        { path: 'membershipId', message: 'Solo el personal (staff) puede vincularse a un usuario' },
      ]);
    }
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const location = await tx.locations.findFirst({ where: { id: dto.locationId } });
          if (!location)
            throw Errors.validation([{ path: 'locationId', message: 'La sucursal no existe' }]);
          if (!location.is_active)
            throw Errors.validation([
              { path: 'locationId', message: 'La sucursal está desactivada' },
            ]);
          await this.assertMembership(tx, dto.membershipId);
          const row = await tx.resources.create({
            data: {
              id: uuidv7(),
              tenant_id: this.tdb.tenantId,
              location_id: dto.locationId,
              kind: dto.kind,
              name: dto.name,
              capacity: dto.capacity,
              membership_id: dto.membershipId ?? null,
              is_bookable_online: dto.isBookableOnline,
              auto_assignable: dto.autoAssignable,
              sort_order: dto.sortOrder,
            },
          });
          await this.audit.record(tx, {
            action: 'resource.created',
            entityType: 'resource',
            entityId: row.id,
            after: asJson(toResourceView(row)),
          });
          return toResourceView(row);
        }),
      {
        duplicateMessage: 'Ya existe un recurso con ese nombre en la sucursal',
        duplicateField: 'name',
      },
    );
  }

  async update(id: string, dto: UpdateResourceRequest): Promise<ResourceView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const before = await tx.resources.findFirst({ where: { id } });
          if (!before) throw Errors.notFound('Recurso');
          if (dto.membershipId && before.kind !== 'staff') {
            throw Errors.validation([
              {
                path: 'membershipId',
                message: 'Solo el personal (staff) puede vincularse a un usuario',
              },
            ]);
          }
          await this.assertMembership(tx, dto.membershipId);
          const after = await tx.resources.update({
            where: { id },
            data: {
              ...(dto.name !== undefined ? { name: dto.name } : {}),
              ...(dto.membershipId !== undefined ? { membership_id: dto.membershipId } : {}),
              ...(dto.isBookableOnline !== undefined
                ? { is_bookable_online: dto.isBookableOnline }
                : {}),
              ...(dto.autoAssignable !== undefined ? { auto_assignable: dto.autoAssignable } : {}),
              ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
              ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
            },
          });
          await this.audit.record(tx, {
            action: 'resource.updated',
            entityType: 'resource',
            entityId: id,
            before: asJson(toResourceView(before)),
            after: asJson(toResourceView(after)),
          });
          return toResourceView(after);
        }),
      {
        duplicateMessage:
          'Ya existe un recurso con ese nombre en la sucursal, o el usuario ya está vinculado a otro recurso',
        duplicateField: 'name',
      },
    );
  }

  /** Borra el recurso y su configuración (horarios, excepciones, bloqueos, vínculos). Con reservas (Fase 3) falla con IN_USE. */
  async remove(id: string): Promise<void> {
    await guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const row = await tx.resources.findFirst({ where: { id } });
          if (!row) throw Errors.notFound('Recurso');
          await tx.service_resources.deleteMany({ where: { resource_id: id } });
          await tx.resource_schedules.deleteMany({ where: { resource_id: id } });
          await tx.schedule_overrides.deleteMany({ where: { resource_id: id } });
          await tx.availability_blocks.deleteMany({ where: { resource_id: id } });
          await tx.resources.delete({ where: { id } });
          await this.audit.record(tx, {
            action: 'resource.deleted',
            entityType: 'resource',
            entityId: id,
            before: { name: row.name },
          });
        }),
      {
        op: 'delete',
        inUseMessage: 'No se puede eliminar: el recurso tiene reservas. Desactívalo en su lugar.',
      },
    );
  }
}

const idParam = new ZodPipe(uuid);

@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @ApiDoc({
    summary: 'Listar profesionales y recursos',
    description: 'Filtros: `q`, `isActive`, `locationId`, `kind`.',
    response: pageOf(resourceView),
  })
  @RequirePermissions('resources:read')
  @Get()
  list(@Query(new ZodPipe(resourceListQuery)) q: ResourceListQuery) {
    return this.resources.list(q);
  }

  @ApiDoc({
    summary: 'Ver un recurso',
    response: resourceView,
    errors: { 404: 'Recurso no encontrado' },
  })
  @RequirePermissions('resources:read')
  @Get(':id')
  get(@Param('id', idParam) id: string) {
    return this.resources.get(id);
  }

  @ApiDoc({
    summary: 'Crear un profesional o recurso',
    description:
      'La capacidad es 1 en el MVP (ADR-006). `membershipId` solo para kind=staff: vincula al profesional con su usuario.',
    response: resourceView,
    errors: { 409: 'Nombre duplicado en la sucursal, o usuario ya vinculado (DUPLICATE)' },
  })
  @RequirePermissions('resources:write')
  @Post()
  create(@Body(new ZodPipe(createResourceRequest)) body: CreateResourceRequest) {
    return this.resources.create(body);
  }

  @ApiDoc({
    summary: 'Editar o (des)activar un recurso',
    description: 'La sucursal y el tipo no se pueden cambiar: se crea otro recurso.',
    response: resourceView,
    errors: { 404: 'Recurso no encontrado', 409: 'Nombre duplicado (DUPLICATE)' },
  })
  @RequirePermissions('resources:write')
  @Patch(':id')
  update(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateResourceRequest)) body: UpdateResourceRequest,
  ) {
    return this.resources.update(id, body);
  }

  @ApiDoc({
    summary: 'Eliminar un recurso',
    description:
      'Elimina también sus horarios, excepciones, bloqueos y vínculos. Con reservas, desactívalo.',
    response: null,
    errors: { 404: 'Recurso no encontrado', 409: 'Está en uso (IN_USE)' },
  })
  @RequirePermissions('resources:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', idParam) id: string): Promise<void> {
    await this.resources.remove(id);
  }
}

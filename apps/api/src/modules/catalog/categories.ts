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
  type CatalogListQuery,
  type CategoryView,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
  catalogListQuery,
  categoryView,
  createCategoryRequest,
  pageOf,
  updateCategoryRequest,
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
import { guarded } from './catalog.helpers.js';

const toView = (c: { id: string; name: string; sort_order: number }): CategoryView => ({
  id: c.id,
  name: c.name,
  sortOrder: c.sort_order,
});

@Injectable()
export class CategoriesService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: CatalogListQuery): Promise<Page<CategoryView>> {
    const after = decodeCursor(q.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.service_categories.findMany({
        where: {
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      }),
    );
    const page = toPage(rows, q.limit, (r) => r.id);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async create(dto: CreateCategoryRequest): Promise<CategoryView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const row = await tx.service_categories.create({
            data: {
              id: uuidv7(),
              tenant_id: this.tdb.tenantId,
              name: dto.name,
              sort_order: dto.sortOrder,
            },
          });
          await this.audit.record(tx, {
            action: 'service_category.created',
            entityType: 'service_category',
            entityId: row.id,
            after: toView(row),
          });
          return toView(row);
        }),
      { duplicateMessage: 'Ya existe una categoría con ese nombre' },
    );
  }

  async update(id: string, dto: UpdateCategoryRequest): Promise<CategoryView> {
    return guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const before = await tx.service_categories.findFirst({ where: { id } });
          if (!before) throw Errors.notFound('Categoría');
          const after = await tx.service_categories.update({
            where: { id },
            data: {
              ...(dto.name !== undefined ? { name: dto.name } : {}),
              ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
            },
          });
          await this.audit.record(tx, {
            action: 'service_category.updated',
            entityType: 'service_category',
            entityId: id,
            before: toView(before) as unknown as Prisma.InputJsonValue,
            after: toView(after) as unknown as Prisma.InputJsonValue,
          });
          return toView(after);
        }),
      { duplicateMessage: 'Ya existe una categoría con ese nombre' },
    );
  }

  async remove(id: string): Promise<void> {
    await guarded(
      () =>
        this.tdb.runAsPrincipal(async (tx) => {
          const row = await tx.service_categories.findFirst({ where: { id } });
          if (!row) throw Errors.notFound('Categoría');
          await tx.service_categories.delete({ where: { id } });
          await this.audit.record(tx, {
            action: 'service_category.deleted',
            entityType: 'service_category',
            entityId: id,
            before: { name: row.name },
          });
        }),
      { op: 'delete', inUseMessage: 'No se puede eliminar: hay servicios en esta categoría.' },
    );
  }
}

const idParam = new ZodPipe(uuid);

@Controller('service-categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @ApiDoc({ summary: 'Listar categorías de servicios', response: pageOf(categoryView) })
  @RequirePermissions('services:read')
  @Get()
  list(@Query(new ZodPipe(catalogListQuery)) q: CatalogListQuery) {
    return this.categories.list(q);
  }

  @ApiDoc({
    summary: 'Crear una categoría',
    response: categoryView,
    errors: { 409: 'Nombre duplicado (DUPLICATE)' },
  })
  @RequirePermissions('services:write')
  @Post()
  create(@Body(new ZodPipe(createCategoryRequest)) body: CreateCategoryRequest) {
    return this.categories.create(body);
  }

  @ApiDoc({
    summary: 'Editar una categoría',
    response: categoryView,
    errors: { 404: 'Categoría no encontrada', 409: 'Nombre duplicado (DUPLICATE)' },
  })
  @RequirePermissions('services:write')
  @Patch(':id')
  update(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateCategoryRequest)) body: UpdateCategoryRequest,
  ) {
    return this.categories.update(id, body);
  }

  @ApiDoc({
    summary: 'Eliminar una categoría',
    description: 'Solo si no tiene servicios.',
    response: null,
    errors: { 404: 'Categoría no encontrada', 409: 'Está en uso (IN_USE)' },
  })
  @RequirePermissions('services:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', idParam) id: string): Promise<void> {
    await this.categories.remove(id);
  }
}

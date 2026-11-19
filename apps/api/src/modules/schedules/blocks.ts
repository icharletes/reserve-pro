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
  type BlockListQuery,
  type BlockView,
  type CreateBlocksRequest,
  type UpdateBlockRequest,
  blockListQuery,
  blockView,
  createBlocksRequest,
  pageOf,
  updateBlockRequest,
  uuid,
} from '@reservepro/contracts';
import type { Prisma, Tx } from '@reservepro/database';
import { z } from 'zod';
import { Errors } from '../../common/errors.js';
import { lockResources, overlappingReservations } from '../reservations/booking-context.js';
import { uuidv7 } from '../../common/ids.js';
import { type Page, decodeCursor, toPage } from '../../common/pagination.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

type Row = {
  id: string;
  resource_id: string;
  kind: string;
  start_at: Date;
  end_at: Date;
  reason: string | null;
  created_at: Date;
};

const toView = (b: Row): BlockView => ({
  id: b.id,
  resourceId: b.resource_id,
  kind: b.kind as BlockView['kind'],
  startAt: b.start_at.toISOString(),
  endAt: b.end_at.toISOString(),
  reason: b.reason,
  createdAt: b.created_at.toISOString(),
});

const MAX_MS = 366 * 86_400_000;

async function assertFree(tx: Tx, resourceIds: string[], start: Date, end: Date): Promise<void> {
  if ((await overlappingReservations(tx, resourceIds, { start, end })) > 0) {
    throw Errors.hasReservations(
      'Hay reservas en ese horario. Reprográmalas o cancélalas antes de bloquearlo.',
    );
  }
}

/**
 * Bloqueos puntuales de un recurso (ausencias, mantenimiento…).
 * Un bloqueo NO puede pisar reservas activas (409 HAS_RESERVATIONS): se comprueba con el MISMO lock de recurso
 * que usa el motor de reservas (ARCHITECTURE.md §6.2), así que no se cuela una reserva entre medio.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: BlockListQuery): Promise<Page<BlockView>> {
    const after = decodeCursor(q.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.availability_blocks.findMany({
        where: {
          ...(q.resourceId ? { resource_id: q.resourceId } : {}),
          ...(q.locationId ? { resources: { location_id: q.locationId } } : {}),
          // se solapa con [from, to): empieza antes de `to` y termina después de `from`
          ...(q.to ? { start_at: { lt: new Date(q.to) } } : {}),
          ...(q.from ? { end_at: { gt: new Date(q.from) } } : {}),
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      }),
    );
    const page = toPage(rows, q.limit, (r) => r.id);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  /** Crea el mismo bloqueo en uno o varios recursos, de forma atómica (todo o nada). */
  async create(dto: CreateBlocksRequest): Promise<BlockView[]> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const ids = [...new Set(dto.resourceIds)];
      const found = await tx.resources.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      if (found.length !== ids.length)
        throw Errors.validation([
          { path: 'resourceIds', message: 'Uno o más recursos no existen' },
        ]);
      await lockResources(tx, ids);
      await assertFree(tx, ids, new Date(dto.startAt), new Date(dto.endAt));

      const membershipId = this.tdb.membershipId; // created_by es informativo (sin FK)
      const created = await Promise.all(
        ids.map((resource_id) =>
          tx.availability_blocks.create({
            data: {
              id: uuidv7(),
              tenant_id: this.tdb.tenantId,
              resource_id,
              kind: dto.kind,
              start_at: new Date(dto.startAt),
              end_at: new Date(dto.endAt),
              reason: dto.reason ?? null,
              created_by: membershipId,
            },
          }),
        ),
      );
      const views = created.map(toView);
      await this.audit.record(tx, {
        action: 'block.created',
        entityType: 'availability_block',
        after: {
          ids: views.map((v) => v.id),
          resourceIds: ids,
          kind: dto.kind,
          startAt: dto.startAt,
          endAt: dto.endAt,
        } as Prisma.InputJsonValue,
      });
      return views;
    });
  }

  async update(id: string, dto: UpdateBlockRequest): Promise<BlockView> {
    return this.tdb.runAsPrincipal(async (tx) => {
      const before = await tx.availability_blocks.findFirst({ where: { id } });
      if (!before) throw Errors.notFound('Bloqueo');
      const start = dto.startAt ? new Date(dto.startAt) : before.start_at;
      const end = dto.endAt ? new Date(dto.endAt) : before.end_at;
      const ms = end.getTime() - start.getTime();
      // El esquema solo puede validar el rango si vienen AMBAS fechas; aquí se comprueba con la fila existente.
      if (ms <= 0 || ms > MAX_MS) {
        throw Errors.validation([
          { path: 'endAt', message: 'El fin debe ser posterior al inicio y no superar 366 días' },
        ]);
      }
      await lockResources(tx, [before.resource_id]);
      await assertFree(tx, [before.resource_id], start, end);
      const after = await tx.availability_blocks.update({
        where: { id },
        data: {
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.startAt !== undefined ? { start_at: start } : {}),
          ...(dto.endAt !== undefined ? { end_at: end } : {}),
          ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'block.updated',
        entityType: 'availability_block',
        entityId: id,
        before: toView(before) as unknown as Prisma.InputJsonValue,
        after: toView(after) as unknown as Prisma.InputJsonValue,
      });
      return toView(after);
    });
  }

  async remove(id: string): Promise<void> {
    await this.tdb.runAsPrincipal(async (tx) => {
      const row = await tx.availability_blocks.findFirst({ where: { id } });
      if (!row) throw Errors.notFound('Bloqueo');
      await tx.availability_blocks.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'block.deleted',
        entityType: 'availability_block',
        entityId: id,
        before: toView(row) as unknown as Prisma.InputJsonValue,
      });
    });
  }
}

const idParam = new ZodPipe(uuid);

@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @ApiDoc({
    summary: 'Listar bloqueos',
    description:
      'Filtros: `resourceId`, `locationId` y rango `from`/`to` (los que se solapan con él).',
    response: pageOf(blockView),
  })
  @RequirePermissions('blocks:read')
  @Get()
  list(@Query(new ZodPipe(blockListQuery)) q: BlockListQuery) {
    return this.blocks.list(q);
  }

  @ApiDoc({
    summary: 'Bloquear uno o varios recursos',
    description:
      'Crea el mismo bloqueo (ausencia, mantenimiento…) en cada recurso indicado, de forma atómica. Fechas en ISO 8601 con zona.',
    response: z.array(blockView),
    errors: { 400: 'Recursos inexistentes o rango inválido' },
  })
  @RequirePermissions('blocks:write')
  @Post()
  create(@Body(new ZodPipe(createBlocksRequest)) body: CreateBlocksRequest) {
    return this.blocks.create(body);
  }

  @ApiDoc({
    summary: 'Editar un bloqueo',
    response: blockView,
    errors: { 404: 'Bloqueo no encontrado' },
  })
  @RequirePermissions('blocks:write')
  @Patch(':id')
  update(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateBlockRequest)) body: UpdateBlockRequest,
  ) {
    return this.blocks.update(id, body);
  }

  @ApiDoc({
    summary: 'Eliminar un bloqueo',
    response: null,
    errors: { 404: 'Bloqueo no encontrado' },
  })
  @RequirePermissions('blocks:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', idParam) id: string): Promise<void> {
    await this.blocks.remove(id);
  }
}

import { Body, Controller, Get, Injectable, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateCustomerRequest,
  type CustomerListQuery,
  type CustomerView,
  type UpdateCustomerRequest,
  createCustomerRequest,
  customerListQuery,
  customerView,
  pageOf,
  updateCustomerRequest,
  uuid,
} from '@reservepro/contracts';
import type { Prisma, Tx } from '@reservepro/database';
import { AppError, Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import { type Page, decodeCursor, toPage } from '../../common/pagination.js';
import { isUniqueViolation } from '../../common/pg-errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

type Row = {
  id: string;
  first_name: string;
  last_name: string | null;
  phone_e164: string | null;
  email: string | null;
  internal_notes: string | null;
  created_at: Date;
};

export const toCustomerView = (c: Row): CustomerView => ({
  id: c.id,
  firstName: c.first_name,
  lastName: c.last_name,
  phoneE164: c.phone_e164,
  email: c.email,
  internalNotes: c.internal_notes,
  createdAt: c.created_at.toISOString(),
});

const phoneTaken = () => Errors.duplicate('phoneE164', 'Ya existe un cliente con ese teléfono');

/**
 * Busca un cliente por teléfono (el teléfono identifica al cliente dentro de la empresa) o lo crea.
 * Si ya existe NO se sobrescriben sus datos: quien reserva no puede cambiar la ficha de otro cliente.
 */
export async function findOrCreateCustomer(
  tx: Tx,
  tenantId: string,
  dto: CreateCustomerRequest,
): Promise<{ id: string; created: boolean }> {
  if (dto.phoneE164) {
    const existing = await tx.customers.findFirst({
      where: { phone_e164: dto.phoneE164, anonymized_at: null },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
  }
  const id = uuidv7();
  await tx.customers.create({
    data: {
      id,
      tenant_id: tenantId,
      first_name: dto.firstName,
      last_name: dto.lastName ?? null,
      phone_e164: dto.phoneE164 ?? null,
      email: dto.email ?? null,
      internal_notes: dto.internalNotes ?? null,
    },
  });
  return { id, created: true };
}

/** Clientes de la empresa. Ver ADR-014. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(q: CustomerListQuery): Promise<Page<CustomerView>> {
    const after = decodeCursor(q.cursor);
    const term = q.q;
    const digits = term?.replace(/[^\d+]/g, '') ?? '';
    const search: Prisma.customersWhereInput = term
      ? {
          OR: [
            { first_name: { contains: term, mode: 'insensitive' } },
            { last_name: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
            ...(digits.length >= 3 ? [{ phone_e164: { contains: digits } }] : []),
          ],
        }
      : {};
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.customers.findMany({
        where: { anonymized_at: null, ...search, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
      }),
    );
    const page = toPage(rows, q.limit, (r) => r.id);
    return { items: page.items.map(toCustomerView), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<CustomerView> {
    const row = await this.tdb.runAsPrincipal((tx) =>
      tx.customers.findFirst({ where: { id, anonymized_at: null } }),
    );
    if (!row) throw Errors.notFound('Cliente');
    return toCustomerView(row);
  }

  async create(dto: CreateCustomerRequest): Promise<CustomerView> {
    try {
      return await this.tdb.runAsPrincipal(async (tx) => {
        const id = uuidv7();
        const row = await tx.customers.create({
          data: {
            id,
            tenant_id: this.tdb.tenantId,
            first_name: dto.firstName,
            last_name: dto.lastName ?? null,
            phone_e164: dto.phoneE164 ?? null,
            email: dto.email ?? null,
            internal_notes: dto.internalNotes ?? null,
          },
        });
        // Auditoría sin datos personales: solo qué pasó y sobre qué id.
        await this.audit.record(tx, {
          action: 'customer.created',
          entityType: 'customer',
          entityId: id,
        });
        return toCustomerView(row);
      });
    } catch (e) {
      throw isPhoneConflict(e) ? phoneTaken() : e;
    }
  }

  async update(id: string, dto: UpdateCustomerRequest): Promise<CustomerView> {
    try {
      return await this.tdb.runAsPrincipal(async (tx) => {
        const before = await tx.customers.findFirst({ where: { id, anonymized_at: null } });
        if (!before) throw Errors.notFound('Cliente');
        const phone = dto.phoneE164 !== undefined ? dto.phoneE164 : before.phone_e164;
        const email = dto.email !== undefined ? dto.email : before.email;
        if (!phone && !email) {
          throw Errors.validation([
            { path: 'phoneE164', message: 'Indica al menos un teléfono o un email' },
          ]);
        }
        const row = await tx.customers.update({
          where: { id },
          data: {
            ...(dto.firstName !== undefined ? { first_name: dto.firstName } : {}),
            ...(dto.lastName !== undefined ? { last_name: dto.lastName } : {}),
            ...(dto.phoneE164 !== undefined ? { phone_e164: dto.phoneE164 } : {}),
            ...(dto.email !== undefined ? { email: dto.email } : {}),
            ...(dto.internalNotes !== undefined ? { internal_notes: dto.internalNotes } : {}),
          },
        });
        await this.audit.record(tx, {
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          after: { fields: Object.keys(dto) } as Prisma.InputJsonValue,
        });
        return toCustomerView(row);
      });
    } catch (e) {
      throw isPhoneConflict(e) ? phoneTaken() : e;
    }
  }
}

function isPhoneConflict(e: unknown): boolean {
  return !(e instanceof AppError) && isUniqueViolation(e);
}

const idParam = new ZodPipe(uuid);

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @ApiDoc({
    summary: 'Listar clientes',
    description: '`q` busca por nombre, apellido, email o teléfono.',
    response: pageOf(customerView),
  })
  @RequirePermissions('customers:read')
  @Get()
  list(@Query(new ZodPipe(customerListQuery)) q: CustomerListQuery) {
    return this.customers.list(q);
  }

  @ApiDoc({
    summary: 'Ver un cliente',
    response: customerView,
    errors: { 404: 'Cliente no encontrado' },
  })
  @RequirePermissions('customers:read')
  @Get(':id')
  get(@Param('id', idParam) id: string) {
    return this.customers.get(id);
  }

  @ApiDoc({
    summary: 'Crear un cliente',
    description: 'Requiere teléfono (E.164) o email. El teléfono es único por empresa.',
    response: customerView,
    errors: { 409: 'Ya existe un cliente con ese teléfono' },
  })
  @RequirePermissions('customers:write')
  @Post()
  create(@Body(new ZodPipe(createCustomerRequest)) body: CreateCustomerRequest) {
    return this.customers.create(body);
  }

  @ApiDoc({
    summary: 'Editar un cliente',
    response: customerView,
    errors: { 404: 'Cliente no encontrado', 409: 'Ya existe un cliente con ese teléfono' },
  })
  @RequirePermissions('customers:write')
  @Patch(':id')
  update(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateCustomerRequest)) body: UpdateCustomerRequest,
  ) {
    return this.customers.update(id, body);
  }
}

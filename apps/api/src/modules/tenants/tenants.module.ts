import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import {
  type TenantView,
  type UpdateTenantRequest,
  tenantView,
  updateTenantRequest,
} from '@reservepro/contracts';
import type { Prisma } from '@reservepro/database';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

const tenantSelect = {
  id: true,
  name: true,
  legal_name: true,
  tax_id: true,
  slug: true,
  status: true,
  timezone: true,
  currency: true,
  created_at: true,
} as const;

type TenantRow = {
  id: string;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  slug: string;
  status: string;
  timezone: string;
  currency: string;
  created_at: Date;
};

/** Traduce la fila de BD (snake_case) al contrato público (camelCase). */
const toView = (t: TenantRow): TenantView => ({
  id: t.id,
  name: t.name,
  legalName: t.legal_name,
  taxId: t.tax_id,
  slug: t.slug,
  status: t.status as TenantView['status'],
  timezone: t.timezone,
  currency: t.currency,
  createdAt: t.created_at.toISOString(),
});

@Injectable()
export class TenantsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** La empresa activa del principal. RLS garantiza que solo pueda ser la suya. */
  async getCurrent() {
    return this.tdb.runAsPrincipal(async (tx) => {
      const tenant = await tx.tenants.findFirst({ select: tenantSelect });
      if (!tenant) throw Errors.notFound('Empresa');
      return toView(tenant);
    });
  }

  async updateCurrent(dto: UpdateTenantRequest) {
    return this.tdb.runAsPrincipal(async (tx) => {
      const before = await tx.tenants.findFirst({ select: tenantSelect });
      if (!before) throw Errors.notFound('Empresa');

      const after = await tx.tenants.update({
        where: { id: before.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.legalName !== undefined ? { legal_name: dto.legalName } : {}),
          ...(dto.taxId !== undefined ? { tax_id: dto.taxId } : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
          ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        },
        select: tenantSelect,
      });

      await this.audit.record(tx, {
        action: 'tenant.updated',
        entityType: 'tenant',
        entityId: before.id,
        before: toView(before) as unknown as Prisma.InputJsonValue,
        after: toView(after) as unknown as Prisma.InputJsonValue,
      });
      return toView(after);
    });
  }
}

@Controller('tenants/current')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @ApiDoc({ summary: 'Datos de la empresa activa', response: tenantView })
  @RequirePermissions('tenant:read')
  @Get()
  get() {
    return this.tenants.getCurrent();
  }

  @ApiDoc({
    summary: 'Editar la empresa activa',
    description: 'Actualización parcial. Queda auditada con el antes y el después.',
    response: tenantView,
  })
  @RequirePermissions('tenant:update')
  @Patch()
  update(@Body(new ZodPipe(updateTenantRequest)) body: UpdateTenantRequest) {
    return this.tenants.updateCurrent(body);
  }
}

@Module({ controllers: [TenantsController], providers: [TenantsService] })
export class TenantsModule {}

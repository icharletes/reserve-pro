import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { type UpdateTenantRequest, updateTenantRequest } from '@reservepro/contracts';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { RequirePermissions } from '../../platform/rbac/authz.decorators.js';

const tenantView = {
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

@Injectable()
export class TenantsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** La empresa activa del principal. RLS garantiza que solo pueda ser la suya. */
  async getCurrent() {
    return this.tdb.runAsPrincipal(async (tx) => {
      const tenant = await tx.tenants.findFirst({ select: tenantView });
      if (!tenant) throw Errors.notFound('Empresa');
      return tenant;
    });
  }

  async updateCurrent(dto: UpdateTenantRequest) {
    return this.tdb.runAsPrincipal(async (tx) => {
      const before = await tx.tenants.findFirst({ select: tenantView });
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
        select: tenantView,
      });

      await this.audit.record(tx, {
        action: 'tenant.updated',
        entityType: 'tenant',
        entityId: before.id,
        before: JSON.parse(JSON.stringify(before)),
        after: JSON.parse(JSON.stringify(after)),
      });
      return after;
    });
  }
}

@Controller('tenants/current')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @RequirePermissions('tenant:read')
  @Get()
  get() {
    return this.tenants.getCurrent();
  }

  @RequirePermissions('tenant:update')
  @Patch()
  update(@Body(new ZodPipe(updateTenantRequest)) body: UpdateTenantRequest) {
    return this.tenants.updateCurrent(body);
  }
}

@Module({ controllers: [TenantsController], providers: [TenantsService] })
export class TenantsModule {}

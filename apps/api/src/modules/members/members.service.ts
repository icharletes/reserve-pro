import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { MemberView, RoleView, UpdateMemberRequest } from '@reservepro/contracts';
import type { Tx } from '@reservepro/database';
import { Errors } from '../../common/errors.js';
import { type Page, type PageQuery, decodeCursor, toPage } from '../../common/pagination.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import type { TenantPrincipal } from '../../platform/auth/principal.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { canHold, permissionsOfRoles } from './privileges.js';

const memberInclude = {
  users: { select: { id: true, email: true, full_name: true } },
  membership_roles: { include: { roles: { select: { id: true, key: true, name: true } } } },
} as const;

type MemberRow = {
  id: string;
  user_id: string;
  status: string;
  created_at: Date;
  users: { id: string; email: string; full_name: string };
  membership_roles: { roles: { id: string; key: string; name: string } }[];
};

const toView = (m: MemberRow): MemberView => ({
  membershipId: m.id,
  userId: m.user_id,
  email: m.users.email,
  fullName: m.users.full_name,
  status: m.status as MemberView['status'],
  roles: m.membership_roles.map((r) => ({ key: r.roles.key, name: r.roles.name })).sort((a, b) => a.key.localeCompare(b.key)),
  createdAt: m.created_at.toISOString(),
});

@Injectable()
export class MembersService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
  ) {}

  private actor(): TenantPrincipal {
    const p = this.cls.get('principal');
    if (!p?.tenantId || !p.membershipId) throw Errors.tenantRequired();
    return p as TenantPrincipal;
  }

  async list(query: PageQuery): Promise<Page<MemberView>> {
    const after = decodeCursor(query.cursor);
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.tenant_memberships.findMany({
        where: after ? { id: { gt: after } } : {},
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        include: memberInclude,
      }),
    );
    const page = toPage(rows, query.limit, (r) => r.id);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  async listRoles(): Promise<RoleView[]> {
    const roles = await this.tdb.runAsPrincipal((tx) =>
      tx.roles.findMany({ include: { role_permissions: true }, orderBy: { key: 'asc' } }),
    );
    return roles.map((r) => ({
      key: r.key,
      name: r.name,
      isSystem: r.is_system,
      permissions: r.role_permissions.map((p) => p.permission_key).sort(),
    }));
  }

  /**
   * Cambia estado y/o roles de un miembro. Garantías, todas dentro de UNA transacción:
   *  - no se puede modificar a uno mismo (evita auto-bloqueos y auto-escaladas);
   *  - anti-escalada: ni se otorgan roles ni se gestionan miembros con permisos superiores a los del actor;
   *  - la empresa nunca se queda sin propietario activo, ni siquiera con operaciones simultáneas.
   */
  async update(membershipId: string, dto: UpdateMemberRequest): Promise<MemberView> {
    const actor = this.actor();
    if (membershipId === actor.membershipId) throw Errors.cannotModifySelf();

    return this.tdb.runAsPrincipal(async (tx) => {
      // Serializa a los propietarios activos (orden fijo por id => sin deadlocks) antes de decidir nada.
      await this.lockActiveOwners(tx);

      const target = await tx.tenant_memberships.findFirst({ where: { id: membershipId }, include: memberInclude });
      if (!target) throw Errors.notFound('Miembro');

      const currentRoleIds = target.membership_roles.map((r) => r.roles.id);
      const currentPerms = await permissionsOfRoles(tx, currentRoleIds);
      if (!canHold(actor.permissions, currentPerms)) throw Errors.roleNotAllowed();

      let newRoleIds = currentRoleIds;
      if (dto.roleKeys) {
        const keys = [...new Set(dto.roleKeys)];
        const roles = await tx.roles.findMany({ where: { key: { in: keys } } });
        if (roles.length !== keys.length) {
          throw Errors.validation([{ path: 'roleKeys', message: 'Uno o más roles no existen en la empresa' }]);
        }
        const perms = await permissionsOfRoles(tx, roles.map((r) => r.id));
        if (!canHold(actor.permissions, perms)) throw Errors.roleNotAllowed();
        newRoleIds = roles.map((r) => r.id);
      }
      const newStatus = dto.status ?? (target.status as 'active' | 'disabled');

      // ¿Dejaría de ser propietario activo?
      const ownerRoleId = (await tx.roles.findFirst({ where: { key: 'owner' }, select: { id: true } }))?.id;
      const wasActiveOwner = target.status === 'active' && !!ownerRoleId && currentRoleIds.includes(ownerRoleId);
      const staysActiveOwner = newStatus === 'active' && !!ownerRoleId && newRoleIds.includes(ownerRoleId);
      if (wasActiveOwner && !staysActiveOwner) {
        const others = await tx.tenant_memberships.count({
          where: {
            id: { not: target.id },
            status: 'active',
            membership_roles: { some: { role_id: ownerRoleId } },
          },
        });
        if (others === 0) throw Errors.lastOwner();
      }

      if (dto.roleKeys) {
        await tx.membership_roles.deleteMany({ where: { membership_id: target.id } });
        await tx.membership_roles.createMany({
          data: newRoleIds.map((role_id) => ({ tenant_id: actor.tenantId, membership_id: target.id, role_id })),
        });
      }
      if (dto.status && dto.status !== target.status) {
        await tx.tenant_memberships.update({ where: { id: target.id }, data: { status: dto.status } });
      }

      const after = await tx.tenant_memberships.findFirstOrThrow({ where: { id: target.id }, include: memberInclude });
      await this.audit.record(tx, {
        action: 'member.updated',
        entityType: 'membership',
        entityId: target.id,
        before: { status: target.status, roles: toView(target).roles.map((r) => r.key) },
        after: { status: after.status, roles: toView(after).roles.map((r) => r.key) },
      });
      return toView(after);
    });
  }

  private async lockActiveOwners(tx: Tx): Promise<void> {
    await tx.$queryRaw`
      SELECT m.id FROM tenant_memberships m
      WHERE m.status = 'active'
        AND EXISTS (SELECT 1 FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                    WHERE mr.membership_id = m.id AND r.key = 'owner')
      ORDER BY m.id
      FOR UPDATE OF m`;
  }
}

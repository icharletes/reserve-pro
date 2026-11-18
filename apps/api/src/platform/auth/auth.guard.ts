import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { Logger } from 'pino';
import { type PermissionKey, isPermissionKey } from '@reservepro/contracts';
import { AppError, Errors } from '../../common/errors.js';
import { TenantDb } from '../database/database.module.js';
import { LOGGER } from '../logging/logger.js';
import { AUTHZ_KEY, type AuthzMeta, VERIFIED_EMAIL_KEY } from '../rbac/authz.decorators.js';
import type { AuthedRequest, Principal } from './principal.js';
import { type AccessClaims, TokenService } from './token.service.js';

/**
 * Autenticación. Reconstruye el Principal desde la BASE DE DATOS en cada request (no confía solo en el
 * token): así desactivar un usuario, una membresía o una empresa, o cerrar sesión, surte efecto de inmediato.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly tdb: TenantDb,
    private readonly cls: ClsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<AuthzMeta | undefined>(AUTHZ_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) {
      // Falla cerrado: un endpoint sin política declarada NUNCA queda accesible.
      const where = `${context.getClass().name}.${context.getHandler().name}`;
      this.logger.error({ where }, 'endpoint sin política de autorización (@Public/@Authenticated/@RequirePermissions)');
      throw Errors.internal('Endpoint sin política de autorización');
    }
    if (meta.kind === 'public') return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match) throw Errors.unauthenticated();

    const claims = await this.tokens.verifyAccess(match[1]!);
    const principal = await this.loadPrincipal(claims);
    req.principal = principal;
    this.cls.set('principal', principal);
    return true;
  }

  private async loadPrincipal(claims: AccessClaims): Promise<Principal> {
    const sessionActive = (tx: { refresh_tokens: { count: (a: object) => Promise<number> } }) =>
      tx.refresh_tokens.count({
        where: { family_id: claims.sid, user_id: claims.sub, revoked_at: null, expires_at: { gt: new Date() } },
      });

    if (!claims.tid || !claims.mid) {
      const [user, active] = await Promise.all([
        this.tdb.global.users.findUnique({ where: { id: claims.sub } }),
        sessionActive(this.tdb.global),
      ]);
      if (!user || user.status !== 'active' || active === 0) throw Errors.tokenInvalid();
      return {
        userId: user.id,
        email: user.email,
        fullName: user.full_name,
        isPlatformAdmin: user.is_platform_admin,
        emailVerified: user.email_verified_at !== null,
        sessionId: claims.sid,
        tenantId: null,
        membershipId: null,
        roles: [],
        permissions: new Set(),
      };
    }

    const { tid, mid } = claims;
    const loaded = await this.tdb.run({ tenantId: tid }, async (tx) => {
      const membership = await tx.tenant_memberships.findFirst({
        where: { id: mid, user_id: claims.sub, tenant_id: tid, status: 'active' },
        include: {
          users: true,
          tenants: { select: { status: true } },
          membership_roles: { include: { roles: { include: { role_permissions: true } } } },
        },
      });
      return { membership, active: await sessionActive(tx) };
    });

    const m = loaded.membership;
    if (!m || loaded.active === 0 || m.users.status !== 'active' || m.tenants.status !== 'active') {
      throw Errors.tokenInvalid();
    }

    const permissions = new Set<PermissionKey>();
    for (const mr of m.membership_roles) {
      for (const rp of mr.roles.role_permissions) {
        if (isPermissionKey(rp.permission_key)) permissions.add(rp.permission_key);
      }
    }
    return {
      userId: m.users.id,
      email: m.users.email,
      fullName: m.users.full_name,
      isPlatformAdmin: m.users.is_platform_admin,
      emailVerified: m.users.email_verified_at !== null,
      sessionId: claims.sid,
      tenantId: tid,
      membershipId: mid,
      roles: m.membership_roles.map((mr) => mr.roles.key).sort(),
      permissions,
    };
  }
}

/** Autorización. Exige empresa activa y TODOS los permisos declarados con @RequirePermissions. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<AuthzMeta | undefined>(AUTHZ_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) throw new AppError(500, 'INTERNAL_ERROR', 'Endpoint sin política de autorización');
    if (meta.kind === 'public') return true;

    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!principal) throw Errors.unauthenticated();
    const needsVerified = this.reflector.getAllAndOverride<boolean | undefined>(VERIFIED_EMAIL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needsVerified && !principal.emailVerified) throw Errors.emailNotVerified();
    if (meta.kind !== 'permissions') return true; // 'authenticated': basta con la sesión
    if (!principal.tenantId) throw Errors.tenantRequired();
    for (const required of meta.permissions) {
      if (!principal.permissions.has(required)) throw Errors.forbidden();
    }
    return true;
  }
}

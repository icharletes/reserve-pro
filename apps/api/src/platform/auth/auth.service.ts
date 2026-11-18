import { Injectable } from '@nestjs/common';
import { Prisma } from '@reservepro/database';
import type {
  AuthResponse,
  LoginRequest,
  MeResponse,
  MembershipSummary,
  RegisterRequest,
} from '@reservepro/contracts';
import { AuditService } from '../audit/audit.module.js';
import { TenantDb } from '../database/database.module.js';
import { ROLE_TEMPLATES } from '../rbac/role-templates.js';
import { uuidv7 } from '../../common/ids.js';
import { Errors } from '../../common/errors.js';
import { slugify, withRandomSuffix } from '../../modules/tenants/slug.js';
import { PasswordService } from './password.service.js';
import { type ClientInfo, SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import type { Principal } from './principal.js';

/** Resultado de un login/registro/refresh: el cuerpo JSON y el refresh token (va en cookie, no en el JSON). */
export interface AuthResult {
  body: AuthResponse;
  refreshToken: string;
}

const MAX_FAILED_BEFORE_LOCK = 5;
const BASE_LOCK_MS = 15 * 60 * 1000;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Registro: crea usuario + empresa + roles + membresía de propietario en UNA transacción
  // ---------------------------------------------------------------------------------------------
  async register(dto: RegisterRequest, client: ClientInfo): Promise<AuthResult> {
    const db = this.tdb.global;
    if (await db.users.findUnique({ where: { email: dto.email }, select: { id: true } })) {
      throw Errors.emailTaken();
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const userId = uuidv7();
    const tenantId = uuidv7();
    const membershipId = uuidv7();

    const base = dto.slug ?? slugify(dto.businessName);
    const candidates = dto.slug ? [base] : [base, ...Array.from({ length: 4 }, () => withRandomSuffix(base))];

    let created = false;
    let slug = base;
    for (const candidate of candidates) {
      if (!(await this.isSlugAvailable(candidate))) {
        if (dto.slug) throw Errors.slugTaken();
        continue;
      }
      slug = candidate;
      try {
        await this.createTenantWithOwner({ ...dto, slug }, { userId, tenantId, membershipId, passwordHash });
        created = true;
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // ¿Colisión de email (carrera con otro registro) o de slug?
        if (await db.users.findUnique({ where: { email: dto.email }, select: { id: true } })) {
          throw Errors.emailTaken();
        }
        if (dto.slug) throw Errors.slugTaken();
      }
    }
    if (!created) throw Errors.slugTaken();

    const session = await this.sessions.start(userId, tenantId, client);
    const memberships = await this.listMemberships(userId);
    return this.buildResult({ id: userId, email: dto.email, fullName: dto.fullName }, memberships, tenantId, session);
  }

  private async isSlugAvailable(slug: string): Promise<boolean> {
    const db = this.tdb.global;
    if (await db.reserved_slugs.findUnique({ where: { slug } })) return false;
    // La resolución por slug es una función SECURITY DEFINER: funciona sin contexto de tenant.
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM rp_resolve_tenant_by_slug(${slug})`;
    return rows.length === 0;
  }

  private async createTenantWithOwner(
    dto: RegisterRequest & { slug: string },
    ids: { userId: string; tenantId: string; membershipId: string; passwordHash: string },
  ): Promise<void> {
    // El contexto es el id de la empresa NUEVA: la política WITH CHECK de RLS lo exige (ADR-004).
    await this.tdb.run({ tenantId: ids.tenantId }, async (tx) => {
      await tx.users.create({
        data: { id: ids.userId, email: dto.email, password_hash: ids.passwordHash, full_name: dto.fullName },
      });
      await tx.tenants.create({
        data: {
          id: ids.tenantId,
          name: dto.businessName,
          slug: dto.slug,
          timezone: dto.timezone,
          currency: dto.currency,
        },
      });
      await tx.tenant_settings.create({ data: { tenant_id: ids.tenantId } });

      // Roles de sistema de ESTA empresa, copiados de las plantillas del código.
      const roleIds = new Map(ROLE_TEMPLATES.map((t) => [t.key, uuidv7()]));
      await tx.roles.createMany({
        data: ROLE_TEMPLATES.map((t) => ({
          id: roleIds.get(t.key)!,
          tenant_id: ids.tenantId,
          key: t.key,
          name: t.name,
          is_system: true,
        })),
      });
      await tx.role_permissions.createMany({
        data: ROLE_TEMPLATES.flatMap((t) =>
          t.permissions.map((p) => ({ tenant_id: ids.tenantId, role_id: roleIds.get(t.key)!, permission_key: p })),
        ),
      });

      await tx.tenant_memberships.create({
        data: { id: ids.membershipId, tenant_id: ids.tenantId, user_id: ids.userId },
      });
      await tx.membership_roles.create({
        data: { tenant_id: ids.tenantId, membership_id: ids.membershipId, role_id: roleIds.get('owner')! },
      });

      await this.audit.record(tx, {
        tenantId: ids.tenantId,
        actorId: ids.userId,
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: ids.tenantId,
        after: { name: dto.businessName, slug: dto.slug },
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------------------------
  async login(dto: LoginRequest, client: ClientInfo): Promise<AuthResult> {
    const db = this.tdb.global;
    const user = await db.users.findUnique({ where: { email: dto.email } });

    if (!user) {
      await this.passwords.verifyDummy(dto.password); // iguala tiempos: no revela si el email existe
      throw Errors.invalidCredentials();
    }
    if (user.locked_until && user.locked_until > new Date()) throw Errors.tooManyAttempts();

    const ok = await this.passwords.verify(user.password_hash, dto.password);
    if (!ok) {
      const updated = await db.users.update({
        where: { id: user.id },
        data: { failed_logins: { increment: 1 } },
        select: { failed_logins: true },
      });
      if (updated.failed_logins >= MAX_FAILED_BEFORE_LOCK) {
        // Bloqueo progresivo: 15 min, 30, 60… (tope 8 h). Cada nuevo fallo tras el bloqueo lo prolonga.
        const level = Math.min(Math.floor(updated.failed_logins / MAX_FAILED_BEFORE_LOCK) - 1, 5);
        await db.users.update({
          where: { id: user.id },
          data: { locked_until: new Date(Date.now() + BASE_LOCK_MS * 2 ** level) },
        });
      }
      throw Errors.invalidCredentials();
    }
    // Cuenta desactivada: misma respuesta genérica que una contraseña incorrecta.
    if (user.status !== 'active') throw Errors.invalidCredentials();

    await db.users.update({
      where: { id: user.id },
      data: {
        failed_logins: 0,
        locked_until: null,
        ...(this.passwords.needsRehash(user.password_hash)
          ? { password_hash: await this.passwords.hash(dto.password) }
          : {}),
      },
    });

    const memberships = await this.listMemberships(user.id);
    let activeTenantId: string | null = null;
    if (dto.tenantId) {
      if (!memberships.some((m) => m.tenantId === dto.tenantId)) throw Errors.forbidden();
      activeTenantId = dto.tenantId;
    } else if (memberships.length === 1) {
      activeTenantId = memberships[0]!.tenantId;
    }

    const session = await this.sessions.start(user.id, activeTenantId, client);
    return this.buildResult(
      { id: user.id, email: user.email, fullName: user.full_name },
      memberships,
      activeTenantId,
      session,
    );
  }

  /** Inicia sesión directamente para un usuario ya verificado por otro medio (p.ej. aceptó una invitación). */
  async startSessionFor(
    user: { id: string; email: string; fullName: string },
    activeTenantId: string,
    client: ClientInfo,
  ): Promise<AuthResult> {
    const memberships = await this.listMemberships(user.id);
    const session = await this.sessions.start(user.id, activeTenantId, client);
    return this.buildResult(user, memberships, activeTenantId, session);
  }

  // ---------------------------------------------------------------------------------------------
  // Refresh / logout / cambio de empresa
  // ---------------------------------------------------------------------------------------------
  async refresh(rawToken: string, client: ClientInfo): Promise<AuthResult> {
    const issued = await this.sessions.rotate(rawToken, client);
    const user = await this.tdb.global.users.findUnique({ where: { id: issued.userId } });
    if (!user || user.status !== 'active') {
      await this.sessions.revokeFamily(issued.sessionId);
      throw Errors.tokenInvalid();
    }

    const memberships = await this.listMemberships(user.id);
    let active = issued.activeTenantId;
    if (active && !memberships.some((m) => m.tenantId === active)) {
      // Perdió el acceso a la empresa activa (membresía desactivada): se reevalúa la elección.
      active = memberships.length === 1 ? memberships[0]!.tenantId : null;
      await this.sessions.setActiveTenant(issued.sessionId, active);
    }
    return this.buildResult({ id: user.id, email: user.email, fullName: user.full_name }, memberships, active, issued);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.sessions.revokeByToken(rawToken);
  }

  async switchTenant(principal: Principal, tenantId: string): Promise<AuthResponse> {
    const memberships = await this.listMemberships(principal.userId);
    const target = memberships.find((m) => m.tenantId === tenantId);
    // Misma respuesta si la empresa no existe o el usuario no pertenece: no revela existencia.
    if (!target) throw Errors.forbidden();

    await this.sessions.setActiveTenant(principal.sessionId, tenantId);
    const accessToken = await this.tokens.signAccess({
      sub: principal.userId,
      sid: principal.sessionId,
      tid: target.tenantId,
      mid: target.membershipId,
    });
    return {
      accessToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user: { id: principal.userId, email: principal.email, fullName: principal.fullName },
      activeTenantId: tenantId,
      memberships,
    };
  }

  async me(principal: Principal): Promise<MeResponse> {
    const tenant = principal.tenantId
      ? await this.tdb.run({ tenantId: principal.tenantId }, (tx) =>
          tx.tenants.findUnique({
            where: { id: principal.tenantId! },
            select: { id: true, name: true, slug: true, timezone: true, currency: true },
          }),
        )
      : null;
    return {
      user: {
        id: principal.userId,
        email: principal.email,
        fullName: principal.fullName,
        isPlatformAdmin: principal.isPlatformAdmin,
      },
      tenant,
      membershipId: principal.membershipId,
      roles: principal.roles,
      permissions: [...principal.permissions].sort(),
    };
  }

  // ---------------------------------------------------------------------------------------------
  private async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.tdb.asUser(userId, (tx) =>
      tx.tenant_memberships.findMany({
        where: { status: 'active' },
        include: { tenants: { select: { id: true, name: true, slug: true, status: true } } },
        orderBy: { created_at: 'asc' },
      }),
    );
    return rows
      .filter((r) => r.tenants.status === 'active')
      .map((r) => ({
        membershipId: r.id,
        tenantId: r.tenant_id,
        tenantName: r.tenants.name,
        tenantSlug: r.tenants.slug,
      }));
  }

  private async buildResult(
    user: { id: string; email: string; fullName: string },
    memberships: MembershipSummary[],
    activeTenantId: string | null,
    session: { token: string; sessionId: string },
  ): Promise<AuthResult> {
    const active = activeTenantId ? memberships.find((m) => m.tenantId === activeTenantId) : undefined;
    const accessToken = await this.tokens.signAccess({
      sub: user.id,
      sid: session.sessionId,
      ...(active ? { tid: active.tenantId, mid: active.membershipId } : {}),
    });
    return {
      refreshToken: session.token,
      body: {
        accessToken,
        expiresIn: this.tokens.accessTtlSeconds,
        user,
        activeTenantId: active?.tenantId ?? null,
        memberships,
      },
    };
  }
}

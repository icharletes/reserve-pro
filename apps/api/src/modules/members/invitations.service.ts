import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Logger } from 'pino';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  InvitationPreview,
  InvitationView,
} from '@reservepro/contracts';
import { Prisma } from '@reservepro/database';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';
import { generateOneTimeToken, hashOneTimeToken } from '../../common/tokens.js';
import { uuidv7 } from '../../common/ids.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { AuthService } from '../../platform/auth/auth.service.js';
import { PasswordService } from '../../platform/auth/password.service.js';
import type { ClientInfo } from '../../platform/auth/session.service.js';
import type { TenantPrincipal } from '../../platform/auth/principal.js';
import { TenantDb } from '../../platform/database/database.module.js';
import { EMAIL_PROVIDER, type EmailProvider } from '../../platform/email/email.module.js';
import { renderInvitationEmail } from '../../platform/email/templates.js';
import { LOGGER } from '../../platform/logging/logger.js';
import { canHold, permissionsOfRoles } from './privileges.js';

const INVITATION_TTL_DAYS = 7;
/** Tope de invitaciones pendientes por empresa: limita el uso de la plataforma como relé de correo. */
const MAX_PENDING_INVITATIONS = 50;

const newToken = generateOneTimeToken;
const hashToken = hashOneTimeToken;

interface ResolvedInvitation {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  email: string;
  role_id: string;
  role_name: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    private readonly config: AppConfig,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private actor(): TenantPrincipal {
    const p = this.cls.get('principal');
    if (!p?.tenantId || !p.membershipId) throw Errors.tenantRequired();
    return p as TenantPrincipal;
  }

  // ===============================================================================================
  // Lado empresa (autenticado)
  // ===============================================================================================
  async create(dto: CreateInvitationRequest): Promise<CreateInvitationResponse> {
    const actor = this.actor();
    const { token, hash } = newToken();

    const { view, tenantName, roleName } = await this.tdb.runAsPrincipal(async (tx) => {
      const role = await tx.roles.findFirst({ where: { key: dto.roleKey } });
      if (!role) throw Errors.validation([{ path: 'roleKey', message: 'El rol no existe en la empresa' }]);
      // Anti-escalada: solo se invita con roles cuyos permisos el actor también tiene.
      if (!canHold(actor.permissions, await permissionsOfRoles(tx, [role.id]))) throw Errors.roleNotAllowed();

      const existingUser = await this.tdb.global.users.findUnique({ where: { email: dto.email }, select: { id: true } });
      if (existingUser && (await tx.tenant_memberships.findFirst({ where: { user_id: existingUser.id } }))) {
        throw Errors.alreadyMember();
      }

      const now = new Date();
      // Una invitación pendiente VENCIDA se revoca para poder reinvitar; una vigente bloquea.
      const pending = await tx.invitations.findFirst({
        where: { email: dto.email, accepted_at: null, revoked_at: null },
      });
      if (pending) {
        if (pending.expires_at > now) throw Errors.alreadyInvited();
        await tx.invitations.update({ where: { id: pending.id }, data: { revoked_at: now } });
      }
      const pendingCount = await tx.invitations.count({
        where: { accepted_at: null, revoked_at: null, expires_at: { gt: now } },
      });
      if (pendingCount >= MAX_PENDING_INVITATIONS) throw Errors.limitReached('invitaciones pendientes');

      const created = await tx.invitations.create({
        data: {
          id: uuidv7(),
          tenant_id: actor.tenantId,
          email: dto.email,
          role_id: role.id,
          token_hash: hash,
          expires_at: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
          invited_by: actor.membershipId,
        },
      });
      await this.audit.record(tx, {
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: created.id,
        // Nunca el token ni su hash.
        after: { email: dto.email, roleKey: role.key },
      });
      const tenant = await tx.tenants.findFirstOrThrow({ select: { name: true } });
      return {
        view: this.toView(created, role.key, role.name, now),
        tenantName: tenant.name,
        roleName: role.name,
      };
    });

    // El correo se envía DESPUÉS de confirmar la transacción: si falla, la invitación existe y se puede reenviar.
    const emailSent = await this.sendEmail({ to: dto.email, tenantName, roleName, token, inviterName: actor.fullName });
    return { invitation: view, emailSent };
  }

  async listPending(): Promise<InvitationView[]> {
    const now = new Date();
    const rows = await this.tdb.runAsPrincipal((tx) =>
      tx.invitations.findMany({
        where: { accepted_at: null, revoked_at: null },
        include: { roles: { select: { key: true, name: true } } },
        orderBy: { id: 'asc' },
      }),
    );
    return rows.map((r) => this.toView(r, r.roles.key, r.roles.name, now));
  }

  async revoke(id: string): Promise<void> {
    await this.tdb.runAsPrincipal(async (tx) => {
      const res = await tx.invitations.updateMany({
        where: { id, accepted_at: null, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      if (res.count !== 1) throw Errors.notFound('Invitación');
      await this.audit.record(tx, { action: 'invitation.revoked', entityType: 'invitation', entityId: id });
    });
  }

  /** Genera un token NUEVO (el anterior deja de funcionar), extiende el plazo y reenvía el correo. */
  async resend(id: string): Promise<CreateInvitationResponse> {
    const actor = this.actor();
    const { token, hash } = newToken();
    const now = new Date();

    const { view, tenantName, roleName, email } = await this.tdb.runAsPrincipal(async (tx) => {
      const updated = await tx.invitations.updateMany({
        where: { id, accepted_at: null, revoked_at: null },
        data: { token_hash: hash, expires_at: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000) },
      });
      if (updated.count !== 1) throw Errors.notFound('Invitación');
      const inv = await tx.invitations.findFirstOrThrow({
        where: { id },
        include: { roles: { select: { key: true, name: true } } },
      });
      await this.audit.record(tx, { action: 'invitation.resent', entityType: 'invitation', entityId: id });
      const tenant = await tx.tenants.findFirstOrThrow({ select: { name: true } });
      return {
        view: this.toView(inv, inv.roles.key, inv.roles.name, now),
        tenantName: tenant.name,
        roleName: inv.roles.name,
        email: inv.email,
      };
    });

    const emailSent = await this.sendEmail({ to: email, tenantName, roleName, token, inviterName: actor.fullName });
    return { invitation: view, emailSent };
  }

  // ===============================================================================================
  // Lado invitado (público): la autoridad es la posesión del token de 256 bits recibido por email
  // ===============================================================================================
  async preview(token: string): Promise<InvitationPreview> {
    const inv = await this.resolveUsable(token);
    const user = await this.tdb.global.users.findUnique({ where: { email: inv.email }, select: { id: true } });
    return { tenantName: inv.tenant_name, roleName: inv.role_name, email: inv.email, accountExists: !!user };
  }

  async accept(dto: AcceptInvitationRequest, client: ClientInfo): Promise<{
    body: AcceptInvitationResponse;
    refreshToken?: string;
  }> {
    const inv = await this.resolveUsable(dto.token);
    const existing = await this.tdb.global.users.findUnique({ where: { email: inv.email } });

    let passwordHash: string | undefined;
    if (!existing) {
      const missing: { path: string; message: string }[] = [];
      if (!dto.fullName) missing.push({ path: 'fullName', message: 'El nombre es obligatorio para crear la cuenta' });
      if (!dto.password) missing.push({ path: 'password', message: 'La contraseña es obligatoria para crear la cuenta' });
      if (missing.length > 0) throw Errors.validation(missing);
      passwordHash = await this.passwords.hash(dto.password!);
    }

    const userId = existing?.id ?? uuidv7();
    try {
      await this.tdb.run({ tenantId: inv.tenant_id }, async (tx) => {
        // Reclamo atómico: si dos personas usan el mismo token a la vez, solo una gana.
        const claimed = await tx.invitations.updateMany({
          where: { id: inv.id, accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } },
          data: { accepted_at: new Date() },
        });
        if (claimed.count !== 1) throw Errors.invitationInvalid();

        if (existing) {
          if (await tx.tenant_memberships.findFirst({ where: { user_id: existing.id } })) throw Errors.alreadyMember();
          // El token llegó a su buzón: queda demostrado el control del email.
          if (!existing.email_verified_at) {
            await tx.users.update({ where: { id: existing.id }, data: { email_verified_at: new Date() } });
          }
        } else {
          await tx.users.create({
            data: {
              id: userId,
              email: inv.email,
              password_hash: passwordHash!,
              full_name: dto.fullName!,
              email_verified_at: new Date(),
            },
          });
        }

        const membershipId = uuidv7();
        await tx.tenant_memberships.create({ data: { id: membershipId, tenant_id: inv.tenant_id, user_id: userId } });
        await tx.membership_roles.create({
          data: { tenant_id: inv.tenant_id, membership_id: membershipId, role_id: inv.role_id },
        });
        await this.audit.record(tx, {
          tenantId: inv.tenant_id,
          actorId: userId,
          action: 'invitation.accepted',
          entityType: 'invitation',
          entityId: inv.id,
          after: { membershipId, accountCreated: !existing },
        });
      });
    } catch (err) {
      // Carrera: otro registro creó esa cuenta entre la lectura y la escritura.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw Errors.emailTaken();
      throw err;
    }

    if (existing) {
      return { body: { outcome: 'joined', tenantName: inv.tenant_name } };
    }
    const session = await this.auth.startSessionFor(
      { id: userId, email: inv.email, fullName: dto.fullName!, emailVerified: true },
      inv.tenant_id,
      client,
    );
    return {
      body: { outcome: 'account_created', tenantName: inv.tenant_name, auth: session.body },
      refreshToken: session.refreshToken,
    };
  }

  // ===============================================================================================
  private async resolveUsable(token: string): Promise<ResolvedInvitation> {
    const rows = await this.tdb.global.$queryRaw<ResolvedInvitation[]>`
      SELECT * FROM rp_resolve_invitation(${hashToken(token)})`;
    const inv = rows[0];
    // Misma respuesta para token inexistente, usado, revocado, vencido o de empresa suspendida.
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at <= new Date() || inv.tenant_status !== 'active') {
      throw Errors.invitationInvalid();
    }
    return inv;
  }

  private toView(
    inv: { id: string; email: string; expires_at: Date; created_at: Date },
    roleKey: string,
    roleName: string,
    now: Date,
  ): InvitationView {
    return {
      id: inv.id,
      email: inv.email,
      roleKey,
      roleName,
      expiresAt: inv.expires_at.toISOString(),
      expired: inv.expires_at <= now,
      createdAt: inv.created_at.toISOString(),
    };
  }

  private async sendEmail(d: {
    to: string;
    tenantName: string;
    roleName: string;
    token: string;
    inviterName: string;
  }): Promise<boolean> {
    // Fragmento (#): el navegador no lo envía al servidor, así que no queda en logs de acceso ni de proxies.
    const acceptUrl = `${this.config.env.ADMIN_APP_URL.replace(/\/$/, '')}/accept-invitation#token=${d.token}`;
    try {
      await this.email.send(
        renderInvitationEmail({
          to: d.to,
          tenantName: d.tenantName,
          inviterName: d.inviterName,
          roleName: d.roleName,
          acceptUrl,
          expiresInDays: INVITATION_TTL_DAYS,
        }),
      );
      return true;
    } catch (err) {
      // Se registra el fallo sin el token ni el enlace.
      this.logger.error({ err, to: d.to }, 'no se pudo enviar el email de invitación');
      return false;
    }
  }
}


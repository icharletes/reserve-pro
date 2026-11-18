import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';
import { uuidv7 } from '../../common/ids.js';
import { generateOneTimeToken, hashOneTimeToken } from '../../common/tokens.js';
import { TenantDb } from '../database/database.module.js';
import { EMAIL_PROVIDER, type EmailMessage, type EmailProvider } from '../email/email.module.js';
import { renderActionEmail } from '../email/templates.js';
import { LOGGER } from '../logging/logger.js';
import { PasswordService } from './password.service.js';
import type { Principal } from './principal.js';
import { SessionService } from './session.service.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Verificación de email y gestión de contraseña. Mismos principios que las invitaciones: tokens de 256 bits,
 * solo su hash en BD, el token viaja en el fragmento (#) del enlace y en el CUERPO de las peticiones.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: AppConfig,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private link(path: string, token: string): string {
    // Fragmento (#): el navegador no lo envía al servidor, así que no queda en logs de acceso ni de proxies.
    return `${this.config.env.ADMIN_APP_URL.replace(/\/$/, '')}${path}#token=${token}`;
  }

  /**
   * Envío en SEGUNDO PLANO: la respuesta HTTP no espera al SMTP. En forgot-password esto iguala el tiempo de
   * respuesta entre emails existentes e inexistentes (si no, la latencia del SMTP delataría la cuenta).
   * Los errores se registran sin incluir el enlace ni el token.
   */
  private sendInBackground(message: EmailMessage, kind: string): void {
    void this.email.send(message).catch((err: unknown) => {
      this.logger.error({ err: (err as Error).message, kind, to: message.to }, 'no se pudo enviar el email');
    });
  }

  // ===============================================================================================
  // Verificación de email
  // ===============================================================================================
  /** Crea un token nuevo (invalida los anteriores) y envía el enlace. */
  async sendVerification(user: { id: string; email: string; fullName: string }): Promise<void> {
    const { token, hash } = generateOneTimeToken();
    const db = this.tdb.global;
    await db.$transaction([
      db.email_verification_tokens.updateMany({
        where: { user_id: user.id, used_at: null },
        data: { used_at: new Date() },
      }),
      db.email_verification_tokens.create({
        data: { id: uuidv7(), user_id: user.id, token_hash: hash, expires_at: new Date(Date.now() + VERIFY_TTL_MS) },
      }),
    ]);
    this.sendInBackground(
      renderActionEmail({
        to: user.email,
        subject: 'Confirma tu email en ReservePro',
        paragraphs: [`Hola ${user.fullName},`, 'Confirma tu dirección de email para activar todas las funciones de tu cuenta.'],
        action: { label: 'Confirmar email', url: this.link('/verify-email', token) },
        footer: 'El enlace vence en 24 horas. Si no creaste esta cuenta, puedes ignorar este mensaje.',
      }),
      'email-verification',
    );
  }

  async resendVerification(principal: Principal): Promise<void> {
    if (principal.emailVerified) return; // ya verificado: no hay nada que hacer
    await this.sendVerification({ id: principal.userId, email: principal.email, fullName: principal.fullName });
  }

  async verifyEmail(token: string): Promise<void> {
    const db = this.tdb.global;
    const row = await db.email_verification_tokens.findUnique({ where: { token_hash: hashOneTimeToken(token) } });
    if (!row) throw Errors.linkInvalid();

    await db.$transaction(async (tx) => {
      // Reclamo atómico: un token solo puede usarse una vez, aunque lleguen dos peticiones a la vez.
      const claimed = await tx.email_verification_tokens.updateMany({
        where: { id: row.id, used_at: null, expires_at: { gt: new Date() } },
        data: { used_at: new Date() },
      });
      if (claimed.count !== 1) throw Errors.linkInvalid();
      await tx.users.updateMany({ where: { id: row.user_id, email_verified_at: null }, data: { email_verified_at: new Date() } });
    });
  }

  // ===============================================================================================
  // Recuperación y cambio de contraseña
  // ===============================================================================================
  /** Responde SIEMPRE igual exista o no la cuenta (no revela qué emails están registrados). */
  async forgotPassword(email: string): Promise<void> {
    const db = this.tdb.global;
    const user = await db.users.findUnique({ where: { email } });
    if (!user || user.status !== 'active') return;

    const { token, hash } = generateOneTimeToken();
    await db.$transaction([
      db.password_reset_tokens.updateMany({ where: { user_id: user.id, used_at: null }, data: { used_at: new Date() } }),
      db.password_reset_tokens.create({
        data: { id: uuidv7(), user_id: user.id, token_hash: hash, expires_at: new Date(Date.now() + RESET_TTL_MS) },
      }),
    ]);
    this.sendInBackground(
      renderActionEmail({
        to: user.email,
        subject: 'Restablece tu contraseña de ReservePro',
        paragraphs: [`Hola ${user.full_name},`, 'Recibimos una solicitud para restablecer tu contraseña.'],
        action: { label: 'Elegir una contraseña nueva', url: this.link('/reset-password', token) },
        footer: 'El enlace vence en 1 hora. Si no fuiste tú, ignora este mensaje: tu contraseña no cambiará.',
      }),
      'password-reset',
    );
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const db = this.tdb.global;
    const row = await db.password_reset_tokens.findUnique({
      where: { token_hash: hashOneTimeToken(token) },
      include: { users: true },
    });
    if (!row || row.users.status !== 'active') throw Errors.linkInvalid();

    const passwordHash = await this.passwords.hash(newPassword);
    await db.$transaction(async (tx) => {
      const claimed = await tx.password_reset_tokens.updateMany({
        where: { id: row.id, used_at: null, expires_at: { gt: new Date() } },
        data: { used_at: new Date() },
      });
      if (claimed.count !== 1) throw Errors.linkInvalid();
      await tx.users.update({
        where: { id: row.user_id },
        data: {
          password_hash: passwordHash,
          failed_logins: 0,
          locked_until: null,
          // El token llegó a su buzón: queda demostrado el control del email.
          ...(row.users.email_verified_at ? {} : { email_verified_at: new Date() }),
        },
      });
      // Cualquier sesión previa pudo estar comprometida: se cierran TODAS.
      await tx.refresh_tokens.updateMany({ where: { user_id: row.user_id, revoked_at: null }, data: { revoked_at: new Date() } });
      // Los demás enlaces de recuperación pendientes dejan de servir.
      await tx.password_reset_tokens.updateMany({ where: { user_id: row.user_id, used_at: null }, data: { used_at: new Date() } });
    });
    this.notifyPasswordChanged(row.users.email, row.users.full_name);
  }

  /** El usuario autenticado cambia su contraseña. Cierra sus OTRAS sesiones y conserva la actual. */
  async changePassword(principal: Principal, currentPassword: string, newPassword: string): Promise<void> {
    const db = this.tdb.global;
    const user = await db.users.findUnique({ where: { id: principal.userId } });
    if (!user || !(await this.passwords.verify(user.password_hash, currentPassword))) {
      throw Errors.currentPasswordWrong();
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await db.$transaction([
      db.users.update({ where: { id: user.id }, data: { password_hash: passwordHash, failed_logins: 0, locked_until: null } }),
      db.refresh_tokens.updateMany({
        where: { user_id: user.id, revoked_at: null, family_id: { not: principal.sessionId } },
        data: { revoked_at: new Date() },
      }),
    ]);
    this.notifyPasswordChanged(user.email, user.full_name);
  }

  /** Aviso de seguridad: si el cambio no lo hizo la persona, es la señal para actuar. */
  private notifyPasswordChanged(to: string, fullName: string): void {
    this.sendInBackground(
      renderActionEmail({
        to,
        subject: 'Tu contraseña de ReservePro fue cambiada',
        paragraphs: [
          `Hola ${fullName},`,
          'La contraseña de tu cuenta acaba de cambiar y se cerraron tus otras sesiones.',
          'Si no fuiste tú, restablece tu contraseña de inmediato y contacta a soporte.',
        ],
      }),
      'password-changed',
    );
  }
}

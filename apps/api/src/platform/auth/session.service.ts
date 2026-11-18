import { Injectable } from '@nestjs/common';
import { TenantDb } from '../database/database.module.js';
import { TokenService } from './token.service.js';
import { uuidv7 } from '../../common/ids.js';
import { Errors } from '../../common/errors.js';

export interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedRefresh {
  token: string;
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
}

/**
 * Sesiones = familias de refresh tokens con rotación. Cada uso rota el token; reutilizar un token
 * ya rotado se interpreta como robo y revoca TODA la familia (ARCHITECTURE.md §7).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly tokens: TokenService,
  ) {}

  /** Inicia una sesión nueva (nueva familia). */
  async start(userId: string, activeTenantId: string | null, client: ClientInfo): Promise<IssuedRefresh> {
    return (await this.insert(userId, uuidv7(), activeTenantId, client)).issued;
  }

  private async insert(
    userId: string,
    familyId: string,
    activeTenantId: string | null,
    client: ClientInfo,
  ): Promise<{ issued: IssuedRefresh; rowId: string }> {
    const { token, hash } = this.tokens.generateRefreshToken();
    const rowId = uuidv7();
    await this.tdb.global.refresh_tokens.create({
      data: {
        id: rowId,
        user_id: userId,
        family_id: familyId,
        token_hash: hash,
        active_tenant_id: activeTenantId,
        expires_at: new Date(Date.now() + this.tokens.refreshTtlMs),
        ip: client.ip ?? null,
        user_agent: client.userAgent?.slice(0, 300) ?? null,
      },
    });
    return { issued: { token, sessionId: familyId, userId, activeTenantId }, rowId };
  }

  /**
   * Rota el refresh token. Lanza TOKEN_INVALID si no existe, expiró o fue reutilizado
   * (en cuyo caso además revoca la familia completa).
   */
  async rotate(rawToken: string, client: ClientInfo): Promise<IssuedRefresh> {
    const hash = TokenService.hashRefreshToken(rawToken);
    const db = this.tdb.global;
    const current = await db.refresh_tokens.findUnique({ where: { token_hash: hash } });
    if (!current) throw Errors.tokenInvalid();

    if (current.revoked_at) {
      // Reutilización de un token ya rotado/revocado: posible robo => se mata la sesión entera.
      await this.revokeFamily(current.family_id);
      throw Errors.tokenInvalid();
    }
    if (current.expires_at <= new Date()) throw Errors.tokenInvalid();

    // Revocación atómica: si dos requests rotan el mismo token a la vez, solo una gana.
    const claimed = await db.refresh_tokens.updateMany({
      where: { id: current.id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    if (claimed.count !== 1) {
      await this.revokeFamily(current.family_id);
      throw Errors.tokenInvalid();
    }

    const next = await this.insert(current.user_id, current.family_id, current.active_tenant_id, client);
    // Traza de la cadena de rotación (útil para investigar un incidente).
    await db.refresh_tokens.update({ where: { id: current.id }, data: { replaced_by: next.rowId } });
    return next.issued;
  }

  /** Cambia la empresa activa de la sesión (para que el próximo refresh conserve la elección). */
  async setActiveTenant(sessionId: string, tenantId: string | null): Promise<void> {
    await this.tdb.global.refresh_tokens.updateMany({
      where: { family_id: sessionId, revoked_at: null },
      data: { active_tenant_id: tenantId },
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.tdb.global.refresh_tokens.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /** Revoca la sesión a la que pertenece el token (logout). Idempotente: un token desconocido no falla. */
  async revokeByToken(rawToken: string): Promise<void> {
    const row = await this.tdb.global.refresh_tokens.findUnique({
      where: { token_hash: TokenService.hashRefreshToken(rawToken) },
      select: { family_id: true },
    });
    if (row) await this.revokeFamily(row.family_id);
  }

  /** Revoca todas las sesiones de un usuario (desactivación, cambio de contraseña). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.tdb.global.refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }
}

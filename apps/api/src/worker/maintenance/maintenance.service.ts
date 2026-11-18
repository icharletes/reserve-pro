import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { TenantDb } from '../../platform/database/database.module.js';
import { LOGGER } from '../../platform/logging/logger.js';

const BATCH = 1_000;
const DAY_MS = 86_400_000;
/** Gracia antes de borrar: conserva rastro reciente para investigar incidentes (p.ej. reutilización de tokens). */
const GRACE_DAYS = 7;

export interface PurgeResult {
  refreshTokens: number;
  passwordResetTokens: number;
  emailVerificationTokens: number;
}

/**
 * Tareas de mantenimiento sobre tablas GLOBALES (sin tenant_id, sin RLS), por eso corren con el rol rp_app.
 * Los trabajos de TENANT que se añadan después deben llevar `tenantId` en el payload y ejecutarse con
 * `TenantDb.run({ tenantId }, …)`: RLS los acotará igual que a una request.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly tdb: TenantDb,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Borra tokens que ya no sirven ni aportan trazabilidad. Se borra por LOTES (de 1 000) para no bloquear
   * tablas con transacciones largas. Es idempotente: ejecutarla dos veces seguidas no borra nada la segunda.
   */
  async purgeExpiredTokens(now: Date = new Date()): Promise<PurgeResult> {
    const cutoff = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
    const db = this.tdb.global;

    // Un refresh token vencido hace más de GRACE_DAYS ya no puede usarse ni sirve para detectar reutilización.
    const refreshTokens = await this.inBatches(
      () =>
        db.$executeRaw`DELETE FROM refresh_tokens WHERE ctid IN (SELECT ctid FROM refresh_tokens WHERE expires_at < ${cutoff} LIMIT ${BATCH})`,
    );
    // Los de un solo uso: vencidos o ya usados hace más de GRACE_DAYS.
    const passwordResetTokens = await this.inBatches(
      () =>
        db.$executeRaw`DELETE FROM password_reset_tokens WHERE ctid IN (SELECT ctid FROM password_reset_tokens WHERE expires_at < ${cutoff} OR used_at < ${cutoff} LIMIT ${BATCH})`,
    );
    const emailVerificationTokens = await this.inBatches(
      () =>
        db.$executeRaw`DELETE FROM email_verification_tokens WHERE ctid IN (SELECT ctid FROM email_verification_tokens WHERE expires_at < ${cutoff} OR used_at < ${cutoff} LIMIT ${BATCH})`,
    );

    const result = { refreshTokens, passwordResetTokens, emailVerificationTokens };
    this.logger.info({ ...result }, 'mantenimiento: tokens vencidos purgados');
    return result;
  }

  private async inBatches(deleteBatch: () => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await deleteBatch();
      total += n;
      if (n < BATCH) return total;
    }
  }
}

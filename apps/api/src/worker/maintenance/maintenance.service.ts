import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { TenantDb } from '../../platform/database/database.module.js';
import { LOGGER } from '../../platform/logging/logger.js';
import { AuditService } from '../../platform/audit/audit.module.js';
import { expireHolds } from '../../modules/reservations/actor.js';
import { SystemDb } from './system-db.js';

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
    private readonly system: SystemDb,
    private readonly audit: AuditService,
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

  /**
   * Libera las reservas pendientes cuya retención venció. `rp_system` solo DESCUBRE qué empresas tienen
   * trabajo; la liberación corre por empresa con RLS y con la misma función que usa el motor de reservas.
   */
  async expireHolds(now: Date = new Date()): Promise<{ tenants: number; expired: number }> {
    const tenants = await this.system.client.$queryRaw<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id FROM reservations
       WHERE status = 'pending' AND hold_expires_at <= ${now}
       LIMIT 500`;
    let expired = 0;
    for (const { tenant_id: tenantId } of tenants) {
      expired += await this.tdb.run({ tenantId }, (tx) =>
        expireHolds(tx, this.audit, tenantId, {}, now),
      );
    }
    if (expired > 0)
      this.logger.info({ tenants: tenants.length, expired }, 'retenciones vencidas liberadas');
    return { tenants: tenants.length, expired };
  }

  /** Borra claves de idempotencia vencidas (24 h). Tabla con RLS de todas las empresas: requiere rp_system. */
  async purgeIdempotencyKeys(now: Date = new Date()): Promise<number> {
    const db = this.system.client;
    const n = await this.inBatches(
      () =>
        db.$executeRaw`DELETE FROM idempotency_keys WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at < ${now} LIMIT ${BATCH})`,
    );
    this.logger.info({ idempotencyKeys: n }, 'mantenimiento: claves de idempotencia purgadas');
    return n;
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

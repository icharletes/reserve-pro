import type { Prisma, PrismaClient } from './generated/client.js';

/** Cliente transaccional que recibe el callback: toda consulta corre bajo el contexto fijado. */
export type Tx = Prisma.TransactionClient;

export interface TenantContext {
  /** Tenant activo. Debe provenir del token validado o de la resolución por slug, NUNCA del body/query. */
  tenantId: string;
  /**
   * Usuario autenticado. Con tenant activo NO amplía la visibilidad (las políticas "propias" solo aplican
   * sin tenant, migración 0002); se acepta por compatibilidad. Para listar las empresas del usuario use `withUser`.
   */
  userId?: string;
}

export interface TxOptions {
  /** Tiempo máximo de la transacción en ms (por defecto 10 000). */
  timeoutMs?: number;
  /** Tiempo máximo esperando una conexión del pool en ms (por defecto 5 000). */
  maxWaitMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label = 'id'): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} no es un UUID válido`);
  }
}

/**
 * Ejecuta `fn` dentro de UNA transacción con el contexto de tenant fijado en PostgreSQL.
 *
 * Usa `set_config(..., true)` (equivale a SET LOCAL): el valor vive solo hasta el COMMIT/ROLLBACK,
 * así que NO se filtra entre requests aunque se reutilice la conexión del pool ni con PgBouncer
 * en modo transaction. Con el contexto fijado, RLS limita cada consulta a ese tenant (ADR-004).
 */
export async function withTenant<T>(
  db: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  assertUuid(ctx.tenantId, 'tenantId');
  if (ctx.userId !== undefined) assertUuid(ctx.userId, 'userId');

  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
      if (ctx.userId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      }
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? 10_000, maxWait: options.maxWaitMs ?? 5_000 },
  );
}

/**
 * Contexto SOLO de usuario (sin tenant activo): p.ej. listar las empresas del usuario tras el login.
 * RLS solo expone las membresías y empresas propias del usuario.
 */
export async function withUser<T>(
  db: PrismaClient,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  assertUuid(userId, 'userId');
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? 10_000, maxWait: options.maxWaitMs ?? 5_000 },
  );
}

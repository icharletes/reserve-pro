/**
 * SQLSTATE de un error de PostgreSQL, venga directo de `pg` o envuelto por Prisma (driver adapter).
 *
 * OJO: Prisma tiene sus PROPIOS códigos de 5 caracteres (P2002, P2039…) en `err.code`; no son SQLSTATE
 * (y un SQLSTATE real puede empezar por P: P0001). Por eso se leen solo rutas conocidas, nunca "cualquier
 * `code` que parezca uno": con esa heurística un 23P01 envuelto en P2039 se perdía y acababa en 500.
 */
export function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as {
    clientVersion?: unknown;
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
    cause?: unknown;
  };
  if (e.clientVersion !== undefined) {
    // Error de Prisma: el SQLSTATE original lo aporta el driver adapter.
    const original = e.meta?.driverAdapterError?.cause?.originalCode;
    return typeof original === 'string' ? original : undefined;
  }
  // Error de `pg` (DatabaseError): `code` ES el SQLSTATE.
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  return e.cause && e.cause !== err ? pgCode(e.cause) : undefined;
}

export const PG = {
  exclusionViolation: '23P01',
  uniqueViolation: '23505',
  deadlock: '40P01',
  serialization: '40001',
} as const;

/** Errores transitorios de concurrencia: se reintenta la transacción completa. */
export function isRetryable(err: unknown): boolean {
  const code = pgCode(err);
  if (code === PG.deadlock || code === PG.serialization) return true;
  return (err as { code?: string } | null)?.code === 'P2034'; // Prisma: conflicto de escritura o deadlock
}

/** Violación de unicidad, sea cual sea la capa que la reporte. */
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === PG.uniqueViolation || (err as { code?: string } | null)?.code === 'P2002';
}

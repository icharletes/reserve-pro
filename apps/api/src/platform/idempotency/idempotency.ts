import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma, Tx } from '@reservepro/database';
import { AppError } from '../../common/errors.js';
import { TenantDb } from '../database/database.module.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

/** Hash estable del cuerpo (claves ordenadas): el mismo contenido da el mismo hash aunque cambie el orden. */
export function hashBody(body: unknown): Uint8Array<ArrayBuffer> {
  const stable = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
        )
      : Array.isArray(v)
        ? v.map(stable)
        : v;
  return Uint8Array.from(
    createHash('sha256')
      .update(JSON.stringify(stable(body)))
      .digest(),
  );
}

export function requireIdempotencyKey(header: string | undefined): string {
  if (!header) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Falta la cabecera Idempotency-Key (un identificador único por intento, p. ej. un UUID)',
    );
  }
  if (!KEY_RE.test(header)) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key inválida: 8 a 100 caracteres A-Z, a-z, 0-9, guion o guion bajo',
    );
  }
  return header;
}

export type Claim = { replay: { status: number; body: unknown } } | { replay: null };

/**
 * Idempotencia DENTRO de la transacción del caso de uso (ADR-014):
 *  - La primera petición inserta la clave como 'in_progress' y, al terminar, guarda la respuesta en la MISMA
 *    transacción. Si algo falla, la clave desaparece con el rollback y se puede reintentar.
 *  - Una segunda petición con la misma clave QUEDA ESPERANDO en el INSERT (bloqueo del índice único) hasta que la
 *    primera termine; entonces encuentra la respuesta guardada y la devuelve tal cual.
 *  - Misma clave con un cuerpo DISTINTO => 422 (es un error del cliente, no un reintento).
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly tdb: TenantDb) {}

  async claim(
    tx: Tx,
    scope: string,
    key: string,
    requestHash: Uint8Array<ArrayBuffer>,
  ): Promise<Claim> {
    const inserted = await tx.$queryRaw<{ key: string }[]>`
      INSERT INTO idempotency_keys (tenant_id, scope, key, request_hash, status, expires_at)
      VALUES (${this.tdb.tenantId}::uuid, ${scope}, ${key}, ${requestHash}, 'in_progress', ${new Date(Date.now() + TTL_MS)})
      ON CONFLICT (tenant_id, scope, key) DO NOTHING
      RETURNING key`;
    if (inserted.length === 1) return { replay: null };

    const row = await tx.idempotency_keys.findFirst({ where: { scope, key } });
    if (!row) return { replay: null }; // vencida y purgada entre medio: se trata como nueva
    if (Buffer.compare(Buffer.from(row.request_hash), Buffer.from(requestHash)) !== 0) {
      throw new AppError(
        422,
        'IDEMPOTENCY_CONFLICT',
        'Esa Idempotency-Key ya se usó con otros datos. Genera una nueva para otra operación.',
      );
    }
    if (row.status !== 'completed') {
      throw new AppError(
        409,
        'IDEMPOTENCY_IN_PROGRESS',
        'Esta operación ya se está procesando. Reintenta en un momento.',
      );
    }
    return { replay: { status: row.response_code ?? 200, body: row.response_body } };
  }

  async complete(tx: Tx, scope: string, key: string, status: number, body: unknown): Promise<void> {
    await tx.idempotency_keys.update({
      where: { tenant_id_scope_key: { tenant_id: this.tdb.tenantId, scope, key } },
      data: {
        status: 'completed',
        response_code: status,
        response_body: body as Prisma.InputJsonValue,
      },
    });
  }
}

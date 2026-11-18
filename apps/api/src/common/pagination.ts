import { z } from 'zod';
import { Errors } from './errors.js';

/**
 * Paginación por cursor sobre `id` (keyset). Se usa el id y no `created_at` a propósito: PostgreSQL guarda
 * microsegundos y JavaScript solo milisegundos, así que un cursor por fecha repetiría filas. Los ids son
 * UUIDv7 (ordenables por tiempo), de modo que el orden por id equivale al orden de creación.
 */
export const pageQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof pageQuery>;

export interface Page<T> {
  items: T[];
  /** null cuando no hay más resultados. */
  nextCursor: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

/** Devuelve el id del cursor o undefined si no hay; un cursor manipulado da 400, nunca llega a la consulta. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID_RE.test(id)) throw Errors.validation([{ path: 'cursor', message: 'Cursor inválido' }]);
  return id;
}

/** Recorta la fila extra (se pide limit+1 para saber si hay otra página) y calcula el cursor siguiente. */
export function toPage<T>(rows: T[], limit: number, idOf: (r: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(idOf(last)) : null };
}

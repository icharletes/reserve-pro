import { Prisma } from '@reservepro/database';
import { AppError, Errors } from '../../common/errors.js';

/**
 * Traduce errores de PostgreSQL/Prisma a errores de API con código estable:
 *  - P2002 (único)  -> 409 DUPLICATE sobre el campo indicado.
 *  - P2003 (FK)     -> 409 IN_USE al borrar; en altas/ediciones significa que una referencia no existe (400).
 * Cualquier otro error se propaga tal cual (acabará como 500 sin detalle).
 */
export function mapDbError(
  err: unknown,
  opts: {
    duplicateField?: string;
    duplicateMessage?: string;
    op?: 'write' | 'delete';
    inUseMessage?: string;
  },
): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return Errors.duplicate(
        opts.duplicateField ?? 'name',
        opts.duplicateMessage ?? 'Ya existe un registro con ese nombre',
      );
    }
    if (err.code === 'P2003') {
      return opts.op === 'delete'
        ? Errors.inUse(
            opts.inUseMessage ?? 'No se puede eliminar: está en uso. Desactívalo en su lugar.',
          )
        : Errors.validation([{ path: '', message: 'Una de las referencias indicadas no existe' }]);
    }
  }
  return err;
}

/** Ejecuta `fn` y aplica `mapDbError` a lo que lance (debe envolver a `runAsPrincipal`, no ir dentro de él). */
export async function guarded<T>(
  fn: () => Promise<T>,
  opts: Parameters<typeof mapDbError>[1] = {},
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapDbError(e, opts);
  }
}

/** Filtro común de listados: búsqueda por nombre (sin distinguir mayúsculas) y estado. */
export function nameAndStatus(q: { q?: string | undefined; isActive?: boolean | undefined }) {
  return {
    ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    ...(q.isActive !== undefined ? { is_active: q.isActive } : {}),
  };
}

export const iso = (d: Date): string => d.toISOString();

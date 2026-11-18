import { clockToMinutes } from '@reservepro/contracts';
import type { Tx } from '@reservepro/database';
import { Errors } from '../../common/errors.js';

export interface Span {
  weekday?: number;
  start: string;
  end: string;
  validFrom?: string | null | undefined;
  validTo?: string | null | undefined;
}

const NEG = '0000-01-01';
const POS = '9999-12-31';

/**
 * Detecta tramos que se pisan ANTES de tocar la base de datos, para devolver un 400 claro con el índice
 * del tramo conflictivo (la restricción EXCLUDE de PostgreSQL es la red de seguridad, no la primera defensa).
 * Dos tramos se pisan si coinciden el día, los minutos se cruzan (tocarse NO es pisarse) y las vigencias se cruzan
 * (inclusivas; sin límite = infinito).
 */
export function assertNoOverlap(spans: readonly Span[], path = 'intervals'): void {
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      if ((a.weekday ?? 0) !== (b.weekday ?? 0)) continue;
      const timeOverlap =
        clockToMinutes(a.start) < clockToMinutes(b.end) &&
        clockToMinutes(b.start) < clockToMinutes(a.end);
      if (!timeOverlap) continue;
      const datesOverlap =
        (a.validFrom ?? NEG) <= (b.validTo ?? POS) && (b.validFrom ?? NEG) <= (a.validTo ?? POS);
      if (datesOverlap) {
        throw Errors.validation([
          { path: `${path}.${j}`, message: `Este tramo se superpone con el tramo ${i + 1}` },
        ]);
      }
    }
  }
}

/** Bloquea la fila (sucursal o recurso) hasta el fin de la transacción: serializa ediciones simultáneas del mismo horario. */
export async function lockRow(tx: Tx, table: 'locations' | 'resources', id: string): Promise<void> {
  if (table === 'locations')
    await tx.$queryRaw`SELECT id FROM locations WHERE id = ${id}::uuid FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM resources WHERE id = ${id}::uuid FOR UPDATE`;
}

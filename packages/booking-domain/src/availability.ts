import type { UtcRange } from './schedule.js';

/**
 * Disponibilidad (pura). Trabaja con instantes UTC ya resueltos por `schedule.ts`.
 *
 * Una reserva tiene una VENTANA visible para el cliente [start, start + duración) y una OCUPACIÓN real del recurso
 * que añade la preparación antes y la limpieza después: [start - antes, start + duración + después).
 * La ocupación completa debe caber dentro del horario de trabajo y no pisar nada ocupado.
 *
 * La lectura (`availableSlots`) es solo informativa: la escritura vuelve a validar con `checkFit` DENTRO de la
 * transacción, con el recurso bloqueado, y PostgreSQL tiene la última palabra (EXCLUDE). Ver ARCHITECTURE.md §6.
 */

const MIN = 60_000;

export interface ServiceTiming {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

export interface FitInput extends ServiceTiming {
  /** Rangos de trabajo del recurso (de `resolveWorkingRanges`). */
  working: readonly UtcRange[];
  /** Ocupado: reservas activas (con sus buffers) y bloqueos. Pueden solaparse entre sí y venir desordenados. */
  busy: readonly UtcRange[];
  /** Primer inicio admitido (ahora + antelación mínima). */
  earliestStart: Date;
  /** Último inicio admitido (ahora + antelación máxima). */
  latestStart: Date;
}

export interface SlotInput extends FitInput {
  /** Rejilla de horarios ofrecidos, en minutos (desde la apertura de cada tramo de trabajo). */
  stepMinutes: number;
}

export interface Slot {
  start: Date;
  end: Date;
}

export type FitProblem = 'TOO_SOON' | 'TOO_FAR' | 'OUTSIDE_WORKING_HOURS' | 'CONFLICT';

/** Ocupación real (con preparación y limpieza) de una reserva que empieza en `start`. */
export function occupancy(start: Date, t: ServiceTiming): UtcRange {
  return {
    start: new Date(start.getTime() - t.bufferBeforeMinutes * MIN),
    end: new Date(start.getTime() + (t.durationMinutes + t.bufferAfterMinutes) * MIN),
  };
}

/** Ordena y fusiona rangos que se pisan o se tocan. */
export function mergeRanges(ranges: readonly UtcRange[]): UtcRange[] {
  const sorted = ranges
    .filter((r) => r.end.getTime() > r.start.getTime())
    .map((r) => ({ start: new Date(r.start), end: new Date(r.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: UtcRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start.getTime() <= last.end.getTime()) {
      if (r.end.getTime() > last.end.getTime()) last.end = r.end;
    } else out.push(r);
  }
  return out;
}

/** `base` menos `minus`: los tramos de `base` que no quedan cubiertos por `minus`. */
export function subtractRanges(base: readonly UtcRange[], minus: readonly UtcRange[]): UtcRange[] {
  const holes = mergeRanges(minus);
  const out: UtcRange[] = [];
  for (const b of mergeRanges(base)) {
    let cursor = b.start.getTime();
    const end = b.end.getTime();
    for (const h of holes) {
      if (h.end.getTime() <= cursor || h.start.getTime() >= end) continue;
      if (h.start.getTime() > cursor) out.push({ start: new Date(cursor), end: new Date(h.start) });
      cursor = Math.max(cursor, h.end.getTime());
      if (cursor >= end) break;
    }
    if (cursor < end) out.push({ start: new Date(cursor), end: new Date(end) });
  }
  return out;
}

const within = (inner: UtcRange, outer: readonly UtcRange[]): boolean =>
  outer.some(
    (o) => o.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= o.end.getTime(),
  );

const overlapsAny = (r: UtcRange, others: readonly UtcRange[]): boolean =>
  others.some((o) => o.start.getTime() < r.end.getTime() && r.start.getTime() < o.end.getTime());

/**
 * ¿Cabe una reserva que empieza EXACTAMENTE en `start`? Devuelve el primer problema o null.
 * Orden de comprobación: ventana de antelación, horario de trabajo y, por último, conflictos.
 */
export function checkFit(input: FitInput, start: Date): FitProblem | null {
  if (start.getTime() < input.earliestStart.getTime()) return 'TOO_SOON';
  if (start.getTime() > input.latestStart.getTime()) return 'TOO_FAR';
  const occ = occupancy(start, input);
  // Los tramos de trabajo contiguos (p. ej. 18:00-24:00 y 00:00-06:00) cuentan como uno solo.
  if (!within(occ, mergeRanges(input.working))) return 'OUTSIDE_WORKING_HOURS';
  if (overlapsAny(occ, input.busy)) return 'CONFLICT';
  return null;
}

/**
 * Horarios ofrecibles, en orden. La rejilla parte de la apertura de cada tramo de trabajo (+ preparación),
 * de modo que una sucursal que abre a las 09:00 ofrece 09:00, 09:15… sin importar a qué hora terminen las
 * reservas existentes.
 */
export function availableSlots(input: SlotInput): Slot[] {
  if (input.stepMinutes <= 0) throw new RangeError('stepMinutes debe ser positivo');
  const free = subtractRanges(input.working, input.busy);
  const out: Slot[] = [];
  const stepMs = input.stepMinutes * MIN;
  for (const w of mergeRanges(input.working)) {
    for (let s = w.start.getTime() + input.bufferBeforeMinutes * MIN; ; s += stepMs) {
      const start = new Date(s);
      const occ = occupancy(start, input);
      if (occ.end.getTime() > w.end.getTime()) break;
      if (s < input.earliestStart.getTime() || s > input.latestStart.getTime()) continue;
      if (within(occ, free)) out.push({ start, end: new Date(s + input.durationMinutes * MIN) });
    }
  }
  return out;
}

export interface ResourceCandidate {
  id: string;
  sortOrder: number;
  /** Minutos ya reservados ese día: se reparte la carga. */
  bookedMinutes: number;
}

/**
 * Asignación automática DETERMINISTA entre recursos libres: el menos cargado, luego el de menor `sortOrder`,
 * luego por id. Determinista = dos peticiones iguales eligen lo mismo (predecible y probable).
 */
export function chooseResource<T extends ResourceCandidate>(candidates: readonly T[]): T | null {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.bookedMinutes - b.bookedMinutes || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  return sorted[0] ?? null;
}

/** Alfabeto sin caracteres ambiguos (sin 0/O, 1/I/L): fácil de dictar por teléfono. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Código legible de reserva a partir de bytes aleatorios (los aporta quien llama). NO es una credencial. */
export function reservationCode(randomBytes: Uint8Array, length = 6): string {
  if (randomBytes.length < length) throw new RangeError('faltan bytes aleatorios');
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomBytes[i]! % CODE_ALPHABET.length];
  return `RP-${code}`;
}

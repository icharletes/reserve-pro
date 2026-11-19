import { DateTime } from 'luxon';

/**
 * Resolución de horarios (pura): del horario semanal + excepciones + feriados + zona horaria a RANGOS UTC
 * concretos de trabajo. Es la base del cálculo de disponibilidad (Fase 3) y del calendario (Fase 2).
 *
 * Modelo (ver ADR-013):
 *  - Los horarios son hora LOCAL de pared en minutos desde medianoche [start, end). 1440 = 24:00.
 *  - weekday es ISO-8601: 1 = lunes … 7 = domingo.
 *  - Las fechas son 'YYYY-MM-DD' en la zona horaria de la sucursal.
 *
 * Precedencia para la SUCURSAL, en un día:  excepción de la sucursal  >  feriado de la empresa  >  horario semanal.
 * Para el RECURSO:  excepción del recurso  >  su horario semanal (si tiene alguno vigente ese día)  >  sigue a la sucursal.
 * El horario efectivo del recurso SIEMPRE se intersecta con el de la sucursal (nadie trabaja con el local cerrado).
 */

/** Tramo de pared en minutos desde medianoche local, semiabierto [start, end). */
export interface MinuteInterval {
  start: number;
  end: number;
}

export interface WeeklyRule {
  /** ISO: 1 = lunes … 7 = domingo. */
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** 'YYYY-MM-DD' inclusive; null/undefined = sin límite. Solo los horarios de recurso tienen vigencia. */
  validFrom?: string | null;
  validTo?: string | null;
}

/** Una fila de excepción de un día. Un día cerrado llega como `isClosed` (tramo 0-1440). */
export interface DayOverride {
  startMinute: number;
  endMinute: number;
  isClosed: boolean;
}

export interface ScopeSchedule {
  weekly: readonly WeeklyRule[];
  /** Excepciones por fecha 'YYYY-MM-DD'. */
  overrides: ReadonlyMap<string, readonly DayOverride[]>;
}

export interface ScheduleInput {
  /** Zona horaria IANA de la sucursal (la propia o, si no tiene, la de la empresa). */
  timezone: string;
  location: ScopeSchedule;
  /** Feriados de la empresa, 'YYYY-MM-DD'. */
  holidays: ReadonlySet<string>;
  /** Si se omite, se resuelve solo el horario de la sucursal. */
  resource?: ScopeSchedule;
}

export interface UtcRange {
  start: Date;
  end: Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(date: string): void {
  if (!DATE_RE.test(date) || !DateTime.fromISO(date, { zone: 'utc' }).isValid) {
    throw new RangeError(`Fecha inválida: ${date}`);
  }
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** Ordena, descarta tramos vacíos y fusiona los que se pisan o se tocan. Idempotente. */
export function normalizeIntervals(intervals: readonly MinuteInterval[]): MinuteInterval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ ...i }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: MinuteInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push(cur);
  }
  return out;
}

/** Intersección de dos conjuntos de tramos (ambos se normalizan primero). */
export function intersectIntervals(
  a: readonly MinuteInterval[],
  b: readonly MinuteInterval[],
): MinuteInterval[] {
  const x = normalizeIntervals(a);
  const y = normalizeIntervals(b);
  const out: MinuteInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i]!.start, y[j]!.start);
    const end = Math.min(x[i]!.end, y[j]!.end);
    if (end > start) out.push({ start, end });
    if (x[i]!.end < y[j]!.end) i++;
    else j++;
  }
  return out;
}

/** Día de la semana ISO (1 = lunes … 7 = domingo) de una fecha de calendario. */
export function isoWeekday(date: string): number {
  assertDate(date);
  return DateTime.fromISO(date, { zone: 'utc' }).weekday;
}

const rulesToIntervals = (rules: readonly WeeklyRule[]): MinuteInterval[] =>
  normalizeIntervals(rules.map((r) => ({ start: r.startMinute, end: r.endMinute })));

const overrideToIntervals = (rows: readonly DayOverride[]): MinuteInterval[] =>
  rows.some((r) => r.isClosed)
    ? []
    : normalizeIntervals(rows.map((r) => ({ start: r.startMinute, end: r.endMinute })));

function locationIntervals(input: ScheduleInput, date: string, weekday: number): MinuteInterval[] {
  const override = input.location.overrides.get(date);
  if (override && override.length > 0) return overrideToIntervals(override);
  if (input.holidays.has(date)) return [];
  return rulesToIntervals(input.location.weekly.filter((r) => r.weekday === weekday));
}

/** `null` = el recurso no tiene horario propio vigente ese día => sigue al de la sucursal. */
function resourceIntervals(
  scope: ScopeSchedule,
  date: string,
  weekday: number,
): MinuteInterval[] | null {
  const override = scope.overrides.get(date);
  if (override && override.length > 0) return overrideToIntervals(override);
  const valid = scope.weekly.filter(
    (r) => (!r.validFrom || r.validFrom <= date) && (!r.validTo || date <= r.validTo),
  );
  if (valid.length === 0) return null;
  return rulesToIntervals(valid.filter((r) => r.weekday === weekday));
}

/** Horario efectivo de pared de UN día local (ya intersectado con la sucursal si hay recurso). */
export function localDayIntervals(input: ScheduleInput, date: string): MinuteInterval[] {
  const weekday = isoWeekday(date);
  const loc = locationIntervals(input, date, weekday);
  if (!input.resource) return loc;
  const own = resourceIntervals(input.resource, date, weekday);
  return own === null ? loc : intersectIntervals(loc, own);
}

/**
 * Convierte tramos de pared de UNA fecha local en rangos UTC, respetando el cambio de hora (DST).
 *  - Hora inexistente (salto adelante): Luxon la desplaza hacia adelante; un tramo que queda vacío se descarta.
 *  - Hora repetida (retroceso): se usa la primera ocurrencia.
 * Los minutos se interpretan como hora de PARED, no como minutos transcurridos: un día con cambio de hora
 * puede durar 23 o 25 horas reales.
 */
export function localIntervalsToUtc(
  timezone: string,
  date: string,
  intervals: readonly MinuteInterval[],
): UtcRange[] {
  assertDate(date);
  if (!isValidTimezone(timezone)) throw new RangeError(`Zona horaria inválida: ${timezone}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = (yy: number, mm: number, dd: number, minute: number): Date =>
    DateTime.fromObject(
      { year: yy, month: mm, day: dd, hour: Math.floor(minute / 60), minute: minute % 60 },
      { zone: timezone },
    ).toJSDate();
  const at = (minute: number): Date => {
    if (minute < 1440) return wall(y, m, d, minute);
    // 24:00 = 00:00 del día de calendario SIGUIENTE. Se calcula esa fecha aparte: partir de "las 00:00 de hoy"
    // fallaría cuando esa hora no existe (p. ej. Santiago salta de 00:00 a 01:00) y daría 01:00 de mañana.
    const next = DateTime.utc(y, m, d).plus({ days: 1 });
    return wall(next.year, next.month, next.day, 0);
  };
  return intervals
    .map((i) => ({ start: at(i.start), end: at(i.end) }))
    .filter((r) => r.end.getTime() > r.start.getTime());
}

/** Fechas 'YYYY-MM-DD' de `from` a `to`, ambas inclusive. */
export function eachDate(from: string, to: string): string[] {
  assertDate(from);
  assertDate(to);
  const out: string[] = [];
  let cur = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  while (cur <= end) {
    out.push(cur.toISODate()!);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

/**
 * Rangos UTC de trabajo entre dos fechas locales (inclusive), ordenados y sin solapes.
 * Rangos contiguos entre días (p. ej. 18:00-24:00 y 00:00-06:00) se fusionan.
 */
export function resolveWorkingRanges(
  input: ScheduleInput,
  fromDate: string,
  toDate: string,
): UtcRange[] {
  const ranges: UtcRange[] = [];
  for (const date of eachDate(fromDate, toDate)) {
    ranges.push(...localIntervalsToUtc(input.timezone, date, localDayIntervals(input, date)));
  }
  ranges.sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: UtcRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start.getTime() <= last.end.getTime()) {
      if (r.end.getTime() > last.end.getTime()) last.end = r.end;
    } else merged.push({ start: new Date(r.start), end: new Date(r.end) });
  }
  return merged;
}

/** "HH:MM" (00:00–24:00) a minutos. Devuelve null si no es válido. */
export function parseClock(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minutes <= 1440 ? minutes : null;
}

/** Minutos a "HH:MM" (1440 => "24:00"). */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Fecha de calendario ('YYYY-MM-DD') que tiene el instante `at` en la zona horaria dada. */
export function localDateOf(at: Date, timezone: string): string {
  if (!isValidTimezone(timezone)) throw new RangeError(`Zona horaria inválida: ${timezone}`);
  return DateTime.fromJSDate(at, { zone: timezone }).toISODate()!;
}

/** Suma días de CALENDARIO a una fecha 'YYYY-MM-DD'. */
export function addCalendarDays(date: string, days: number): string {
  assertDate(date);
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate()!;
}

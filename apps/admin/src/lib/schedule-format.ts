/**
 * Utilidades PURAS de horarios, fechas y zonas horarias para las pantallas de agenda. Sin dependencias del
 * navegador salvo `Intl`. Toda fecha de calendario es 'YYYY-MM-DD'; toda hora de pared es 'HH:MM'.
 */

export const WEEKDAYS = [
  { n: 1, label: 'Lunes' },
  { n: 2, label: 'Martes' },
  { n: 3, label: 'Miércoles' },
  { n: 4, label: 'Jueves' },
  { n: 5, label: 'Viernes' },
  { n: 6, label: 'Sábado' },
  { n: 7, label: 'Domingo' },
] as const;

export interface EditableInterval {
  weekday: number;
  start: string;
  end: string;
  validFrom?: string | null;
  validTo?: string | null;
}

/** Opciones de hora cada `step` minutos: '00:00' … '24:00' (24:00 = fin del día). */
export function clockOptions(step = 15): string[] {
  const out: string[] = [];
  for (let m = 0; m <= 1440; m += step) out.push(formatClock(m));
  return out;
}

export function toMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const NEG = '0000-01-01';
const POS = '9999-12-31';

/**
 * Mensaje del primer problema de un horario semanal, o null si es válido. Refleja las reglas del servidor para
 * avisar al usuario ANTES de guardar (el servidor las vuelve a exigir): fin posterior al inicio y sin solapes
 * (mismo día, horas que se cruzan y vigencias que se cruzan; tocarse no es solaparse).
 */
export function validateWeekly(rows: readonly EditableInterval[]): string | null {
  for (const r of rows) {
    if (toMinutes(r.end) <= toMinutes(r.start)) {
      return `${dayName(r.weekday)}: la hora de fin debe ser posterior a la de inicio.`;
    }
    if (r.validFrom && r.validTo && r.validFrom > r.validTo) {
      return `${dayName(r.weekday)}: la vigencia termina antes de empezar.`;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.weekday !== b.weekday) continue;
      const hours = toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
      const dates =
        (a.validFrom ?? NEG) <= (b.validTo ?? POS) && (b.validFrom ?? NEG) <= (a.validTo ?? POS);
      if (hours && dates) return `${dayName(a.weekday)}: hay tramos que se superponen.`;
    }
  }
  return null;
}

export const dayName = (weekday: number): string =>
  WEEKDAYS.find((d) => d.n === weekday)?.label ?? `Día ${weekday}`;

/** Agrupa por día de la semana (1..7), con los tramos de cada día ordenados por hora de inicio. */
export function groupByWeekday<T extends { weekday: number; start: string }>(
  rows: readonly T[],
): Map<number, T[]> {
  const map = new Map<number, T[]>(WEEKDAYS.map((d) => [d.n, []]));
  for (const r of rows) map.get(r.weekday)?.push(r);
  for (const list of map.values()) list.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  return map;
}

// ---------------------------------------------------------------------------------------------------
// Fechas de calendario (aritmética en UTC: sin sorpresas por la zona horaria del navegador)
// ---------------------------------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana (ISO) que contiene a `date`. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}

export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Fecha de hoy en la zona horaria dada ('YYYY-MM-DD'). */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return localParts(now.toISOString(), timezone).date;
}

// ---------------------------------------------------------------------------------------------------
// Instantes UTC -> hora de pared de una zona horaria
// ---------------------------------------------------------------------------------------------------
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Fecha local y minutos desde la medianoche local de un instante, en la zona dada. */
export function localParts(iso: string, timezone: string): { date: string; minute: number } {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    minute: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}

export interface LocalSegment {
  date: string;
  start: string;
  end: string;
}

/**
 * Parte un rango UTC en tramos por DÍA LOCAL de la zona (un turno nocturno cruza la medianoche y se muestra en
 * ambos días). El día local manda sobre el UTC: 22:00Z puede ser el día siguiente en Asia.
 */
export function utcRangeToLocalSegments(
  range: { start: string; end: string },
  timezone: string,
): LocalSegment[] {
  const s = localParts(range.start, timezone);
  const e = localParts(range.end, timezone);
  const out: LocalSegment[] = [];
  for (let d = s.date; d <= e.date; d = addDays(d, 1)) {
    const from = d === s.date ? s.minute : 0;
    const to = d === e.date ? e.minute : 1440;
    if (to > from) out.push({ date: d, start: formatClock(from), end: formatClock(to) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// <input type="datetime-local"> <-> ISO 8601 con zona
// ---------------------------------------------------------------------------------------------------
/** 'YYYY-MM-DDTHH:mm' (hora del navegador) a ISO UTC; null si no es una fecha válida. */
export function datetimeLocalToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

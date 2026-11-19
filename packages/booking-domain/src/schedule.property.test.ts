import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DayOverride,
  type MinuteInterval,
  type ScheduleInput,
  type WeeklyRule,
  eachDate,
  intersectIntervals,
  localDayIntervals,
  normalizeIntervals,
  resolveWorkingRanges,
} from './schedule.js';

/** Pruebas basadas en PROPIEDADES: invariantes que deben cumplirse para cualquier entrada, no solo ejemplos. */

const interval = fc
  .record({ start: fc.integer({ min: 0, max: 1439 }), len: fc.integer({ min: 0, max: 400 }) })
  .map(({ start, len }): MinuteInterval => ({ start, end: Math.min(1440, start + len) }));
const intervals = fc.array(interval, { maxLength: 8 });
const covers = (list: readonly MinuteInterval[], m: number) =>
  list.some((i) => m >= i.start && m < i.end);
const PROBES = Array.from({ length: 1440 }, (_, i) => i);

describe('normalizeIntervals (propiedades)', () => {
  it('cubre exactamente los mismos minutos que la entrada', () => {
    fc.assert(
      fc.property(intervals, (list) => {
        const n = normalizeIntervals(list);
        for (const m of PROBES.filter((_, i) => i % 7 === 0))
          expect(covers(n, m)).toBe(covers(list, m));
      }),
      { numRuns: 200 },
    );
  });
  it('está ordenado, sin solapes ni tramos que se toquen, y es idempotente', () => {
    fc.assert(
      fc.property(intervals, (list) => {
        const n = normalizeIntervals(list);
        n.forEach((i, idx) => {
          expect(i.end).toBeGreaterThan(i.start);
          if (idx > 0) expect(i.start).toBeGreaterThan(n[idx - 1]!.end);
        });
        expect(normalizeIntervals(n)).toEqual(n);
      }),
      { numRuns: 200 },
    );
  });
});

describe('intersectIntervals (propiedades)', () => {
  it('equivale a la conjunción de ambos conjuntos y es conmutativa', () => {
    fc.assert(
      fc.property(intervals, intervals, (a, b) => {
        const x = intersectIntervals(a, b);
        expect(intersectIntervals(b, a)).toEqual(x);
        for (const m of PROBES.filter((_, i) => i % 5 === 0))
          expect(covers(x, m)).toBe(covers(a, m) && covers(b, m));
      }),
      { numRuns: 200 },
    );
  });
  it('intersecar un conjunto consigo mismo lo deja igual (normalizado)', () => {
    fc.assert(
      fc.property(intervals, (a) => {
        expect(intersectIntervals(a, a)).toEqual(normalizeIntervals(a));
      }),
      { numRuns: 100 },
    );
  });
});

// --- Resolución completa --------------------------------------------------------------------------------
const ZONES = [
  'America/Santiago',
  'America/New_York',
  'Europe/Madrid',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'UTC',
];
const weeklyRule = fc
  .record({
    weekday: fc.integer({ min: 1, max: 7 }),
    start: fc.integer({ min: 0, max: 1439 }),
    len: fc.integer({ min: 1, max: 900 }),
  })
  .map(({ weekday, start, len }): WeeklyRule => ({
    weekday,
    startMinute: start,
    endMinute: Math.min(1440, start + len),
  }));
// Las 365 fechas de 2027 se calculan UNA vez (recalcularlas en cada caso aleatorio es puro desperdicio).
const ALL_DATES = eachDate('2027-01-01', '2027-12-31');
/** La fecha `n` días después de `from`, sin pasar del fin de 2027. */
const shift = (from: string, n: number): string =>
  ALL_DATES[Math.min(ALL_DATES.indexOf(from) + n, ALL_DATES.length - 1)]!;

const dates = fc.integer({ min: 0, max: 360 }).map((offset) => ALL_DATES[offset]!);

const scheduleInput = fc.record({
  timezone: fc.constantFrom(...ZONES),
  locWeekly: fc.array(weeklyRule, { maxLength: 10 }),
  resWeekly: fc.array(weeklyRule, { maxLength: 6 }),
  hasResource: fc.boolean(),
  closedDays: fc.array(dates, { maxLength: 4 }),
  holidays: fc.array(dates, { maxLength: 4 }),
});

function build(
  p: fc.GetArbitrary<typeof scheduleInput> extends fc.Arbitrary<infer T> ? T : never,
): ScheduleInput {
  const closed: DayOverride = { startMinute: 0, endMinute: 1440, isClosed: true };
  return {
    timezone: p.timezone,
    location: { weekly: p.locWeekly, overrides: new Map(p.closedDays.map((d) => [d, [closed]])) },
    holidays: new Set(p.holidays),
    ...(p.hasResource ? { resource: { weekly: p.resWeekly, overrides: new Map() } } : {}),
  };
}

describe('resolveWorkingRanges (propiedades, con zonas y cambios de hora)', () => {
  it('devuelve rangos válidos, ordenados y sin solapes', () => {
    fc.assert(
      fc.property(scheduleInput, dates, fc.integer({ min: 0, max: 14 }), (p, from, span) => {
        const to = shift(from, span);
        const ranges = resolveWorkingRanges(build(p), from, to);
        ranges.forEach((r, i) => {
          expect(r.end.getTime()).toBeGreaterThan(r.start.getTime());
          if (i > 0) expect(r.start.getTime()).toBeGreaterThan(ranges[i - 1]!.end.getTime()); // fusionados: ni se tocan
        });
      }),
      { numRuns: 150 },
    );
  });

  it('el tiempo total nunca supera el máximo posible de los días pedidos (25 h por día)', () => {
    fc.assert(
      fc.property(scheduleInput, dates, (p, from) => {
        const to = shift(from, 6);
        const days = eachDate(from, to).length;
        const total = resolveWorkingRanges(build(p), from, to).reduce(
          (s, r) => s + (r.end.getTime() - r.start.getTime()),
          0,
        );
        expect(total).toBeLessThanOrEqual(days * 25 * 3_600_000);
      }),
      { numRuns: 150 },
    );
  });

  it('el horario del recurso SIEMPRE está contenido en el de la sucursal', () => {
    fc.assert(
      fc.property(scheduleInput, dates, (p, from) => {
        const withRes = build({ ...p, hasResource: true });
        const locOnly = build({ ...p, hasResource: false });
        const to = shift(from, 5);
        const res = resolveWorkingRanges(withRes, from, to);
        const loc = resolveWorkingRanges(locOnly, from, to);
        for (const r of res) {
          expect(
            loc.some(
              (l) => l.start.getTime() <= r.start.getTime() && r.end.getTime() <= l.end.getTime(),
            ),
          ).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('un día CERRADO por excepción nunca aporta tiempo de trabajo', () => {
    fc.assert(
      fc.property(scheduleInput, dates, (p, day) => {
        const input = build({ ...p, closedDays: [day] });
        expect(localDayIntervals(input, day)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it('un feriado sin excepción cierra el día, aunque haya horario semanal', () => {
    fc.assert(
      fc.property(scheduleInput, dates, (p, day) => {
        const input = build({ ...p, closedDays: [], holidays: [day] });
        expect(localDayIntervals(input, day)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it('es determinista: la misma entrada da siempre la misma salida', () => {
    fc.assert(
      fc.property(scheduleInput, dates, (p, from) => {
        const input = build(p);
        expect(resolveWorkingRanges(input, from, from)).toEqual(
          resolveWorkingRanges(input, from, from),
        );
      }),
      { numRuns: 80 },
    );
  });
});

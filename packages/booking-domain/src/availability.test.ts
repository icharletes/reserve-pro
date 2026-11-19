import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  availableSlots,
  checkFit,
  chooseResource,
  mergeRanges,
  occupancy,
  reservationCode,
  subtractRanges,
} from './availability.js';
import type { UtcRange } from './schedule.js';

const at = (hhmm: string, day = '2027-07-05') => new Date(`${day}T${hhmm}:00.000Z`);
const r = (a: string, b: string): UtcRange => ({ start: at(a), end: at(b) });
const iso = (x: { start: Date; end: Date }) => [
  x.start.toISOString().slice(11, 16),
  x.end.toISOString().slice(11, 16),
];
const FAR = { earliestStart: at('00:00', '2000-01-01'), latestStart: at('00:00', '2100-01-01') };
const corte = { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };

describe('operaciones de rangos', () => {
  it('merge fusiona solapes y contiguos', () => {
    expect(
      mergeRanges([
        r('10:00', '11:00'),
        r('09:00', '10:00'),
        r('10:30', '12:00'),
        r('13:00', '13:00'),
      ]).map(iso),
    ).toEqual([['09:00', '12:00']]);
  });
  it('subtract deja los huecos libres', () => {
    expect(
      subtractRanges(
        [r('09:00', '18:00')],
        [r('10:00', '11:00'), r('10:30', '12:00'), r('17:00', '19:00')],
      ).map(iso),
    ).toEqual([
      ['09:00', '10:00'],
      ['12:00', '17:00'],
    ]);
    expect(subtractRanges([r('09:00', '10:00')], [r('08:00', '11:00')])).toEqual([]);
    expect(subtractRanges([r('09:00', '10:00')], []).map(iso)).toEqual([['09:00', '10:00']]);
  });
  it('la ocupación incluye preparación y limpieza', () => {
    expect(
      iso(
        occupancy(at('10:00'), {
          durationMinutes: 60,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 15,
        }),
      ),
    ).toEqual(['09:50', '11:15']);
  });
});

describe('checkFit (la validación de la escritura)', () => {
  const base = { ...FAR, ...corte, working: [r('09:00', '18:00')], busy: [r('12:00', '13:00')] };
  it('cabe dentro del horario y sin conflicto', () => {
    expect(checkFit(base, at('09:00'))).toBeNull();
    expect(checkFit(base, at('11:00'))).toBeNull(); // termina justo cuando empieza la ocupada
    expect(checkFit(base, at('13:00'))).toBeNull(); // empieza justo al terminar
    expect(checkFit(base, at('17:00'))).toBeNull(); // termina al cierre
  });
  it('detecta cada problema', () => {
    expect(checkFit(base, at('11:30'))).toBe('CONFLICT');
    expect(checkFit(base, at('17:30'))).toBe('OUTSIDE_WORKING_HOURS');
    expect(checkFit(base, at('08:30'))).toBe('OUTSIDE_WORKING_HOURS');
    expect(checkFit({ ...base, earliestStart: at('10:00') }, at('09:00'))).toBe('TOO_SOON');
    expect(checkFit({ ...base, latestStart: at('10:00') }, at('11:00'))).toBe('TOO_FAR');
  });
  it('la preparación y limpieza también deben caber y no chocar', () => {
    const buffered = { ...base, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 };
    expect(checkFit(buffered, at('09:00'))).toBe('OUTSIDE_WORKING_HOURS'); // la preparación empezaría 08:45
    expect(checkFit(buffered, at('09:15'))).toBeNull();
    expect(checkFit(buffered, at('10:50'))).toBe('CONFLICT'); // la limpieza (hasta 12:05) pisa la de las 12
    expect(checkFit(buffered, at('13:15'))).toBeNull();
  });
  it('tramos de trabajo contiguos cuentan como uno (turno que cruza la medianoche)', () => {
    const night = {
      ...FAR,
      ...corte,
      working: [
        { start: at('22:00'), end: at('00:00', '2027-07-06') },
        { start: at('00:00', '2027-07-06'), end: at('06:00', '2027-07-06') },
      ],
      busy: [],
    };
    expect(checkFit(night, at('23:30'))).toBeNull();
  });
});

describe('availableSlots', () => {
  it('rejilla desde la apertura; salta lo ocupado; nada que no quepa al cierre', () => {
    const slots = availableSlots({
      ...FAR,
      ...corte,
      stepMinutes: 30,
      working: [r('09:00', '12:00')],
      busy: [r('10:00', '10:30')],
    });
    expect(slots.map((s) => iso(s)[0])).toEqual(['09:00', '10:30', '11:00']);
  });
  it('la rejilla no se desplaza por reservas de duración irregular', () => {
    const slots = availableSlots({
      ...FAR,
      ...corte,
      durationMinutes: 30,
      stepMinutes: 15,
      working: [r('09:00', '11:00')],
      busy: [r('09:00', '09:37')],
    });
    expect(slots.map((s) => iso(s)[0])).toEqual(['09:45', '10:00', '10:15', '10:30']);
  });
  it('respeta la antelación mínima y máxima', () => {
    const slots = availableSlots({
      ...corte,
      stepMinutes: 60,
      working: [r('09:00', '18:00')],
      busy: [],
      earliestStart: at('11:30'),
      latestStart: at('14:00'),
    });
    expect(slots.map((s) => iso(s)[0])).toEqual(['12:00', '13:00', '14:00']);
  });
  it('con preparación: el primer horario es apertura + preparación', () => {
    const slots = availableSlots({
      ...FAR,
      durationMinutes: 60,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 0,
      stepMinutes: 60,
      working: [r('09:00', '12:00')],
      busy: [],
    });
    expect(slots.map((s) => iso(s)[0])).toEqual(['09:15', '10:15']);
  });
  it('sin horario, o totalmente ocupado, no hay horarios; step inválido falla', () => {
    expect(availableSlots({ ...FAR, ...corte, stepMinutes: 15, working: [], busy: [] })).toEqual(
      [],
    );
    expect(
      availableSlots({
        ...FAR,
        ...corte,
        stepMinutes: 15,
        working: [r('09:00', '10:00')],
        busy: [r('08:00', '11:00')],
      }),
    ).toEqual([]);
    expect(() =>
      availableSlots({ ...FAR, ...corte, stepMinutes: 0, working: [], busy: [] }),
    ).toThrow(RangeError);
  });
});

describe('availableSlots (propiedades)', () => {
  const DAY0 = Date.UTC(2027, 6, 5);
  const range = fc
    .record({ s: fc.integer({ min: 0, max: 1380 }), len: fc.integer({ min: 15, max: 600 }) })
    .map(({ s, len }): UtcRange => ({
      start: new Date(DAY0 + s * 60_000),
      end: new Date(DAY0 + (s + len) * 60_000),
    }));
  const input = fc.record({
    working: fc.array(range, { minLength: 1, maxLength: 3 }),
    busy: fc.array(range, { maxLength: 5 }),
    durationMinutes: fc.integer({ min: 5, max: 180 }),
    bufferBeforeMinutes: fc.integer({ min: 0, max: 30 }),
    bufferAfterMinutes: fc.integer({ min: 0, max: 30 }),
    stepMinutes: fc.constantFrom(5, 10, 15, 20, 30, 45, 60),
    earliestOffset: fc.integer({ min: 0, max: 1440 }),
  });
  const build = (p: fc.GetArbitrary<typeof input> extends fc.Arbitrary<infer T> ? T : never) => ({
    ...p,
    earliestStart: new Date(DAY0 + p.earliestOffset * 60_000),
    latestStart: new Date(DAY0 + 3 * 86_400_000),
  });

  it('todo horario ofrecido CABE (checkFit lo confirma): lectura y escritura nunca discrepan', () => {
    fc.assert(
      fc.property(input, (p) => {
        const inp = build(p);
        for (const s of availableSlots(inp)) expect(checkFit(inp, s.start)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
  it('ningún horario ofrecido pisa algo ocupado ni sale del horario de trabajo', () => {
    fc.assert(
      fc.property(input, (p) => {
        const inp = build(p);
        const working = mergeRanges(inp.working);
        for (const s of availableSlots(inp)) {
          const occ = occupancy(s.start, inp);
          expect(inp.busy.some((b) => b.start < occ.end && occ.start < b.end)).toBe(false);
          expect(working.some((w) => w.start <= occ.start && occ.end <= w.end)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
  it('están ordenados, sin repetidos, y respetan la antelación', () => {
    fc.assert(
      fc.property(input, (p) => {
        const inp = build(p);
        const slots = availableSlots(inp);
        slots.forEach((s, i) => {
          expect(s.start.getTime()).toBeGreaterThanOrEqual(inp.earliestStart.getTime());
          expect(s.end.getTime() - s.start.getTime()).toBe(inp.durationMinutes * 60_000);
          if (i > 0) expect(s.start.getTime()).toBeGreaterThan(slots[i - 1]!.start.getTime());
        });
      }),
      { numRuns: 300 },
    );
  });
  it('sin nada ocupado, ocupar un horario ofrecido lo hace desaparecer en el siguiente cálculo', () => {
    fc.assert(
      fc.property(input, (p) => {
        const inp = { ...build(p), busy: [] };
        const first = availableSlots(inp)[0];
        if (!first) return;
        const after = availableSlots({ ...inp, busy: [occupancy(first.start, inp)] });
        expect(after.some((s) => s.start.getTime() === first.start.getTime())).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe('asignación automática', () => {
  it('elige el menos cargado; empata por orden y luego por id (determinista)', () => {
    expect(
      chooseResource([
        { id: 'b', sortOrder: 0, bookedMinutes: 120 },
        { id: 'a', sortOrder: 5, bookedMinutes: 60 },
      ])!.id,
    ).toBe('a');
    expect(
      chooseResource([
        { id: 'b', sortOrder: 2, bookedMinutes: 60 },
        { id: 'a', sortOrder: 1, bookedMinutes: 60 },
      ])!.id,
    ).toBe('a');
    expect(
      chooseResource([
        { id: 'z', sortOrder: 1, bookedMinutes: 0 },
        { id: 'm', sortOrder: 1, bookedMinutes: 0 },
      ])!.id,
    ).toBe('m');
    expect(chooseResource([])).toBeNull();
  });
  it('el resultado no depende del orden de entrada', () => {
    const c = [
      { id: 'a', sortOrder: 1, bookedMinutes: 30 },
      { id: 'b', sortOrder: 0, bookedMinutes: 30 },
      { id: 'c', sortOrder: 0, bookedMinutes: 90 },
    ];
    expect(chooseResource(c)!.id).toBe(chooseResource([...c].reverse())!.id);
  });
});

describe('código de reserva', () => {
  it('formato RP-XXXXXX con alfabeto sin ambiguos (sin 0, O, 1, I, L)', () => {
    const code = reservationCode(new Uint8Array([0, 1, 2, 3, 4, 255]));
    expect(code).toMatch(/^RP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(() => reservationCode(new Uint8Array(3))).toThrow(RangeError);
  });
});

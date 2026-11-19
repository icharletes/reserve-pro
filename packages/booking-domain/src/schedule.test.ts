import { describe, expect, it } from 'vitest';
import {
  type DayOverride,
  type ScheduleInput,
  type ScopeSchedule,
  type WeeklyRule,
  eachDate,
  formatClock,
  intersectIntervals,
  isoWeekday,
  isValidTimezone,
  localDayIntervals,
  localIntervalsToUtc,
  normalizeIntervals,
  parseClock,
  resolveWorkingRanges,
} from './schedule.js';

const scope = (
  weekly: WeeklyRule[] = [],
  overrides: [string, DayOverride[]][] = [],
): ScopeSchedule => ({
  weekly,
  overrides: new Map(overrides),
});
const rule = (
  weekday: number,
  s: number,
  e: number,
  validFrom?: string,
  validTo?: string,
): WeeklyRule => ({
  weekday,
  startMinute: s,
  endMinute: e,
  validFrom: validFrom ?? null,
  validTo: validTo ?? null,
});
const open = (s: number, e: number): DayOverride => ({
  startMinute: s,
  endMinute: e,
  isClosed: false,
});
const closed: DayOverride = { startMinute: 0, endMinute: 1440, isClosed: true };
const H = (h: number, m = 0) => h * 60 + m;
const iso = (r: { start: Date; end: Date }) => [r.start.toISOString(), r.end.toISOString()];
const base = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  timezone: 'America/Santiago',
  location: scope(),
  holidays: new Set(),
  ...over,
});
const monFri = (s = H(9), e = H(18)) => [1, 2, 3, 4, 5].map((d) => rule(d, s, e));

describe('operaciones sobre tramos', () => {
  it('normalize ordena, descarta vacíos y fusiona tramos que se pisan o se tocan', () => {
    expect(
      normalizeIntervals([
        { start: 600, end: 700 },
        { start: 100, end: 200 },
        { start: 200, end: 300 }, // toca
        { start: 650, end: 800 }, // pisa
        { start: 900, end: 900 }, // vacío
      ]),
    ).toEqual([
      { start: 100, end: 300 },
      { start: 600, end: 800 },
    ]);
  });
  it('normalize no modifica la entrada', () => {
    const input = [{ start: 5, end: 10 }];
    normalizeIntervals(input);
    expect(input).toEqual([{ start: 5, end: 10 }]);
  });
  it('intersect', () => {
    expect(intersectIntervals([{ start: 540, end: 1080 }], [{ start: 480, end: 720 }])).toEqual([
      { start: 540, end: 720 },
    ]);
    expect(
      intersectIntervals(
        [
          { start: 0, end: 100 },
          { start: 200, end: 300 },
        ],
        [{ start: 50, end: 250 }],
      ),
    ).toEqual([
      { start: 50, end: 100 },
      { start: 200, end: 250 },
    ]);
    expect(intersectIntervals([{ start: 0, end: 100 }], [{ start: 100, end: 200 }])).toEqual([]); // solo se tocan
    expect(intersectIntervals([], [{ start: 0, end: 100 }])).toEqual([]);
  });
});

describe('fechas y relojes', () => {
  it('weekday ISO: lunes = 1 … domingo = 7', () => {
    expect(isoWeekday('2027-01-04')).toBe(1); // lunes
    expect(isoWeekday('2027-01-10')).toBe(7); // domingo
  });
  it('rechaza fechas y zonas inválidas', () => {
    for (const bad of ['2027-13-01', '2027-02-30', '27-01-01', '2027-1-1', '', 'hoy']) {
      expect(() => isoWeekday(bad), bad).toThrow(RangeError);
    }
    expect(isValidTimezone('America/Santiago')).toBe(true);
    expect(isValidTimezone('Marte/Olympus')).toBe(false);
    expect(() =>
      localIntervalsToUtc('Marte/Olympus', '2027-01-04', [{ start: 0, end: 60 }]),
    ).toThrow(RangeError);
  });
  it('eachDate es inclusivo y cruza meses y años', () => {
    expect(eachDate('2027-12-30', '2028-01-02')).toEqual([
      '2027-12-30',
      '2027-12-31',
      '2028-01-01',
      '2028-01-02',
    ]);
    expect(eachDate('2027-01-05', '2027-01-05')).toEqual(['2027-01-05']);
    expect(eachDate('2027-01-06', '2027-01-05')).toEqual([]);
  });
  it('parseClock / formatClock (24:00 válido)', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    for (const bad of ['24:01', '9:30', '09:60', '25:00', 'abc', ''])
      expect(parseClock(bad), bad).toBeNull();
    expect(formatClock(570)).toBe('09:30');
    expect(formatClock(1440)).toBe('24:00');
    expect(formatClock(0)).toBe('00:00');
  });
});

describe('horario semanal de la sucursal', () => {
  it('lunes a viernes 09-18 en Santiago: invierno (UTC-4) y verano (UTC-3)', () => {
    const input = base({ location: scope(monFri()) });
    // 2027-07-05 lunes (invierno, UTC-4): 09:00 local = 13:00Z
    expect(resolveWorkingRanges(input, '2027-07-05', '2027-07-05').map(iso)).toEqual([
      ['2027-07-05T13:00:00.000Z', '2027-07-05T22:00:00.000Z'],
    ]);
    // 2027-01-04 lunes (verano, UTC-3): 09:00 local = 12:00Z
    expect(resolveWorkingRanges(input, '2027-01-04', '2027-01-04').map(iso)).toEqual([
      ['2027-01-04T12:00:00.000Z', '2027-01-04T21:00:00.000Z'],
    ]);
  });
  it('fin de semana sin tramos => cerrado', () => {
    const input = base({ location: scope(monFri()) });
    expect(resolveWorkingRanges(input, '2027-07-10', '2027-07-11')).toEqual([]); // sábado y domingo
  });
  it('turno partido genera dos rangos; tramos contiguos se fusionan', () => {
    const split = base({ location: scope([rule(1, H(9), H(13)), rule(1, H(14), H(18))]) });
    expect(resolveWorkingRanges(split, '2027-07-05', '2027-07-05')).toHaveLength(2);
    const touching = base({ location: scope([rule(1, H(9), H(13)), rule(1, H(13), H(18))]) });
    expect(resolveWorkingRanges(touching, '2027-07-05', '2027-07-05')).toHaveLength(1);
  });
  it('cerrar a las 24:00 y abrir a las 00:00 del día siguiente forman UN solo rango', () => {
    const input = base({
      timezone: 'UTC',
      location: scope([rule(5, H(18), 1440), rule(6, 0, H(6))]),
    });
    const r = resolveWorkingRanges(input, '2027-07-09', '2027-07-10'); // viernes y sábado
    expect(r.map(iso)).toEqual([['2027-07-09T18:00:00.000Z', '2027-07-10T06:00:00.000Z']]);
  });
});

describe('precedencia: excepción > feriado > semanal', () => {
  const loc = (overrides: [string, DayOverride[]][] = []) => scope(monFri(), overrides);

  it('una excepción CERRADA gana al horario semanal', () => {
    const input = base({ location: loc([['2027-07-05', [closed]]]) });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([]);
    expect(localDayIntervals(input, '2027-07-06')).toEqual([{ start: H(9), end: H(18) }]); // otros días intactos
  });
  it('una excepción con horario especial REEMPLAZA al semanal (no se suma)', () => {
    const input = base({ location: loc([['2027-07-05', [open(H(10), H(14))]]]) });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(10), end: H(14) }]);
  });
  it('una excepción puede abrir un día que normalmente está cerrado', () => {
    const input = base({ location: loc([['2027-07-10', [open(H(10), H(13))]]]) }); // sábado
    expect(localDayIntervals(input, '2027-07-10')).toEqual([{ start: H(10), end: H(13) }]);
  });
  it('un feriado cierra el día', () => {
    const input = base({ location: loc(), holidays: new Set(['2027-09-20']) }); // lunes
    expect(localDayIntervals(input, '2027-09-20')).toEqual([]);
  });
  it('una excepción de la sucursal gana al feriado (apertura especial en feriado)', () => {
    const input = base({
      location: loc([['2027-09-20', [open(H(10), H(14))]]]),
      holidays: new Set(['2027-09-20']),
    });
    expect(localDayIntervals(input, '2027-09-20')).toEqual([{ start: H(10), end: H(14) }]);
  });
});

describe('horario del recurso', () => {
  const location = scope(monFri(H(9), H(18)));

  it('sin horario propio, sigue al de la sucursal', () => {
    const input = base({ location, resource: scope() });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(9), end: H(18) }]);
  });
  it('con horario propio, se INTERSECTA con el de la sucursal', () => {
    const input = base({ location, resource: scope([rule(1, H(8), H(12))]) });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(9), end: H(12) }]); // 08-12 ∩ 09-18
  });
  it('con horario propio, los días sin tramo NO trabaja (aunque la sucursal abra)', () => {
    const input = base({ location, resource: scope([rule(1, H(9), H(18))]) }); // solo lunes
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(9), end: H(18) }]); // lunes
    expect(localDayIntervals(input, '2027-07-06')).toEqual([]); // martes: la sucursal abre, él no
  });
  it('nadie trabaja con la sucursal cerrada', () => {
    const input = base({
      location: scope(monFri(), [['2027-07-05', [closed]]]),
      resource: scope([rule(1, H(9), H(18))]),
    });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([]);
    const sat = base({ location, resource: scope([rule(6, H(9), H(18))]) }); // trabaja sábado, sucursal cerrada
    expect(localDayIntervals(sat, '2027-07-10')).toEqual([]);
  });
  it('la excepción del recurso reemplaza su horario; cerrado => día libre', () => {
    const rs = scope(
      [rule(1, H(9), H(18))],
      [
        ['2027-07-05', [open(H(10), H(12))]],
        ['2027-07-12', [closed]],
      ],
    );
    const input = base({ location, resource: rs });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(10), end: H(12) }]);
    expect(localDayIntervals(input, '2027-07-12')).toEqual([]);
  });
  it('un recurso con horario NO abre un feriado que cierra la sucursal; sin horario propio tampoco', () => {
    const hol = new Set(['2027-07-05']);
    expect(
      localDayIntervals(
        base({ location, holidays: hol, resource: scope([rule(1, H(9), H(18))]) }),
        '2027-07-05',
      ),
    ).toEqual([]);
    expect(
      localDayIntervals(base({ location, holidays: hol, resource: scope() }), '2027-07-05'),
    ).toEqual([]);
  });
  it('vigencias: dentro de la ventana manda su horario; fuera de ella (sin otro vigente) sigue a la sucursal', () => {
    const rs = scope([rule(1, H(10), H(14), '2027-07-01', '2027-07-31')]);
    const input = base({ location, resource: rs });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(10), end: H(14) }]); // dentro
    expect(localDayIntervals(input, '2027-07-06')).toEqual([]); // dentro de la vigencia, martes sin tramo
    expect(localDayIntervals(input, '2027-08-02')).toEqual([{ start: H(9), end: H(18) }]); // fuera: sigue a la sucursal
  });
  it('vigencias inclusivas en ambos extremos', () => {
    const input = base({
      location,
      resource: scope([rule(1, H(10), H(14), '2027-07-05', '2027-07-12')]),
    });
    expect(localDayIntervals(input, '2027-07-05')).toEqual([{ start: H(10), end: H(14) }]);
    expect(localDayIntervals(input, '2027-07-12')).toEqual([{ start: H(10), end: H(14) }]);
    expect(localDayIntervals(input, '2027-07-19')).toEqual([{ start: H(9), end: H(18) }]);
  });
});

describe('cambio de hora (DST)', () => {
  const NY = 'America/New_York';
  const day = (tz: string, date: string, s: number, e: number) =>
    localIntervalsToUtc(tz, date, [{ start: s, end: e }]).map(iso);

  it('Nueva York, salto adelante (2027-03-14): un turno diurno no cambia de duración', () => {
    // 09:00-17:00 EDT (UTC-4) = 13:00Z-21:00Z
    expect(day(NY, '2027-03-14', H(9), H(17))).toEqual([
      ['2027-03-14T13:00:00.000Z', '2027-03-14T21:00:00.000Z'],
    ]);
  });
  it('Nueva York, salto adelante: 01:00-04:00 dura 2 horas REALES (falta la 02:00)', () => {
    const [r] = localIntervalsToUtc(NY, '2027-03-14', [{ start: H(1), end: H(4) }]);
    expect((r!.end.getTime() - r!.start.getTime()) / 3_600_000).toBe(2);
  });
  it('Nueva York, un tramo ENTERO dentro de la hora inexistente se desplaza hacia adelante (documentado)', () => {
    expect(day(NY, '2027-03-14', H(2, 15), H(2, 45))).toEqual([
      ['2027-03-14T07:15:00.000Z', '2027-03-14T07:45:00.000Z'],
    ]); // 03:15-03:45 EDT
  });
  it('Nueva York, retroceso (2027-11-07): 00:00-06:00 dura 7 horas reales (la 01:00 se repite)', () => {
    const [r] = localIntervalsToUtc(NY, '2027-11-07', [{ start: 0, end: H(6) }]);
    expect((r!.end.getTime() - r!.start.getTime()) / 3_600_000).toBe(7);
  });

  for (const tz of [
    'America/New_York',
    'America/Santiago',
    'Europe/Madrid',
    'Australia/Lord_Howe',
  ]) {
    it(`${tz}: un año tiene días de 24 h salvo los de cambio de hora`, () => {
      const lengths = eachDate('2027-01-01', '2027-12-31').map((d) => {
        const [r] = localIntervalsToUtc(tz, d, [{ start: 0, end: 1440 }]);
        return r ? (r.end.getTime() - r.start.getTime()) / 3_600_000 : 0;
      });
      const odd = lengths.filter((h) => h !== 24);
      expect(odd.length).toBeGreaterThanOrEqual(1);
      expect(odd.length).toBeLessThanOrEqual(2);
      for (const h of odd) expect([23, 23.5, 24.5, 25]).toContain(h);
    });
  }

  it('Santiago: el salto ocurre a medianoche; el día completo dura 23 h y no se pierde ni se duplica tiempo', () => {
    const lengths = eachDate('2027-08-25', '2027-09-15').map((d) => {
      const [r] = localIntervalsToUtc('America/Santiago', d, [{ start: 0, end: 1440 }]);
      return (r!.end.getTime() - r!.start.getTime()) / 3_600_000;
    });
    expect(lengths.filter((h) => h === 23)).toHaveLength(1);
    expect(lengths.filter((h) => h === 24)).toHaveLength(lengths.length - 1);
  });

  it('días consecutivos de 24 h forman un tramo continuo sin huecos ni solapes al resolver varios días', () => {
    const input = base({
      timezone: 'America/Santiago',
      location: scope([1, 2, 3, 4, 5, 6, 7].map((d) => rule(d, 0, 1440))),
    });
    const r = resolveWorkingRanges(input, '2027-08-25', '2027-09-15');
    expect(r).toHaveLength(1); // 24x7: un único rango continuo atravesando el cambio de hora
  });
});

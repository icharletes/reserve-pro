import { describe, expect, it } from 'vitest';
import {
  WEEKDAYS,
  addDays,
  clockOptions,
  datetimeLocalToIso,
  formatClock,
  groupByWeekday,
  isValidDate,
  isoToDatetimeLocal,
  localParts,
  mondayOf,
  todayIn,
  toMinutes,
  utcRangeToLocalSegments,
  validateWeekly,
  weekDates,
} from '../lib/schedule-format';

const row = (
  weekday: number,
  start: string,
  end: string,
  validFrom?: string,
  validTo?: string,
) => ({ weekday, start, end, validFrom: validFrom ?? null, validTo: validTo ?? null });

describe('relojes', () => {
  it('opciones cada 15 min de 00:00 a 24:00 (97 valores) y ida y vuelta exacta', () => {
    const opts = clockOptions();
    expect(opts).toHaveLength(97);
    expect(opts[0]).toBe('00:00');
    expect(opts.at(-1)).toBe('24:00');
    for (const o of opts) expect(formatClock(toMinutes(o))).toBe(o);
  });
  it('cada 30 minutos', () => expect(clockOptions(30)).toHaveLength(49));
});

describe('validateWeekly (refleja las reglas del servidor)', () => {
  it('acepta horarios válidos, turno partido y tramos que se tocan', () => {
    expect(
      validateWeekly([
        row(1, '09:00', '13:00'),
        row(1, '14:00', '18:00'),
        row(2, '09:00', '24:00'),
      ]),
    ).toBeNull();
    expect(validateWeekly([row(1, '09:00', '13:00'), row(1, '13:00', '18:00')])).toBeNull();
    expect(validateWeekly([])).toBeNull();
  });
  it('rechaza fin <= inicio, nombrando el día', () => {
    expect(validateWeekly([row(3, '18:00', '09:00')])).toMatch(/Miércoles.*posterior/);
    expect(validateWeekly([row(3, '09:00', '09:00')])).toMatch(/posterior/);
  });
  it('rechaza solapes del mismo día; otro día no cuenta', () => {
    expect(validateWeekly([row(1, '09:00', '13:00'), row(1, '12:00', '15:00')])).toMatch(
      /Lunes.*superponen/,
    );
    expect(validateWeekly([row(1, '09:00', '13:00'), row(2, '12:00', '15:00')])).toBeNull();
  });
  it('vigencias: mismo horario en periodos distintos convive; periodos que se cruzan no', () => {
    expect(
      validateWeekly([
        row(1, '09:00', '18:00', '2027-01-01', '2027-03-31'),
        row(1, '09:00', '18:00', '2027-04-01', '2027-06-30'),
      ]),
    ).toBeNull();
    expect(
      validateWeekly([
        row(1, '09:00', '18:00', '2027-01-01', '2027-06-30'),
        row(1, '10:00', '12:00', '2027-06-30'),
      ]),
    ).toMatch(/superponen/);
    expect(
      validateWeekly([row(1, '09:00', '18:00', '2027-01-01'), row(1, '10:00', '12:00')]),
    ).toMatch(/superponen/); // sin límites pisa todo
    expect(validateWeekly([row(1, '09:00', '18:00', '2027-06-01', '2027-05-01')])).toMatch(
      /vigencia/,
    );
  });
});

describe('agrupar por día', () => {
  it('siempre devuelve los 7 días, con los tramos ordenados', () => {
    const g = groupByWeekday([
      row(1, '14:00', '18:00'),
      row(1, '09:00', '13:00'),
      row(5, '10:00', '11:00'),
    ]);
    expect([...g.keys()]).toEqual(WEEKDAYS.map((d) => d.n));
    expect(g.get(1)!.map((r) => r.start)).toEqual(['09:00', '14:00']);
    expect(g.get(2)).toEqual([]);
  });
});

describe('fechas de calendario', () => {
  it('isValidDate', () => {
    expect(isValidDate('2028-02-29')).toBe(true); // bisiesto
    for (const bad of ['2027-02-29', '2027-13-01', '2027-1-1', '', 'hoy', '2027-04-31'])
      expect(isValidDate(bad), bad).toBe(false);
  });
  it('addDays cruza meses, años y años bisiestos', () => {
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
  it('mondayOf: lunes a domingo pertenecen a la misma semana ISO', () => {
    for (const d of ['2027-07-05', '2027-07-06', '2027-07-09', '2027-07-10', '2027-07-11'])
      expect(mondayOf(d), d).toBe('2027-07-05');
    expect(mondayOf('2027-07-12')).toBe('2027-07-12');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
  });
  it('weekDates devuelve 7 días consecutivos', () => {
    const w = weekDates('2027-07-05');
    expect(w).toHaveLength(7);
    expect(w[0]).toBe('2027-07-05');
    expect(w[6]).toBe('2027-07-11');
  });
  it('todayIn usa la zona pedida, no la del navegador', () => {
    const t = new Date('2027-07-05T02:00:00Z'); // en Santiago (UTC-4) todavía es el día anterior
    expect(todayIn('America/Santiago', t)).toBe('2027-07-04');
    expect(todayIn('UTC', t)).toBe('2027-07-05');
    expect(todayIn('Asia/Kolkata', t)).toBe('2027-07-05');
  });
});

describe('instantes UTC a hora de pared', () => {
  it('Santiago: invierno (UTC-4) y verano (UTC-3)', () => {
    expect(localParts('2027-07-05T13:00:00Z', 'America/Santiago')).toEqual({
      date: '2027-07-05',
      minute: 9 * 60,
    });
    expect(localParts('2027-01-04T12:00:00Z', 'America/Santiago')).toEqual({
      date: '2027-01-04',
      minute: 9 * 60,
    });
  });
  it('un rango diurno es un solo tramo en su día local', () => {
    expect(
      utcRangeToLocalSegments(
        { start: '2027-07-05T13:00:00.000Z', end: '2027-07-05T22:00:00.000Z' },
        'America/Santiago',
      ),
    ).toEqual([{ date: '2027-07-05', start: '09:00', end: '18:00' }]);
  });
  it('el día LOCAL manda sobre el UTC (Asia/Kolkata, UTC+5:30)', () => {
    expect(
      utcRangeToLocalSegments(
        { start: '2027-07-05T22:00:00Z', end: '2027-07-06T04:00:00Z' },
        'Asia/Kolkata',
      ),
    ).toEqual([{ date: '2027-07-06', start: '03:30', end: '09:30' }]);
  });
  it('un turno que cruza la medianoche local se parte en dos días', () => {
    // 16:00 del 5-jul a 04:00 del 6-jul en Santiago (UTC-4)
    expect(
      utcRangeToLocalSegments(
        { start: '2027-07-05T20:00:00Z', end: '2027-07-06T08:00:00Z' },
        'America/Santiago',
      ),
    ).toEqual([
      { date: '2027-07-05', start: '16:00', end: '24:00' },
      { date: '2027-07-06', start: '00:00', end: '04:00' },
    ]);
  });
  it('terminar justo a medianoche NO genera un tramo vacío al día siguiente', () => {
    expect(
      utcRangeToLocalSegments(
        { start: '2027-07-05T20:00:00Z', end: '2027-07-06T04:00:00Z' },
        'America/Santiago',
      ),
    ).toEqual([{ date: '2027-07-05', start: '16:00', end: '24:00' }]);
  });
  it('varios días seguidos abiertos 24 h producen un tramo por día', () => {
    const segs = utcRangeToLocalSegments(
      { start: '2027-07-05T04:00:00Z', end: '2027-07-08T04:00:00Z' },
      'America/Santiago',
    );
    expect(segs.map((s) => s.date)).toEqual(['2027-07-05', '2027-07-06', '2027-07-07']);
    expect(segs.every((s) => s.start === '00:00' && s.end === '24:00')).toBe(true);
  });
  it('día de cambio de hora en Santiago (2027-09-05): la hora inexistente se refleja (empieza a las 01:00)', () => {
    expect(
      utcRangeToLocalSegments(
        { start: '2027-09-05T04:00:00Z', end: '2027-09-06T03:00:00Z' },
        'America/Santiago',
      ),
    ).toEqual([{ date: '2027-09-05', start: '01:00', end: '24:00' }]);
  });
});

describe('datetime-local <-> ISO', () => {
  it('ida y vuelta conserva el valor', () => {
    for (const v of ['2027-07-05T09:30', '2027-12-31T23:59', '2027-01-01T00:00'])
      expect(isoToDatetimeLocal(datetimeLocalToIso(v)!)).toBe(v);
  });
  it('valores inválidos o incompletos devuelven null', () => {
    for (const bad of ['', '2027-07-05', '2027-07-05 09:30', '2027-13-45T99:99', 'ayer'])
      expect(datetimeLocalToIso(bad), bad).toBeNull();
  });
  it('el resultado es ISO UTC (termina en Z)', () => {
    expect(datetimeLocalToIso('2027-07-05T09:30')).toMatch(/Z$/);
  });
});

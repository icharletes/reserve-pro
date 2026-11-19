import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRANSITIONS,
  availableActions,
  formatLocalDateTime,
  formatLocalTime,
  formatMoney,
  normalizePhone,
  zonedMidnight,
  statusLabel,
} from '../lib/reservations';

describe('máquina de estados del panel', () => {
  it('coincide con la del dominio (fuente de verdad del servidor)', () => {
    // El panel no puede importar booking-domain (regla de arquitectura): se compara con su código fuente.
    const src = readFileSync(
      resolve(__dirname, '../../../../packages/booking-domain/src/state-machine.ts'),
      'utf8',
    );
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      const line = src.split('\n').find((l) => l.trim().startsWith(`${from}: [`));
      expect(line, from).toBeDefined();
      const domain = [...line!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect([from, domain]).toEqual([from, [...tos]]);
    }
  });

  it('ofrece solo las acciones válidas y permitidas', () => {
    const all = () => true;
    const future = { status: 'confirmed', startAt: '2027-07-05T13:00:00.000Z' };
    const now = new Date('2027-07-01T00:00:00Z');
    expect(availableActions(future, all, now)).toEqual([
      'reschedule',
      'in_progress',
      'completed',
      'cancel',
    ]);
    // "no asistió" solo cuando ya empezó
    expect(availableActions(future, all, new Date('2027-07-05T13:00:00Z'))).toContain('no_show');
    expect(availableActions({ ...future, status: 'pending' }, all, now)).toEqual([
      'confirm',
      'reschedule',
      'cancel',
    ]);
    expect(availableActions({ ...future, status: 'cancelled' }, all, now)).toEqual([]);
    // un profesional (solo reservations:status) no ve cancelar ni reprogramar
    const pro = (p: string) => p === 'reservations:status';
    expect(availableActions(future, () => false, now)).toEqual([]);
    expect(availableActions(future, pro, now)).toEqual(['in_progress', 'completed']);
    expect(statusLabel('no_show')).toBe('No asistió');
  });
});

describe('formato en la hora de la sucursal', () => {
  it('usa la zona indicada, no la del navegador (incluido el cambio de hora)', () => {
    expect(formatLocalDateTime('2027-07-05T13:00:00.000Z', 'America/Santiago')).toBe(
      'lun 05/07/2027 09:00',
    );
    expect(formatLocalTime('2027-01-04T12:00:00.000Z', 'America/Santiago')).toBe('09:00'); // verano
    expect(formatLocalTime('2027-07-05T13:00:00.000Z', 'America/New_York')).toBe('09:00');
  });
  it('medianoche local en UTC, también el día del cambio de hora', () => {
    expect(zonedMidnight('2027-07-05', 'America/Santiago').toISOString()).toBe(
      '2027-07-05T04:00:00.000Z',
    );
    expect(zonedMidnight('2027-01-04', 'America/Santiago').toISOString()).toBe(
      '2027-01-04T03:00:00.000Z',
    );
    // 2027-09-05: en Santiago 00:00 no existe (salta a 01:00); el día empieza a las 01:00 = 04:00Z
    expect(zonedMidnight('2027-09-05', 'America/Santiago').toISOString()).toBe(
      '2027-09-05T04:00:00.000Z',
    );
    expect(zonedMidnight('2027-07-05', 'UTC').toISOString()).toBe('2027-07-05T00:00:00.000Z');
  });
  it('dinero sin coma flotante; CLP sin decimales', () => {
    expect(formatMoney('15000.00', 'CLP')).toBe('$15.000 CLP');
    expect(formatMoney('1234567.50', 'USD')).toBe('$1.234.567,50 USD');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+56 9 1234 5678', '+56912345678'],
    ['9 1234 5678', '+56912345678'],
    ['56912345678', '+56912345678'],
    ['0056912345678', '+56912345678'],
    ['(9) 1234-5678', '+56912345678'],
    ['+1 212 555 0100', '+12125550100'],
  ])('%s -> %s', (input, out) => expect(normalizePhone(input)).toBe(out));
  it.each(['', 'abc', '+0123', '12'])('"%s" no es válido', (input) =>
    expect(normalizePhone(input)).toBeNull(),
  );
});

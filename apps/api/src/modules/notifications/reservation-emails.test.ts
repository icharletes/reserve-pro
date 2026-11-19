import { describe, expect, it } from 'vitest';
import { emailKindFor } from './notifications.service.js';
import { type ReservationEmailData, renderReservationEmail } from './reservation-emails.js';

const base: ReservationEmailData = {
  to: 'carla@example.test',
  kind: 'created_confirmed',
  customerFirstName: 'Carla',
  tenantName: 'Barbería Uno',
  code: 'RP-ABC234',
  serviceName: 'Corte',
  resourceName: 'Ana',
  locationName: 'Centro',
  locationAddress: 'Av. Siempre Viva 742, Santiago',
  startAt: new Date('2027-07-05T13:00:00Z'),
  endAt: new Date('2027-07-05T14:00:00Z'),
  timeZone: 'America/Santiago',
  manageUrl: 'http://portal.test/mi-reserva#token=abc',
  cancelWindowHours: 24,
};

describe('emails de reserva', () => {
  it('confirmación: datos en la hora del negocio y enlace de gestión', () => {
    const m = renderReservationEmail(base);
    expect(m.subject).toBe('Reserva confirmada en Barbería Uno');
    expect(m.text).toContain('lunes, 5 de julio, de 09:00 a 10:00 h'); // UTC-4 en julio
    expect(m.text).toContain('Código: RP-ABC234');
    expect(m.text).toContain('http://portal.test/mi-reserva#token=abc');
    expect(m.text).toContain('hasta 24 h antes');
    expect(m.html).toContain('href="http://portal.test/mi-reserva#token=abc"');
  });

  it('pendiente: explica la retención; cancelada y vencida: SIN enlace', () => {
    const pending = renderReservationEmail({
      ...base,
      kind: 'created_pending',
      holdExpiresAt: new Date('2027-07-01T15:30:00Z'),
    });
    expect(pending.subject).toBe('Recibimos tu solicitud en Barbería Uno');
    expect(pending.text).toContain('hasta las 11:30 h');
    for (const kind of ['cancelled', 'expired'] as const) {
      const m = renderReservationEmail({ ...base, kind, manageUrl: null });
      expect(m.text).not.toContain('mi-reserva');
      expect(m.html).not.toContain('mi-reserva');
    }
    expect(renderReservationEmail({ ...base, kind: 'reminder' }).subject).toMatch(/^Recordatorio/);
  });

  it('escapa lo que escriben personas y limpia el asunto (inyección de HTML y de cabeceras)', () => {
    const m = renderReservationEmail({
      ...base,
      tenantName: 'Malo\r\nBcc: victima@example.test',
      customerFirstName: '<script>alert(1)</script>',
      serviceName: '<img src=x onerror=alert(1)>',
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('qué evento produce qué email', () => {
    expect(emailKindFor('reservation.created', { status: 'confirmed' })).toBe('created_confirmed');
    expect(emailKindFor('reservation.created', { status: 'pending' })).toBe('created_pending');
    expect(emailKindFor('reservation.status_changed', { to: 'confirmed' })).toBe('confirmed');
    expect(emailKindFor('reservation.status_changed', { to: 'completed' })).toBeNull();
    expect(emailKindFor('reservation.status_changed', { to: 'no_show' })).toBeNull();
    expect(emailKindFor('reservation.rescheduled', {})).toBe('rescheduled');
    expect(emailKindFor('reservation.cancelled', {})).toBe('cancelled');
    expect(emailKindFor('reservation.expired', {})).toBe('expired');
    expect(emailKindFor('reservation.algo_nuevo', {})).toBeNull();
  });
});

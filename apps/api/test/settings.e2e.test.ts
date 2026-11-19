import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, hours, mkLocation, mkResource, mkService } from './catalog-helpers.js';
import { createTestApp, http, joinTenant, ownerPool, register } from './helpers.js';

let app: INestApplication;
let owner: pg.Pool;
beforeAll(async () => {
  app = await createTestApp();
  owner = ownerPool();
});
afterAll(async () => {
  await app.close();
  await owner.end();
});

async function tenant() {
  const t = await register(app);
  return { ...t, c: client(app, t.auth), slug: t.body.memberships[0]!.tenantSlug };
}

describe('configuración de la empresa', () => {
  it('valores por defecto (ADR-007) y edición PARCIAL: lo no enviado no cambia', async () => {
    const t = await tenant();
    const res = await t.c.get('/tenants/current/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      publicBookingEnabled: true,
      bookingMinNoticeMinutes: 60,
      bookingMaxAdvanceDays: 90,
      slotStepMinutes: 15,
      autoConfirm: true,
      pendingHoldMinutes: 30,
      selfServiceCancel: true,
      cancelWindowHours: 24,
      cancelRequiresApproval: false,
      selfServiceReschedule: true,
      rescheduleWindowHours: 24,
      maxReschedules: 2,
      maxActivePublicPerCustomer: 3,
      customerEmailsEnabled: true,
      reminderHoursBefore: 24,
    });
    const patched = await t.c.patch('/tenants/current/settings', {
      cancelWindowHours: 48,
      selfServiceReschedule: false,
      reminderHoursBefore: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      ...res.body,
      cancelWindowHours: 48,
      selfServiceReschedule: false,
      reminderHoursBefore: null,
      updatedAt: expect.any(String),
    });
    // la otra acción de autogestión se conserva al cambiar una
    expect(patched.body.selfServiceCancel).toBe(true);
    const audit = await owner.query(
      `SELECT before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.settings_updated'`,
      [t.tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before.cancelWindowHours).toBe(24);
    expect(audit.rows[0].after.cancelWindowHours).toBe(48);
  });

  it('rechaza valores fuera de rango, campos desconocidos y cuerpos vacíos', async () => {
    const t = await tenant();
    for (const body of [
      { slotStepMinutes: 7 },
      { cancelWindowHours: -1 },
      { reminderHoursBefore: 0 },
      { maxActivePublicPerCustomer: 0 },
      { pendingHoldMinutes: 1 },
      { tenantId: randomUUID() },
      {},
    ]) {
      const res = await t.c.patch('/tenants/current/settings', body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
  });

  it('solo quien tiene tenant:update puede editar; recepción puede leer', async () => {
    const t = await tenant();
    const rec = await joinTenant(app, owner, t.tenantId, 'receptionist');
    const r = client(app, rec.auth);
    expect((await r.get('/tenants/current/settings')).status).toBe(200);
    expect((await r.patch('/tenants/current/settings', { autoConfirm: false })).status).toBe(403);
  });

  it('el cambio aplica de inmediato al portal: apagarlo lo oculta; exigir confirmación deja pendiente', async () => {
    const t = await tenant();
    const loc = await mkLocation(t.c, 'Centro');
    await t.c.put(`/locations/${loc.id}/business-hours`, {
      intervals: hours([1, 2, 3, 4, 5, 6, 7], '08:00', '20:00'),
    });
    const res = await mkResource(t.c, loc.id, 'Ana');
    const svc = await mkService(t.c, 'Corte', { durationMinutes: 30 });
    await t.c.put(`/services/${svc.id}/locations`, { locationIds: [loc.id] });
    await t.c.put(`/services/${svc.id}/resources`, { resourceIds: [res.id] });

    await t.c.patch('/tenants/current/settings', { publicBookingEnabled: false });
    expect((await http(app).get(`/api/v1/public/tenants/${t.slug}`)).status).toBe(404);
    await t.c.patch('/tenants/current/settings', {
      publicBookingEnabled: true,
      autoConfirm: false,
    });
    expect((await http(app).get(`/api/v1/public/tenants/${t.slug}`)).status).toBe(200);

    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const av = await http(app).get(
      `/api/v1/public/tenants/${t.slug}/availability?serviceId=${svc.id}&locationId=${loc.id}&from=${day}`,
    );
    const booked = await http(app)
      .post(`/api/v1/public/tenants/${t.slug}/reservations`)
      .set('Idempotency-Key', randomUUID())
      .send({
        serviceId: svc.id,
        locationId: loc.id,
        startAt: av.body.resources[0].slots[0].start,
        customer: { firstName: 'X', phoneE164: '+56988887777' },
      });
    expect(booked.status).toBe(201);
    expect(booked.body.reservation.status).toBe('pending');
  });
});

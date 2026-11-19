import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicReservationView } from '@reservepro/contracts';
import { MaintenanceService } from '../src/worker/maintenance/maintenance.service.js';
import { SystemDb } from '../src/worker/maintenance/system-db.js';
import { AppConfig } from '../src/config/app-config.js';
import { AuditService } from '../src/platform/audit/audit.module.js';
import { TenantDb } from '../src/platform/database/database.module.js';
import { LOGGER } from '../src/platform/logging/logger.js';
import { client, hours, mkLocation, mkResource, mkService } from './catalog-helpers.js';
import { createTestApp, http, ownerPool, register } from './helpers.js';

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

/**
 * Las fechas son RELATIVAS a hoy (el portal limita la antelación a 90 días por defecto): un lunes entre 14 y 20
 * días adelante. Las horas exactas se toman de la disponibilidad, no se calculan a mano (zona y cambio de hora).
 */
function mondayAhead(minDays = 14): string {
  const d = new Date(Date.now() + minDays * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const DAY = mondayAhead();
const P = (path: string) => `/api/v1/public${path}`;
let phoneSeq = 50_000_000;
const phone = () => `+569${phoneSeq++}`;

/** Negocio con una sucursal lun-vie 09-18; Ana y Beto online; "Interno" NO reservable online. */
async function business(serviceExtra: object = {}) {
  const t = await register(app);
  const slug = t.body.memberships[0]!.tenantSlug;
  const c = client(app, t.auth);
  const loc = await mkLocation(c, 'Centro');
  await c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1, 2, 3, 4, 5]) });
  const ana = await mkResource(c, loc.id, 'Ana', { sortOrder: 1 });
  const beto = await mkResource(c, loc.id, 'Beto', { sortOrder: 2 });
  const internal = await mkResource(c, loc.id, 'Interno', { isBookableOnline: false });
  const svc = await mkService(c, 'Corte', { durationMinutes: 60, price: '15000', ...serviceExtra });
  await c.put(`/services/${svc.id}/locations`, { locationIds: [loc.id] });
  await c.put(`/services/${svc.id}/resources`, { resourceIds: [ana.id, beto.id, internal.id] });
  const settings = (sql: string, params: unknown[] = []) =>
    owner.query(`UPDATE tenant_settings SET ${sql} WHERE tenant_id = $1`, [t.tenantId, ...params]);
  return { ...t, slug, c, loc, ana, beto, internal, svc, settings };
}
type Biz = Awaited<ReturnType<typeof business>>;

async function slots(b: Biz, resourceId?: string): Promise<string[]> {
  const res = await http(app).get(
    P(
      `/tenants/${b.slug}/availability?serviceId=${b.svc.id}&locationId=${b.loc.id}&from=${DAY}${resourceId ? `&resourceId=${resourceId}` : ''}`,
    ),
  );
  expect(res.status).toBe(200);
  return [
    ...new Set(
      (res.body.resources as { slots: { start: string }[] }[]).flatMap((r) =>
        r.slots.map((s) => s.start),
      ),
    ),
  ].sort();
}

function book(b: Biz, body: object = {}, key: string = randomUUID()) {
  return http(app)
    .post(P(`/tenants/${b.slug}/reservations`))
    .set('Idempotency-Key', key)
    .send({
      serviceId: b.svc.id,
      locationId: b.loc.id,
      customer: { firstName: 'Carla', phoneE164: phone() },
      ...body,
    });
}
async function booked(b: Biz, body: object = {}) {
  const startAt = (body as { startAt?: string }).startAt ?? (await slots(b))[0]!;
  const res = await book(b, { startAt, ...body });
  if (res.status !== 201) throw new Error(`book: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { reservation: PublicReservationView; manageToken: string };
}
const manage = (action: string, body: object) =>
  http(app)
    .post(P(`/manage/${action}`))
    .send(body);

describe('datos públicos del negocio', () => {
  it('muestra nombre, sucursales reservables y políticas; un slug desconocido da 404', async () => {
    const b = await business();
    const res = await http(app).get(P(`/tenants/${b.slug}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: b.slug,
      timezone: 'America/Santiago',
      currency: 'CLP',
      locations: [{ id: b.loc.id, name: 'Centro', timezone: 'America/Santiago' }],
      policies: { cancelWindowHours: 24, rescheduleWindowHours: 24, maxReschedules: 2 },
    });
    expect((await http(app).get(P('/tenants/no-existe-este-negocio'))).status).toBe(404);
    expect((await http(app).get(P('/tenants/MAYUS'))).status).toBe(400);
  });

  it('un negocio con el portal desactivado no existe para el público', async () => {
    const b = await business();
    await b.settings('public_booking_enabled = false');
    expect((await http(app).get(P(`/tenants/${b.slug}`))).status).toBe(404);
    expect((await book(b, { startAt: `${DAY}T13:00:00.000Z` })).status).toBe(404);
  });

  it('servicios: solo activos, ofrecidos y con recursos online (sin el recurso interno)', async () => {
    const b = await business();
    await mkService(b.c, 'Sin profesionales'); // sin sucursal ni recursos: no aparece
    const res = await http(app).get(P(`/tenants/${b.slug}/services?locationId=${b.loc.id}`));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: 'Corte',
      durationMinutes: 60,
      price: '15000.00',
      requiresConfirmation: false,
      resources: [
        { id: b.ana.id, name: 'Ana' },
        { id: b.beto.id, name: 'Beto' },
      ],
    });
    // la sucursal de OTRO negocio no existe aquí
    const other = await business();
    expect(
      (await http(app).get(P(`/tenants/${b.slug}/services?locationId=${other.loc.id}`))).status,
    ).toBe(404);
  });

  it('disponibilidad: solo recursos online', async () => {
    const b = await business();
    const res = await http(app).get(
      P(`/tenants/${b.slug}/availability?serviceId=${b.svc.id}&locationId=${b.loc.id}&from=${DAY}`),
    );
    expect(res.body.resources.map((r: { resourceId: string }) => r.resourceId)).toEqual([
      b.ana.id,
      b.beto.id,
    ]);
    expect(
      (
        await http(app).get(
          P(
            `/tenants/${b.slug}/availability?serviceId=${b.svc.id}&locationId=${b.loc.id}&from=${DAY}&resourceId=${b.internal.id}`,
          ),
        )
      ).status,
    ).toBe(404);
  });
});

describe('reservar desde el portal', () => {
  it('confirma, devuelve el enlace de gestión UNA vez y no expone datos del cliente', async () => {
    const b = await business();
    const [first] = await slots(b);
    const res = await book(b, {
      startAt: first,
      customer: { firstName: 'Carla', phoneE164: '+56977777777', email: 'carla@example.test' },
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.reservation).toMatchObject({
      status: 'confirmed',
      startAt: first,
      serviceName: 'Corte',
      totalAmount: '15000.00',
      locationName: 'Centro',
      resourceName: 'Ana',
      tenantSlug: b.slug,
      holdExpiresAt: null,
      canCancel: true,
      canReschedule: true,
    });
    expect(res.body.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('+56977777777');
    expect(text).not.toContain('carla@example.test');
    expect(text).not.toMatch(/"(id|customerId)"/);

    // en la BD: solo el hash del token, con vencimiento = fin de la reserva
    const { rows } = await owner.query(
      `SELECT t.token_hash, t.expires_at, t.scopes, r.source, r.end_at
         FROM reservation_access_tokens t JOIN reservations r ON r.id = t.reservation_id
        WHERE t.tenant_id = $1`,
      [b.tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].token_hash).toString('base64url')).not.toBe(res.body.manageToken);
    expect(rows[0].expires_at.getTime()).toBe(rows[0].end_at.getTime());
    expect(rows[0].source).toBe('public_web');
    expect(rows[0].scopes).toEqual(['view', 'cancel', 'reschedule']);
  });

  it('el navegador no decide precio, recurso no online, ni la empresa', async () => {
    const b = await business();
    const [first] = await slots(b);
    const internal = await book(b, { startAt: first, resourceId: b.internal.id });
    expect(internal.status).toBe(400);
    const priced = await book(b, { startAt: first, totalAmount: '1', tenantId: randomUUID() });
    expect(priced.status).toBe(201);
    expect(priced.body.reservation.totalAmount).toBe('15000.00');
    expect(priced.body.reservation.tenantSlug).toBe(b.slug);
  });

  it('respeta la antelación mínima de la empresa (el panel no la tiene, el portal sí)', async () => {
    const b = await business();
    await b.settings('booking_max_advance_days = 3');
    const res = await book(b, { startAt: (await slots(b))[0] ?? `${DAY}T13:00:00.000Z` });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('OUTSIDE_BOOKING_WINDOW');
  });

  it('idempotencia: misma clave => misma reserva y un enlace NUEVO (el anterior sigue valiendo)', async () => {
    const b = await business();
    const body = { startAt: (await slots(b))[0], customer: { firstName: 'X', phoneE164: phone() } };
    const key = randomUUID();
    const a = await book(b, body, key);
    const again = await book(b, body, key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.reservation.code).toBe(a.body.reservation.code);
    expect(again.body.manageToken).not.toBe(a.body.manageToken);
    for (const token of [a.body.manageToken, again.body.manageToken]) {
      expect((await manage('lookup', { token })).body.code).toBe(a.body.reservation.code);
    }
    const noKey = await http(app)
      .post(P(`/tenants/${b.slug}/reservations`))
      .send({ ...body, serviceId: b.svc.id, locationId: b.loc.id });
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    // el panel y el portal no comparten claves
    const { rows } = await owner.query(`SELECT scope FROM idempotency_keys WHERE tenant_id = $1`, [
      b.tenantId,
    ]);
    expect(rows.map((r) => r.scope)).toEqual(['public.reservation.create']);
  });

  it('anti-acaparamiento: máximo de reservas activas por teléfono', async () => {
    const b = await business();
    await b.settings('max_active_public_per_customer = 2');
    const tel = phone();
    const free = await slots(b);
    const customer = { firstName: 'Acaparador', phoneE164: tel };
    // una reserva hecha por el PERSONAL para el mismo teléfono no cuenta en el límite del portal
    const staff = await http(app)
      .post('/api/v1/reservations')
      .set(b.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ serviceId: b.svc.id, locationId: b.loc.id, startAt: free[12], customer });
    expect(staff.status).toBe(201);
    expect((await book(b, { startAt: free[0], customer })).status).toBe(201);
    expect((await book(b, { startAt: free[4], customer })).status).toBe(201);
    const third = await book(b, { startAt: free[8], customer });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('LIMIT_REACHED');
    expect(
      (await book(b, { startAt: free[8], customer: { firstName: 'Otra', phoneE164: phone() } }))
        .status,
    ).toBe(201);
  });

  it('10 reservas simultáneas por el mismo horario y profesional => exactamente 1', async () => {
    const b = await business();
    const [first] = await slots(b, b.ana.id);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => book(b, { startAt: first, resourceId: b.ana.id })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });
});

describe('reservas que requieren confirmación (retención)', () => {
  it('queda pendiente y retiene el horario; vencida, se libera al reservar y lo registra', async () => {
    const b = await business({ requiresConfirmation: true });
    const [first] = await slots(b, b.ana.id);
    const pending = await booked(b, { startAt: first, resourceId: b.ana.id });
    expect(pending.reservation.status).toBe('pending');
    const hold = new Date(pending.reservation.holdExpiresAt!).getTime();
    expect(hold - Date.now()).toBeGreaterThan(25 * 60_000);
    expect(hold - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(await slots(b, b.ana.id)).not.toContain(first);

    // vence la retención
    await owner.query(
      `UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(await slots(b, b.ana.id)).toContain(first); // la lectura ya la ignora
    const next = await booked(b, { startAt: first, resourceId: b.ana.id }); // la escritura la libera
    expect(next.reservation.status).toBe('pending');
    const old = await manage('lookup', { token: pending.manageToken });
    expect(old.body).toMatchObject({ status: 'cancelled', canCancel: false });
    const { rows } = await owner.query(
      `SELECT e.type, e.actor_type FROM reservation_events e JOIN reservations r ON r.id = e.reservation_id
        WHERE r.tenant_id = $1 AND r.code = $2 ORDER BY e.occurred_at`,
      [b.tenantId, pending.reservation.code],
    );
    expect(rows).toEqual([
      { type: 'created', actor_type: 'customer' },
      { type: 'expired', actor_type: 'system' },
    ]);
  });

  it('el barrido del worker libera las vencidas de todas las empresas y no toca las vigentes', async () => {
    const a = await business({ requiresConfirmation: true });
    const b = await business({ requiresConfirmation: true });
    const ra = await booked(a);
    const rb = await booked(b);
    const fresh = await booked(b, { startAt: (await slots(b))[2] });
    await owner.query(
      `UPDATE reservations SET hold_expires_at = now() - interval '1 minute'
        WHERE code = ANY($1) AND tenant_id = ANY($2)`,
      [
        [ra.reservation.code, rb.reservation.code],
        [a.tenantId, b.tenantId],
      ],
    );
    // El servicio del worker, armado con las piezas de esta app: compilar el WorkerModule en el MISMO proceso
    // que la API registraría ClsModule dos veces (en producción son procesos separados, ADR-002).
    const system = new SystemDb(app.get(AppConfig));
    const sweeper = new MaintenanceService(
      app.get(TenantDb),
      system,
      app.get(AuditService),
      app.get(LOGGER),
    );
    try {
      const result = await sweeper.expireHolds();
      expect(result.expired).toBeGreaterThanOrEqual(2);
      expect((await manage('lookup', { token: ra.manageToken })).body.status).toBe('cancelled');
      expect((await manage('lookup', { token: rb.manageToken })).body.status).toBe('cancelled');
      expect((await manage('lookup', { token: fresh.manageToken })).body.status).toBe('pending');
      expect((await sweeper.expireHolds()).expired).toBe(0); // idempotente
    } finally {
      await system.onModuleDestroy();
    }
  });

  it('el negocio confirma desde el panel antes de que venza', async () => {
    const b = await business({ requiresConfirmation: true });
    const r = await booked(b);
    const list = await b.c.get('/reservations?status=pending');
    const id = list.body.items[0].id;
    expect((await b.c.post(`/reservations/${id}/confirm`, { version: 1 })).status).toBe(200);
    const view = await manage('lookup', { token: r.manageToken });
    expect(view.body).toMatchObject({ status: 'confirmed', holdExpiresAt: null });
  });
});

describe('enlace de gestión', () => {
  it('token inválido, inventado o vencido: SIEMPRE la misma respuesta', async () => {
    const b = await business();
    const r = await booked(b);
    await owner.query(
      `UPDATE reservation_access_tokens SET expires_at = now() - interval '1 second' WHERE tenant_id = $1`,
      [b.tenantId],
    );
    const expired = await manage('lookup', { token: r.manageToken });
    const invented = await manage('lookup', { token: 'A'.repeat(43) });
    expect(expired.status).toBe(400);
    expect(invented.status).toBe(400);
    expect({ code: expired.body.code, detail: expired.body.detail }).toEqual({
      code: invented.body.code,
      detail: invented.body.detail,
    });
    expect(expired.body.code).toBe('LINK_INVALID');
    expect((await manage('lookup', { token: 'corto' })).status).toBe(400);
  });

  it('cancelar: libera el horario; repetir ya no se puede', async () => {
    const b = await business();
    const [first] = await slots(b, b.ana.id);
    const r = await booked(b, { startAt: first, resourceId: b.ana.id });
    const stale = await manage('cancel', { token: r.manageToken, version: 9 });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const ok = await manage('cancel', { token: r.manageToken, version: 1, reason: 'No puedo' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'cancelled', canCancel: false, canReschedule: false });
    expect(await slots(b, b.ana.id)).toContain(first);
    const again = await manage('cancel', { token: r.manageToken, version: 2 });
    expect(again.status).toBe(409);
    const { rows } = await owner.query(
      `SELECT cancelled_by_type, cancellation_reason FROM reservations WHERE tenant_id = $1`,
      [b.tenantId],
    );
    expect(rows[0]).toEqual({ cancelled_by_type: 'customer', cancellation_reason: 'No puedo' });
  });

  it('políticas: fuera de plazo, cancelación con aprobación y acciones desactivadas', async () => {
    const b = await business();
    const r = await booked(b);
    await b.settings('cancel_window_hours = 10000'); // ~416 días: ya estamos "dentro" del plazo
    let view = (await manage('lookup', { token: r.manageToken })).body;
    expect(view.canCancel).toBe(false);
    expect(view.policyNote).toContain('10000 h antes');
    const denied = await manage('cancel', { token: r.manageToken, version: 1 });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('POLICY_VIOLATION');

    await b.settings('cancel_window_hours = 24, cancel_requires_approval = true');
    view = (await manage('lookup', { token: r.manageToken })).body;
    expect(view).toMatchObject({
      canCancel: false,
      policyNote: 'Para cancelar, contacta al negocio.',
    });

    // Con el autoservicio de cancelación apagado, los enlaces NUEVOS no incluyen ese alcance.
    await b.settings(
      `cancel_requires_approval = false, self_service_actions = '{"cancel": false, "reschedule": true}'`,
    );
    const r2 = await booked(b, { startAt: (await slots(b))[3] });
    expect(r2.reservation.canCancel).toBe(false);
    const { rows } = await owner.query(
      `SELECT scopes FROM reservation_access_tokens WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [b.tenantId],
    );
    expect(rows[0].scopes).toEqual(['view', 'reschedule']);
  });

  it('cambiar de horario: mismo profesional, sin contarse a sí misma, con límite de cambios', async () => {
    const b = await business();
    await b.settings('max_reschedules = 1');
    const [first] = await slots(b, b.ana.id);
    const r = await booked(b, { startAt: first, resourceId: b.ana.id });

    const av = await manage('availability', { token: r.manageToken, from: DAY });
    expect(av.status).toBe(200);
    expect(av.body.resources.map((x: { resourceId: string }) => x.resourceId)).toEqual([b.ana.id]);
    const offered = av.body.resources[0].slots.map((s: { start: string }) => s.start);
    expect(offered).toContain(first); // su propio horario no cuenta como ocupado
    const target = offered[2];

    const moved = await manage('reschedule', { token: r.manageToken, version: 1, startAt: target });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ startAt: target, resourceName: 'Ana', version: 2 });
    expect(moved.body.canReschedule).toBe(false); // límite alcanzado
    expect(moved.body.policyNote).toContain('máximo de cambios');
    const { rows } = await owner.query(
      `SELECT t.expires_at, r.end_at FROM reservation_access_tokens t JOIN reservations r ON r.id = t.reservation_id
        WHERE t.tenant_id = $1`,
      [b.tenantId],
    );
    expect(rows[0].expires_at.getTime()).toBe(rows[0].end_at.getTime()); // el enlace vence con la reserva

    const second = await manage('reschedule', { token: r.manageToken, version: 2, startAt: first });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('POLICY_VIOLATION');
  });

  it('cambiar a un horario ocupado: 409 y la reserva no cambia', async () => {
    const b = await business();
    const free = await slots(b, b.ana.id);
    const r = await booked(b, { startAt: free[0], resourceId: b.ana.id });
    await booked(b, { startAt: free[8], resourceId: b.ana.id });
    const clash = await manage('reschedule', {
      token: r.manageToken,
      version: 1,
      startAt: free[8],
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
    expect((await manage('lookup', { token: r.manageToken })).body.startAt).toBe(free[0]);
  });
});

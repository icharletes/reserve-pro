import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReservationView } from '@reservepro/contracts';
import {
  type Client,
  client,
  hours,
  mkLocation,
  mkResource,
  mkService,
} from './catalog-helpers.js';
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

// Lunes 2027-07-05 en Santiago (invierno, UTC-4): 09:00 local = 13:00Z; cierre 18:00 = 22:00Z.
const DAY = '2027-07-05';
const Z = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const customer = { firstName: 'Carla', lastName: 'Pérez', phoneE164: '+56911111111' };

/** Empresa con una sucursal lun-vie 09-18, dos profesionales y un servicio de 60 min que ambos prestan. */
async function setup(serviceExtra: object = {}) {
  const t = await register(app);
  const c = client(app, t.auth);
  const loc = await mkLocation(c, 'Centro');
  await c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1, 2, 3, 4, 5]) });
  const ana = await mkResource(c, loc.id, 'Ana', { sortOrder: 1 });
  const beto = await mkResource(c, loc.id, 'Beto', { sortOrder: 2 });
  const svc = await mkService(c, 'Corte', { durationMinutes: 60, price: '15000', ...serviceExtra });
  expect((await c.put(`/services/${svc.id}/locations`, { locationIds: [loc.id] })).status).toBe(
    200,
  );
  expect(
    (await c.put(`/services/${svc.id}/resources`, { resourceIds: [ana.id, beto.id] })).status,
  ).toBe(200);
  return { ...t, c, loc, ana, beto, svc };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function book(s: Setup, body: object = {}, key: string = randomUUID()) {
  return http(app)
    .post('/api/v1/reservations')
    .set(s.auth)
    .set('Idempotency-Key', key)
    .send({ serviceId: s.svc.id, locationId: s.loc.id, startAt: Z('13:00'), customer, ...body });
}

async function booked(s: Setup, body: object = {}): Promise<ReservationView> {
  const res = await book(s, body);
  if (res.status !== 201) throw new Error(`book: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as ReservationView;
}

type Avail = { resources: { resourceId: string; slots: { start: string; end: string }[] }[] };
async function slotsOf(s: Setup, resourceId: string, c: Client = s.c): Promise<string[]> {
  const res = await c.get(`/availability?serviceId=${s.svc.id}&locationId=${s.loc.id}&from=${DAY}`);
  expect(res.status).toBe(200);
  return (res.body as Avail).resources
    .find((r) => r.resourceId === resourceId)!
    .slots.map((x) => x.start);
}

describe('disponibilidad', () => {
  it('horarios de la rejilla dentro del horario de atención, por recurso y en orden', async () => {
    const s = await setup();
    const res = await s.c.get(
      `/availability?serviceId=${s.svc.id}&locationId=${s.loc.id}&from=${DAY}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/Santiago');
    expect(res.body.stepMinutes).toBe(15);
    expect((res.body as Avail).resources.map((r) => r.resourceId)).toEqual([s.ana.id, s.beto.id]);
    const slots = await slotsOf(s, s.ana.id);
    expect(slots[0]).toBe(Z('13:00'));
    expect(slots.at(-1)).toBe(Z('21:00')); // 60 min antes del cierre (22:00Z)
    expect(slots).toHaveLength(33); // 09:00..17:00 cada 15 min
  });

  it('una reserva y un bloqueo quitan sus horarios; el resto sigue libre', async () => {
    const s = await setup();
    await booked(s, { resourceId: s.ana.id, startAt: Z('14:00') });
    await s.c.post('/blocks', {
      resourceIds: [s.ana.id],
      kind: 'break',
      startAt: Z('16:00'),
      endAt: Z('17:00'),
    });
    const slots = await slotsOf(s, s.ana.id);
    for (const gone of ['13:15', '14:00', '14:45', '15:15', '16:00', '16:45']) {
      expect(slots).not.toContain(Z(gone));
    }
    for (const free of ['13:00', '15:00', '17:00']) expect(slots).toContain(Z(free));
    expect(await slotsOf(s, s.beto.id)).toContain(Z('14:00'));
  });

  it('un servicio que no se ofrece en la sucursal da 400', async () => {
    const s = await setup();
    const other = await mkService(s.c, 'Sin sucursal');
    const res = await s.c.get(
      `/availability?serviceId=${other.id}&locationId=${s.loc.id}&from=${DAY}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('crear una reserva', () => {
  it('el servidor calcula fin y precio, guarda el snapshot y el calendario la muestra', async () => {
    const s = await setup();
    const r = await booked(s, { resourceId: s.ana.id, endAt: 'ignorado', totalAmount: '1' });
    expect(r).toMatchObject({
      status: 'confirmed',
      source: 'admin',
      startAt: Z('13:00'),
      endAt: Z('14:00'),
      totalAmount: '15000.00',
      currency: 'CLP',
      timeZone: 'America/Santiago',
      version: 1,
      customer: { firstName: 'Carla', phoneE164: '+56911111111' },
    });
    expect(r.code).toMatch(/^RP-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(r.items[0]).toMatchObject({
      serviceName: 'Corte',
      durationMinutes: 60,
      unitPrice: '15000.00',
    });
    expect(r.resources).toEqual([
      { resourceId: s.ana.id, occupyStart: Z('13:00'), occupyEnd: Z('14:00') },
    ]);

    const cal = await s.c.get(`/calendar?from=${DAY}&to=${DAY}`);
    const ana = cal.body.resources.find((x: { resourceId: string }) => x.resourceId === s.ana.id);
    expect(ana.reservations).toEqual([
      {
        id: r.id,
        code: r.code,
        status: 'confirmed',
        start: Z('13:00'),
        end: Z('14:00'),
        customerName: 'Carla Pérez',
        serviceName: 'Corte',
      },
    ]);
    const events = await s.c.get(`/reservations/${r.id}/events`);
    expect(events.body.map((e: { type: string }) => e.type)).toEqual(['created']);
    const outbox = await owner.query(
      `SELECT type, payload FROM outbox_events WHERE aggregate_id = $1`,
      [r.id],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].type).toBe('reservation.created');
    expect(JSON.stringify(outbox.rows[0].payload)).not.toContain('+569'); // sin datos personales
  });

  it('preparación y limpieza ocupan al recurso: no caben reservas que las pisen', async () => {
    const s = await setup({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    const r = await booked(s, { resourceId: s.ana.id, startAt: Z('14:00') });
    expect(r.resources[0]).toMatchObject({ occupyStart: Z('13:45'), occupyEnd: Z('15:15') });
    expect(r.endAt).toBe(Z('15:00'));
    expect((await book(s, { resourceId: s.ana.id, startAt: Z('15:00') })).status).toBe(409);
    expect((await book(s, { resourceId: s.ana.id, startAt: Z('15:30') })).status).toBe(201);
    // la preparación tampoco puede salirse del horario: 09:00 exacto empezaría a prepararse a las 08:45
    expect((await book(s, { resourceId: s.beto.id, startAt: Z('13:00') })).body.code).toBe(
      'SLOT_UNAVAILABLE',
    );
  });

  it('rechaza lo que no cabe, con el código de error adecuado', async () => {
    const s = await setup();
    const cases: [object, number, string][] = [
      [{ startAt: Z('12:00') }, 409, 'SLOT_UNAVAILABLE'], // antes de abrir
      [{ startAt: Z('21:30') }, 409, 'SLOT_UNAVAILABLE'], // terminaría después del cierre
      [{ startAt: Z('13:00', '2027-07-10') }, 409, 'SLOT_UNAVAILABLE'], // sábado
      [{ startAt: '2026-01-05T13:00:00.000Z' }, 422, 'OUTSIDE_BOOKING_WINDOW'], // pasado
      [{ startAt: '2028-07-03T13:00:00.000Z' }, 422, 'OUTSIDE_BOOKING_WINDOW'], // > 365 días
      [{ startAt: '2027-07-05T13:00:30.000Z' }, 400, 'VALIDATION_ERROR'], // con segundos
      [{ customer: { firstName: 'Sin contacto' } }, 400, 'VALIDATION_ERROR'],
      [{ customer: { id: randomUUID() } }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [body, status, code] of cases) {
      const res = await book(s, { resourceId: s.ana.id, ...body });
      expect([JSON.stringify(body), res.status, res.body.code]).toEqual([
        JSON.stringify(body),
        status,
        code,
      ]);
    }
    const otherLoc = await mkLocation(s.c, 'Norte');
    const outsider = await mkResource(s.c, otherLoc.id, 'Ajeno');
    expect((await book(s, { resourceId: outsider.id })).status).toBe(400);
    const notOffered = await mkService(s.c, 'No ofrecido');
    expect((await book(s, { serviceId: notOffered.id })).status).toBe(400);
  });

  it('el mismo teléfono reutiliza el cliente (sin sobrescribir su ficha)', async () => {
    const s = await setup();
    const a = await booked(s, { startAt: Z('13:00') });
    const b = await booked(s, {
      startAt: Z('15:00'),
      customer: { ...customer, firstName: 'Otro nombre' },
    });
    expect(b.customer.id).toBe(a.customer.id);
    expect(b.customer.firstName).toBe('Carla');
    const byId = await booked(s, { startAt: Z('17:00'), customer: { id: a.customer.id } });
    expect(byId.customer.id).toBe(a.customer.id);
  });
});

describe('asignación automática', () => {
  it('reparte entre los recursos libres y, cuando no queda ninguno, 409', async () => {
    const s = await setup();
    const first = await booked(s);
    const second = await booked(s, { customer: { ...customer, phoneE164: '+56922222222' } });
    expect(first.resources[0]!.resourceId).toBe(s.ana.id); // empate: menor sortOrder
    expect(second.resources[0]!.resourceId).toBe(s.beto.id);
    const third = await book(s, { customer: { ...customer, phoneE164: '+56933333333' } });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('SLOT_UNAVAILABLE');
  });

  it('elige el menos cargado del día; un recurso no auto-asignable solo se reserva a mano', async () => {
    const s = await setup();
    await booked(s, { resourceId: s.ana.id, startAt: Z('13:00') });
    await booked(s, { resourceId: s.ana.id, startAt: Z('14:00') });
    expect((await booked(s, { startAt: Z('16:00') })).resources[0]!.resourceId).toBe(s.beto.id);
    await s.c.patch(`/resources/${s.beto.id}`, { autoAssignable: false });
    expect((await booked(s, { startAt: Z('18:00') })).resources[0]!.resourceId).toBe(s.ana.id);
    expect((await booked(s, { resourceId: s.beto.id, startAt: Z('18:00') })).status).toBe(
      'confirmed',
    );
  });
});

describe('idempotencia', () => {
  it('misma clave y mismo cuerpo => la MISMA reserva; otro cuerpo => 422; sin clave => 400', async () => {
    const s = await setup();
    const key = randomUUID();
    const a = await book(s, { resourceId: s.ana.id }, key);
    const b = await book(s, { resourceId: s.ana.id }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    const other = await book(s, { resourceId: s.ana.id, startAt: Z('15:00') }, key);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const noKey = await http(app)
      .post('/api/v1/reservations')
      .set(s.auth)
      .send({ serviceId: s.svc.id, locationId: s.loc.id, startAt: Z('16:00'), customer });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await book(s, {}, 'corta')).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('un fallo no consume la clave: tras un 409 la misma clave puede reintentarse', async () => {
    const s = await setup();
    await booked(s, { resourceId: s.ana.id });
    const key = randomUUID();
    expect((await book(s, { resourceId: s.ana.id }, key)).status).toBe(409);
    expect((await book(s, { resourceId: s.ana.id }, key)).status).toBe(409); // no queda "en curso"
  });

  it('20 reintentos SIMULTÁNEOS con la misma clave crean UNA sola reserva', async () => {
    const s = await setup();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book(s, { resourceId: s.ana.id }, key)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM reservations WHERE tenant_id = $1`,
      [s.tenantId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('concurrencia (ARCHITECTURE.md §6.8)', () => {
  it('50 peticiones simultáneas por el MISMO horario y recurso => exactamente 1 reserva', async () => {
    const s = await setup();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        book(s, {
          resourceId: s.ana.id,
          customer: { firstName: `C${i}`, phoneE164: `+569${String(10_000_000 + i)}` },
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect(statuses.filter((x) => x === 409)).toHaveLength(49);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'SLOT_UNAVAILABLE'),
    ).toBe(true);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM reservation_resources WHERE tenant_id = $1 AND is_active`,
      [s.tenantId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('30 simultáneas con asignación automática y 2 recursos => exactamente 2 reservas, una por recurso', async () => {
    const s = await setup();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        book(s, { customer: { firstName: `C${i}`, phoneE164: `+569${String(20_000_000 + i)}` } }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(2);
    expect(new Set(ok.map((r) => r.body.resources[0].resourceId))).toEqual(
      new Set([s.ana.id, s.beto.id]),
    );
  });

  it('solapes parciales simultáneos (cada 15 min) en un recurso: nunca dos reservas que se pisen', async () => {
    const s = await setup();
    const starts = [
      '13:00',
      '13:15',
      '13:30',
      '13:45',
      '14:00',
      '14:15',
      '14:30',
      '14:45',
      '15:00',
    ];
    await Promise.all(
      starts.flatMap((t, i) =>
        [0, 1].map((j) =>
          book(s, {
            resourceId: s.ana.id,
            startAt: Z(t),
            customer: { firstName: 'X', phoneE164: `+569${String(30_000_000 + i * 2 + j)}` },
          }),
        ),
      ),
    );
    const { rows } = await owner.query(
      `SELECT occupy_start, occupy_end FROM reservation_resources
        WHERE tenant_id = $1 AND is_active ORDER BY occupy_start`,
      [s.tenantId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].occupy_start.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1].occupy_end.getTime(),
      );
    }
  });
});

describe('ciclo de vida', () => {
  it('confirmar, cancelar (libera el horario) y control de versión', async () => {
    const s = await setup();
    const r = await booked(s, { resourceId: s.ana.id });
    // admin => confirmada; confirmar de nuevo no es una transición válida
    const again = await s.c.post(`/reservations/${r.id}/confirm`, { version: 1 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');

    const stale = await s.c.post(`/reservations/${r.id}/cancel`, { version: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const cancelled = await s.c.post(`/reservations/${r.id}/cancel`, {
      version: 1,
      reason: 'Enfermo',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      version: 2,
      cancellationReason: 'Enfermo',
    });
    expect(cancelled.body.cancelledAt).toBeTruthy();
    // el horario queda libre de inmediato
    expect(await slotsOf(s, s.ana.id)).toContain(Z('13:00'));
    expect((await book(s, { resourceId: s.ana.id, customer: { id: r.customer.id } })).status).toBe(
      201,
    );
    // una cancelada es terminal
    expect((await s.c.post(`/reservations/${r.id}/cancel`, { version: 2 })).body.code).toBe(
      'INVALID_TRANSITION',
    );
    const types = (await s.c.get(`/reservations/${r.id}/events`)).body.map(
      (e: { type: string }) => e.type,
    );
    expect(types).toEqual(['created', 'cancelled']);
  });

  it('dos cambios simultáneos con la misma versión: gana uno, el otro recibe VERSION_CONFLICT', async () => {
    const s = await setup();
    const r = await booked(s, { resourceId: s.ana.id });
    const [a, b] = await Promise.all([
      s.c.post(`/reservations/${r.id}/cancel`, { version: 1 }),
      s.c.post(`/reservations/${r.id}/status`, { version: 1, status: 'in_progress' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('"no asistió" solo después de la hora de inicio; completar una confirmada sí', async () => {
    const s = await setup();
    const r = await booked(s, { resourceId: s.ana.id });
    const noShow = await s.c.post(`/reservations/${r.id}/status`, {
      version: 1,
      status: 'no_show',
    });
    expect(noShow.status).toBe(409);
    expect(noShow.body.code).toBe('INVALID_TRANSITION');
    const done = await s.c.post(`/reservations/${r.id}/status`, {
      version: 1,
      status: 'completed',
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    // una completada sigue ocupando su tiempo
    expect(await slotsOf(s, s.ana.id)).not.toContain(Z('13:00'));
  });

  it('reprogramar: mueve horario y recurso, conserva duración y precio, y no pisa otras reservas', async () => {
    const s = await setup();
    const r = await booked(s, { resourceId: s.ana.id });
    await booked(s, { resourceId: s.ana.id, startAt: Z('16:00'), customer: { id: r.customer.id } });
    // el servicio cambia después de reservar: la reserva conserva lo reservado
    await s.c.patch(`/services/${s.svc.id}`, { durationMinutes: 90, price: '99000' });

    const clash = await s.c.post(`/reservations/${r.id}/reschedule`, {
      version: 1,
      startAt: Z('15:30'),
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');
    // a su propio horario solapado consigo misma sí puede moverse (se excluye a sí misma)
    const self = await s.c.post(`/reservations/${r.id}/reschedule`, {
      version: 1,
      startAt: Z('13:30'),
    });
    expect(self.status).toBe(200);
    expect(self.body).toMatchObject({
      startAt: Z('13:30'),
      endAt: Z('14:30'),
      totalAmount: '15000.00',
      rescheduleCount: 1,
      version: 2,
    });

    const moved = await s.c.post(`/reservations/${r.id}/reschedule`, {
      version: 2,
      startAt: Z('16:00'),
      resourceId: s.beto.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.resources[0]).toEqual({
      resourceId: s.beto.id,
      occupyStart: Z('16:00'),
      occupyEnd: Z('17:00'),
    });
    expect(await slotsOf(s, s.ana.id)).toContain(Z('13:30'));
    const types = (await s.c.get(`/reservations/${r.id}/events`)).body.map(
      (e: { type: string }) => e.type,
    );
    expect(types).toEqual(['created', 'rescheduled', 'rescheduled']);

    await s.c.post(`/reservations/${r.id}/cancel`, { version: 3 });
    expect(
      (await s.c.post(`/reservations/${r.id}/reschedule`, { version: 4, startAt: Z('19:00') })).body
        .code,
    ).toBe('INVALID_TRANSITION');
  });

  it('listado ordenado por inicio, con filtros y cursor', async () => {
    const s = await setup();
    const times = ['17:00', '13:00', '15:00'];
    for (const t of times) await booked(s, { resourceId: s.ana.id, startAt: Z(t) });
    await booked(s, { resourceId: s.beto.id, startAt: Z('14:00') });
    const p1 = await s.c.get(`/reservations?limit=2&resourceId=${s.ana.id}`);
    expect(p1.body.items.map((r: ReservationView) => r.startAt)).toEqual([Z('13:00'), Z('15:00')]);
    const p2 = await s.c.get(
      `/reservations?limit=2&resourceId=${s.ana.id}&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items.map((r: ReservationView) => r.startAt)).toEqual([Z('17:00')]);
    expect(p2.body.nextCursor).toBeNull();
    const ranged = await s.c.get(`/reservations?from=${Z('14:00')}&to=${Z('16:00')}`);
    expect(ranged.body.items.map((r: ReservationView) => r.startAt)).toEqual([
      Z('14:00'),
      Z('15:00'),
    ]);
    expect((await s.c.get('/reservations?cursor=basura')).status).toBe(400);
  });
});

describe('agenda vs reservas (ADR-013)', () => {
  it('un bloqueo no puede pisar una reserva; desactivar o borrar un recurso con reservas tampoco', async () => {
    const s = await setup();
    await booked(s, { resourceId: s.ana.id });
    const block = await s.c.post('/blocks', {
      resourceIds: [s.ana.id, s.beto.id],
      kind: 'time_off',
      startAt: Z('13:30'),
      endAt: Z('15:00'),
    });
    expect(block.status).toBe(409);
    expect(block.body.code).toBe('HAS_RESERVATIONS');
    // atómico: tampoco se creó el de Beto
    expect((await s.c.get(`/blocks?resourceId=${s.beto.id}`)).body.items).toHaveLength(0);
    // moverlo encima de la reserva tampoco
    const ok = await s.c.post('/blocks', {
      resourceIds: [s.ana.id],
      kind: 'break',
      startAt: Z('15:00'),
      endAt: Z('16:00'),
    });
    expect(ok.status).toBe(201);
    expect((await s.c.patch(`/blocks/${ok.body[0].id}`, { startAt: Z('13:45') })).body.code).toBe(
      'HAS_RESERVATIONS',
    );

    const deactivate = await s.c.patch(`/resources/${s.ana.id}`, { isActive: false });
    expect(deactivate.status).toBe(409);
    expect(deactivate.body.code).toBe('HAS_RESERVATIONS');
    expect((await s.c.patch(`/locations/${s.loc.id}`, { isActive: false })).body.code).toBe(
      'HAS_RESERVATIONS',
    );
    const del = await s.c.del(`/resources/${s.ana.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('IN_USE');
    // Beto no tiene reservas: sí se puede desactivar
    expect((await s.c.patch(`/resources/${s.beto.id}`, { isActive: false })).status).toBe(200);
  });
});

describe('aislamiento y permisos', () => {
  it('otra empresa no ve ni usa las reservas, servicios ni clientes ajenos', async () => {
    const a = await setup();
    const r = await booked(a, { resourceId: a.ana.id });
    const b = await setup();
    expect((await b.c.get(`/reservations/${r.id}`)).status).toBe(404);
    expect((await b.c.post(`/reservations/${r.id}/cancel`, { version: 1 })).status).toBe(404);
    expect((await b.c.get(`/customers/${r.customer.id}`)).status).toBe(404);
    expect((await b.c.get('/reservations')).body.items).toHaveLength(0);
    expect((await book(b, { serviceId: a.svc.id, locationId: a.loc.id })).status).toBe(404);
    expect((await book(b, { customer: { id: r.customer.id } })).status).toBe(400);
  });

  it('un profesional solo ve y gestiona las reservas de SU recurso, y no puede crear', async () => {
    const s = await setup();
    const pro = await joinTenant(app, owner, s.tenantId, 'professional');
    await s.c.patch(`/resources/${s.ana.id}`, { membershipId: pro.membershipId });
    const mine = await booked(s, { resourceId: s.ana.id });
    const theirs = await booked(s, { resourceId: s.beto.id });
    const p = client(app, pro.auth);
    expect((await p.get('/reservations')).body.items.map((x: ReservationView) => x.id)).toEqual([
      mine.id,
    ]);
    expect((await p.get(`/reservations/${theirs.id}`)).status).toBe(404);
    expect(
      (await p.post(`/reservations/${theirs.id}/status`, { version: 1, status: 'in_progress' }))
        .status,
    ).toBe(404);
    expect(
      (await p.post(`/reservations/${mine.id}/status`, { version: 1, status: 'in_progress' }))
        .status,
    ).toBe(200);
    expect((await p.post(`/reservations/${mine.id}/cancel`, { version: 2 })).status).toBe(403);
    const create = await http(app)
      .post('/api/v1/reservations')
      .set(pro.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ serviceId: s.svc.id, locationId: s.loc.id, startAt: Z('15:00'), customer });
    expect(create.status).toBe(403);
  });
});

describe('clientes', () => {
  it('crear, buscar, editar; teléfono único por empresa; siempre contactable', async () => {
    const s = await setup();
    const c1 = await s.c.post('/customers', {
      firstName: 'Lucía',
      lastName: 'Rojas',
      phoneE164: '+56944444444',
    });
    expect(c1.status).toBe(201);
    expect(
      (await s.c.post('/customers', { firstName: 'Otra', phoneE164: '+56944444444' })).body.code,
    ).toBe('DUPLICATE');
    await s.c.post('/customers', { firstName: 'Mario', email: 'mario@example.test' });
    expect(
      (await s.c.get('/customers?q=lucía')).body.items.map((x: { id: string }) => x.id),
    ).toEqual([c1.body.id]);
    expect((await s.c.get('/customers?q=4444')).body.items).toHaveLength(1);
    expect((await s.c.get('/customers?q=MARIO@')).body.items).toHaveLength(1);
    const edited = await s.c.patch(`/customers/${c1.body.id}`, {
      lastName: null,
      email: 'lucia@example.test',
    });
    expect(edited.body).toMatchObject({
      firstName: 'Lucía',
      lastName: null,
      phoneE164: '+56944444444',
      email: 'lucia@example.test',
    });
    expect(
      (await s.c.patch(`/customers/${c1.body.id}`, { phoneE164: null, email: null })).status,
    ).toBe(400);
    // otra empresa puede tener el mismo teléfono
    const other = await setup();
    expect(
      (await other.c.post('/customers', { firstName: 'Lucía', phoneE164: '+56944444444' })).status,
    ).toBe(201);
  });
});

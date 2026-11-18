import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, hours, mkLocation, mkResource } from './catalog-helpers.js';
import { createTestApp, joinTenant, ownerPool, register } from './helpers.js';

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
  const r = await register(app); // empresa en America/Santiago
  return { ...r, c: client(app, r.auth) };
}
const cal = (c: ReturnType<typeof client>, q: string) => c.get(`/calendar?${q}`);
type Cal = {
  resources: {
    resourceId: string;
    timezone: string;
    working: { start: string; end: string }[];
    blocks: { id: string; start: string }[];
  }[];
};
const range = (r: { start: string; end: string }) => [r.start, r.end];

/** Sucursal abierta lun-vie 09-18 con un recurso. */
async function setup(c: ReturnType<typeof client>, locExtra: object = {}) {
  const loc = await mkLocation(c, 'Centro', locExtra);
  await c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1, 2, 3, 4, 5]) });
  const res = await mkResource(c, loc.id, 'Ana');
  return { loc, res };
}

describe('rangos de trabajo (horario semanal + zona horaria)', () => {
  it('lunes a viernes 09-18 en Santiago en invierno (UTC-4): 13:00Z a 22:00Z; sin fines de semana', async () => {
    const { c } = await tenant();
    const { res } = await setup(c);
    const body = (await cal(c, 'from=2027-07-05&to=2027-07-11')).body as Cal;
    const r = body.resources.find((x) => x.resourceId === res.id)!;
    expect(r.timezone).toBe('America/Santiago');
    expect(r.working).toHaveLength(5);
    expect(range(r.working[0]!)).toEqual(['2027-07-05T13:00:00.000Z', '2027-07-05T22:00:00.000Z']);
    expect(range(r.working[4]!)).toEqual(['2027-07-09T13:00:00.000Z', '2027-07-09T22:00:00.000Z']);
  });

  it('en verano (UTC-3) el mismo horario cae una hora antes en UTC', async () => {
    const { c } = await tenant();
    const { res } = await setup(c);
    const r = ((await cal(c, 'from=2027-01-04&to=2027-01-04')).body as Cal).resources.find(
      (x) => x.resourceId === res.id,
    )!;
    expect(range(r.working[0]!)).toEqual(['2027-01-04T12:00:00.000Z', '2027-01-04T21:00:00.000Z']);
  });

  it('una sucursal con zona horaria propia usa ESA zona', async () => {
    const { c } = await tenant();
    const { res } = await setup(c, { name: 'Nueva York', timezone: 'America/New_York' });
    const r = ((await cal(c, 'from=2027-01-04&to=2027-01-04')).body as Cal).resources.find(
      (x) => x.resourceId === res.id,
    )!;
    expect(r.timezone).toBe('America/New_York');
    expect(range(r.working[0]!)).toEqual(['2027-01-04T14:00:00.000Z', '2027-01-04T23:00:00.000Z']); // EST = UTC-5
  });

  it('cambio de hora de Santiago (2027-09-05 00:00 -> 01:00): el día completo dura 23 horas reales', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c, 'Abierta 24h');
    await c.put(`/locations/${loc.id}/business-hours`, {
      intervals: hours([1, 2, 3, 4, 5, 6, 7], '00:00', '24:00'),
    });
    const res = await mkResource(c, loc.id);
    const r = ((await cal(c, 'from=2027-09-05&to=2027-09-05')).body as Cal).resources.find(
      (x) => x.resourceId === res.id,
    )!;
    expect(r.working).toHaveLength(1);
    const ms = Date.parse(r.working[0]!.end) - Date.parse(r.working[0]!.start);
    expect(ms / 3_600_000).toBe(23);
  });
});

describe('excepciones, feriados y horario del recurso', () => {
  it('un feriado cierra el día; una excepción de la sucursal lo abre de nuevo', async () => {
    const { c } = await tenant();
    const { loc, res } = await setup(c);
    await c.put('/holidays/2027-07-06', { name: 'Feriado de prueba' }); // martes
    const get = async () =>
      ((await cal(c, 'from=2027-07-05&to=2027-07-07')).body as Cal).resources.find(
        (x) => x.resourceId === res.id,
      )!.working;
    expect((await get()).map((w) => w.start.slice(0, 10))).toEqual(['2027-07-05', '2027-07-07']); // sin el martes
    await c.put(`/locations/${loc.id}/overrides/2027-07-06`, {
      closed: false,
      intervals: [{ start: '10:00', end: '12:00' }],
    });
    const days = await get();
    expect(days).toHaveLength(3);
    expect(range(days[1]!)).toEqual(['2027-07-06T14:00:00.000Z', '2027-07-06T16:00:00.000Z']);
  });

  it('una excepción cerrada de la sucursal quita el día; una de apertura especial abre un sábado', async () => {
    const { c } = await tenant();
    const { loc, res } = await setup(c);
    await c.put(`/locations/${loc.id}/overrides/2027-07-07`, { closed: true });
    await c.put(`/locations/${loc.id}/overrides/2027-07-10`, {
      closed: false,
      intervals: [{ start: '10:00', end: '13:00' }],
    });
    const w = ((await cal(c, 'from=2027-07-05&to=2027-07-11')).body as Cal).resources.find(
      (x) => x.resourceId === res.id,
    )!.working;
    const days = w.map((x) => x.start.slice(0, 10));
    expect(days).not.toContain('2027-07-07');
    expect(days).toContain('2027-07-10');
  });

  it('el horario propio del recurso se INTERSECTA con el de la sucursal; sin él, sigue a la sucursal', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c, 'Centro');
    await c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1, 2, 3, 4, 5]) });
    const free = await mkResource(c, loc.id, 'Libre'); // sin horario propio
    const part = await mkResource(c, loc.id, 'Parcial');
    await c.put(`/resources/${part.id}/schedule`, {
      intervals: [{ weekday: 1, start: '08:00', end: '12:00' }],
    });
    const body = (await cal(c, 'from=2027-07-05&to=2027-07-09')).body as Cal;
    expect(body.resources.find((x) => x.resourceId === free.id)!.working).toHaveLength(5);
    const p = body.resources.find((x) => x.resourceId === part.id)!.working;
    expect(p).toHaveLength(1);
    expect(range(p[0]!)).toEqual(['2027-07-05T13:00:00.000Z', '2027-07-05T16:00:00.000Z']); // 08-12 ∩ 09-18 = 09-12
  });

  it('la excepción de un recurso le da el día libre sin afectar a los demás', async () => {
    const { c } = await tenant();
    const { loc, res } = await setup(c);
    const other = await mkResource(c, loc.id, 'Otra');
    await c.put(`/resources/${res.id}/overrides/2027-07-05`, { closed: true });
    const body = (await cal(c, 'from=2027-07-05&to=2027-07-05')).body as Cal;
    expect(body.resources.find((x) => x.resourceId === res.id)!.working).toEqual([]);
    expect(body.resources.find((x) => x.resourceId === other.id)!.working).toHaveLength(1);
  });
});

describe('bloqueos, recursos activos y filtros', () => {
  it('incluye los bloqueos que caen en el rango y excluye los de fuera', async () => {
    const { c } = await tenant();
    const { res } = await setup(c);
    const inside = (
      await c.post('/blocks', {
        resourceIds: [res.id],
        startAt: '2027-07-07T12:00:00Z',
        endAt: '2027-07-07T16:00:00Z',
        kind: 'time_off',
      })
    ).body[0];
    await c.post('/blocks', {
      resourceIds: [res.id],
      startAt: '2027-08-10T12:00:00Z',
      endAt: '2027-08-10T16:00:00Z',
    });
    await c.post('/blocks', {
      resourceIds: [res.id],
      startAt: '2027-06-01T12:00:00Z',
      endAt: '2027-06-02T16:00:00Z',
    });
    const r = ((await cal(c, 'from=2027-07-05&to=2027-07-11')).body as Cal).resources.find(
      (x) => x.resourceId === res.id,
    )!;
    expect(r.blocks.map((b) => b.id)).toEqual([inside.id]);
  });

  it('solo recursos activos; una sucursal desactivada deja a sus recursos sin tiempo de trabajo', async () => {
    const { c } = await tenant();
    const { loc, res } = await setup(c);
    const gone = await mkResource(c, loc.id, 'Inactiva');
    await c.patch(`/resources/${gone.id}`, { isActive: false });
    let body = (await cal(c, 'from=2027-07-05&to=2027-07-05')).body as Cal;
    expect(body.resources.map((x) => x.resourceId)).toEqual([res.id]);
    await c.patch(`/locations/${loc.id}`, { isActive: false });
    body = (await cal(c, 'from=2027-07-05&to=2027-07-05')).body as Cal;
    expect(body.resources[0]!.working).toEqual([]);
  });

  it('filtra por sucursal y por recurso; un recurso inexistente da 404', async () => {
    const { c } = await tenant();
    const a = await setup(c);
    const l2 = await mkLocation(c, 'Otra');
    const r2 = await mkResource(c, l2.id, 'Beto');
    expect(
      (
        (await cal(c, `from=2027-07-05&to=2027-07-05&locationId=${l2.id}`)).body as Cal
      ).resources.map((x) => x.resourceId),
    ).toEqual([r2.id]);
    expect(
      ((await cal(c, `from=2027-07-05&to=2027-07-05&resourceId=${a.res.id}`)).body as Cal)
        .resources,
    ).toHaveLength(1);
    expect(
      (
        await cal(
          c,
          'from=2027-07-05&to=2027-07-05&resourceId=0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f60',
        )
      ).status,
    ).toBe(404);
  });

  it('valida el rango: máximo 31 días, orden y fechas reales', async () => {
    const { c } = await tenant();
    expect((await cal(c, 'from=2027-07-01&to=2027-07-31')).status).toBe(200); // 31 días: permitido
    expect((await cal(c, 'from=2027-07-01&to=2027-08-01')).status).toBe(400); // 32 días
    expect((await cal(c, 'from=2027-07-10&to=2027-07-01')).status).toBe(400);
    expect((await cal(c, 'from=2027-02-30&to=2027-03-01')).status).toBe(400);
    expect((await cal(c, 'from=2027-07-01')).status).toBe(400);
  });
});

describe('permisos y aislamiento del calendario', () => {
  it('calendar:read ve todo; solo calendar:read:own ve únicamente SU agenda', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    await o.c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1, 2, 3, 4, 5]) });
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    const mine = await mkResource(o.c, loc.id, 'Mi agenda', { membershipId: pro.membershipId });
    const others = await mkResource(o.c, loc.id, 'Agenda ajena');
    const rec = client(app, (await joinTenant(app, owner, o.tenantId, 'receptionist')).auth);
    const pc = client(app, pro.auth);

    const q = 'from=2027-07-05&to=2027-07-05';
    expect(((await cal(rec, q)).body as Cal).resources).toHaveLength(2); // recepción ve todo
    expect(((await cal(pc, q)).body as Cal).resources.map((r) => r.resourceId)).toEqual([mine.id]); // profesional solo la suya
    expect((await cal(pc, `${q}&resourceId=${others.id}`)).status).toBe(404); // la ajena ni siquiera "existe" para él
    expect((await cal(pc, `${q}&resourceId=${mine.id}`)).status).toBe(200);
  });

  it('un profesional sin recurso vinculado ve un calendario vacío', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    await mkResource(o.c, loc.id);
    const pro = client(app, (await joinTenant(app, owner, o.tenantId, 'professional')).auth);
    expect(((await cal(pro, 'from=2027-07-05&to=2027-07-05')).body as Cal).resources).toEqual([]);
  });

  it('exige sesión y cada empresa ve solo su calendario', async () => {
    const a = await tenant();
    const b = await tenant();
    await setup(a.c);
    expect(((await cal(b.c, 'from=2027-07-05&to=2027-07-05')).body as Cal).resources).toEqual([]);
    const anon = await import('./helpers.js').then((h) =>
      h.http(app).get('/api/v1/calendar?from=2027-07-05&to=2027-07-05'),
    );
    expect(anon.status).toBe(401);
  });
});

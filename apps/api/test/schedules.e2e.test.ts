import { randomUUID } from 'node:crypto';
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
  const r = await register(app);
  return { ...r, c: client(app, r.auth) };
}

describe('horario semanal de la sucursal', () => {
  it('una sucursal nueva no tiene horario; el PUT reemplaza TODO y devuelve ordenado', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    expect((await c.get(`/locations/${loc.id}/business-hours`)).body.intervals).toEqual([]);

    const put = await c.put(`/locations/${loc.id}/business-hours`, {
      intervals: [
        { weekday: 3, start: '09:00', end: '13:00' },
        { weekday: 1, start: '14:00', end: '18:00' },
        { weekday: 1, start: '09:00', end: '13:00' },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.intervals).toEqual([
      { weekday: 1, start: '09:00', end: '13:00' },
      { weekday: 1, start: '14:00', end: '18:00' },
      { weekday: 3, start: '09:00', end: '13:00' },
    ]);
    // reemplazar con otro conjunto borra lo anterior; vacío = cerrada siempre
    await c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([5]) });
    expect((await c.get(`/locations/${loc.id}/business-hours`)).body.intervals).toHaveLength(1);
    await c.put(`/locations/${loc.id}/business-hours`, { intervals: [] });
    expect((await c.get(`/locations/${loc.id}/business-hours`)).body.intervals).toEqual([]);
  });

  it('rechaza tramos que se pisan indicando cuál, pero acepta los que se tocan y el cierre a las 24:00', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const overlap = await c.put(`/locations/${loc.id}/business-hours`, {
      intervals: [
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 1, start: '12:00', end: '15:00' },
      ],
    });
    expect(overlap.status).toBe(400);
    expect(overlap.body.errors[0].path).toBe('intervals.1');
    expect((await c.get(`/locations/${loc.id}/business-hours`)).body.intervals).toEqual([]); // no cambió nada

    const touching = await c.put(`/locations/${loc.id}/business-hours`, {
      intervals: [
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 1, start: '13:00', end: '24:00' },
      ],
    });
    expect(touching.status).toBe(200);
  });

  it('valida horas, días y tamaño', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const put = (intervals: object[]) =>
      c.put(`/locations/${loc.id}/business-hours`, { intervals });
    expect((await put([{ weekday: 1, start: '18:00', end: '09:00' }])).status).toBe(400); // invertido
    expect((await put([{ weekday: 1, start: '09:00', end: '09:00' }])).status).toBe(400); // vacío
    expect((await put([{ weekday: 0, start: '09:00', end: '18:00' }])).status).toBe(400); // ISO: 1..7
    expect((await put([{ weekday: 8, start: '09:00', end: '18:00' }])).status).toBe(400);
    expect((await put([{ weekday: 1, start: '9:00', end: '18:00' }])).status).toBe(400); // formato
    expect((await put([{ weekday: 1, start: '09:00', end: '24:01' }])).status).toBe(400);
    expect(
      (await put(Array.from({ length: 71 }, () => ({ weekday: 1, start: '09:00', end: '10:00' }))))
        .status,
    ).toBe(400);
  });

  it('dos administradores editando a la vez: nunca error 500 ni un horario mezclado', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const variants = Array.from({ length: 10 }, (_, i) => [
      { weekday: 1, start: '08:00', end: `${String(9 + (i % 5)).padStart(2, '0')}:00` },
      { weekday: 2, start: '10:00', end: '12:00' },
      { weekday: 3, start: '14:00', end: `${String(15 + (i % 4)).padStart(2, '0')}:00` },
    ]);
    const results = await Promise.all(
      variants.map((intervals) => c.put(`/locations/${loc.id}/business-hours`, { intervals })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = (await c.get(`/locations/${loc.id}/business-hours`)).body.intervals;
    expect(final).toHaveLength(3); // exactamente UNA de las variantes completa, no una mezcla
    expect(
      variants.some(
        (v) =>
          JSON.stringify([...v].sort((a, b) => a.weekday - b.weekday)) === JSON.stringify(final),
      ),
    ).toBe(true);
  });

  it('recepción puede ver el horario pero no cambiarlo; queda auditado', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    const rec = client(app, (await joinTenant(app, owner, o.tenantId, 'receptionist')).auth);
    expect((await rec.get(`/locations/${loc.id}/business-hours`)).status).toBe(200);
    expect(
      (await rec.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1]) })).status,
    ).toBe(403);
    await o.c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1]) });
    const log = await o.c.get(`/tenants/current/audit-logs?action=business_hours.updated`);
    expect(log.body.items[0].after.intervals).toHaveLength(1);
  });
});

describe('horario semanal del recurso (con vigencia)', () => {
  it('sin horario propio devuelve vacío; acepta vigencias y las devuelve', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const r = await mkResource(c, loc.id);
    expect((await c.get(`/resources/${r.id}/schedule`)).body.intervals).toEqual([]);
    const put = await c.put(`/resources/${r.id}/schedule`, {
      intervals: [
        {
          weekday: 1,
          start: '09:00',
          end: '14:00',
          validFrom: '2027-01-01',
          validTo: '2027-03-31',
        },
        { weekday: 1, start: '10:00', end: '16:00', validFrom: '2027-04-01' },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.intervals).toEqual([
      { weekday: 1, start: '09:00', end: '14:00', validFrom: '2027-01-01', validTo: '2027-03-31' },
      { weekday: 1, start: '10:00', end: '16:00', validFrom: '2027-04-01', validTo: null },
    ]);
  });

  it('rechaza vigencias que se pisan con horas que se pisan, y vigencias invertidas', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const r = await mkResource(c, loc.id);
    const put = (intervals: object[]) => c.put(`/resources/${r.id}/schedule`, { intervals });
    const clash = await put([
      { weekday: 1, start: '09:00', end: '14:00', validFrom: '2027-01-01', validTo: '2027-06-30' },
      { weekday: 1, start: '13:00', end: '17:00', validFrom: '2027-06-30' }, // comparten el 30-jun (inclusivo)
    ]);
    expect(clash.status).toBe(400);
    expect(clash.body.errors[0].path).toBe('intervals.1');
    expect(
      (
        await put([
          {
            weekday: 1,
            start: '09:00',
            end: '14:00',
            validFrom: '2027-06-01',
            validTo: '2027-05-01',
          },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await put([
          { weekday: 1, start: '09:00', end: '14:00' },
          { weekday: 1, start: '10:00', end: '12:00' },
        ])
      ).status,
    ).toBe(400); // ambos sin vigencia
    expect(
      (await put([{ weekday: 1, start: '09:00', end: '14:00', validFrom: '2027-02-30' }])).status,
    ).toBe(400); // fecha inexistente
  });

  it('un recurso ajeno da 404', async () => {
    const a = await tenant();
    const b = await tenant();
    const loc = await mkLocation(a.c);
    const r = await mkResource(a.c, loc.id);
    expect((await b.c.get(`/resources/${r.id}/schedule`)).status).toBe(404);
    expect((await b.c.put(`/resources/${r.id}/schedule`, { intervals: [] })).status).toBe(404);
  });
});

describe('excepciones por fecha', () => {
  it('cierra un día, abre tramos especiales, reemplaza y elimina (sucursal)', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const day = (d: string) => `/locations/${loc.id}/overrides/${d}`;

    const closed = await c.put(day('2027-12-25'), { closed: true, reason: 'Navidad' });
    expect(closed.body).toEqual({
      date: '2027-12-25',
      closed: true,
      intervals: [],
      reason: 'Navidad',
    });

    const special = await c.put(day('2027-12-24'), {
      closed: false,
      intervals: [
        { start: '09:00', end: '13:00' },
        { start: '15:00', end: '18:00' },
      ],
    });
    expect(special.body.intervals).toHaveLength(2);

    // reemplazar cerrado -> abierto (misma fecha)
    const reopen = await c.put(day('2027-12-25'), {
      closed: false,
      intervals: [{ start: '10:00', end: '12:00' }],
    });
    expect(reopen.body).toMatchObject({
      closed: false,
      intervals: [{ start: '10:00', end: '12:00' }],
    });

    const list = await c.get(`/locations/${loc.id}/overrides?from=2027-12-01&to=2027-12-31`);
    expect(list.body.map((o: { date: string }) => o.date)).toEqual(['2027-12-24', '2027-12-25']);
    expect(
      (await c.get(`/locations/${loc.id}/overrides?from=2028-01-01&to=2028-01-31`)).body,
    ).toEqual([]);

    expect((await c.del(day('2027-12-24'))).status).toBe(204);
    expect((await c.del(day('2027-12-24'))).status).toBe(404);
  });

  it('valida: cerrado sin tramos, abierto con al menos uno, sin solapes y con fecha real', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const put = (d: string, body: object) => c.put(`/locations/${loc.id}/overrides/${d}`, body);
    expect(
      (await put('2027-12-25', { closed: true, intervals: [{ start: '09:00', end: '10:00' }] }))
        .status,
    ).toBe(400);
    expect((await put('2027-12-25', { closed: false, intervals: [] })).status).toBe(400);
    expect(
      (
        await put('2027-12-25', {
          closed: false,
          intervals: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '14:00' },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await put('2027-13-40', { closed: true })).status).toBe(400);
    expect((await put('no-es-fecha', { closed: true })).status).toBe(400);
    expect(
      (await c.get(`/locations/${loc.id}/overrides?from=2027-12-31&to=2027-12-01`)).status,
    ).toBe(400);
  });

  it('excepciones de un recurso, independientes de las de la sucursal', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const r = await mkResource(c, loc.id);
    await c.put(`/locations/${loc.id}/overrides/2027-07-10`, { closed: true });
    const res = await c.put(`/resources/${r.id}/overrides/2027-07-10`, {
      closed: false,
      intervals: [{ start: '10:00', end: '12:00' }],
    });
    expect(res.status).toBe(200);
    expect(
      (await c.get(`/resources/${r.id}/overrides?from=2027-07-01&to=2027-07-31`)).body,
    ).toHaveLength(1);
    expect(
      (await c.get(`/locations/${loc.id}/overrides?from=2027-07-01&to=2027-07-31`)).body[0].closed,
    ).toBe(true);
  });

  it('no se pueden tocar las excepciones de otra empresa', async () => {
    const a = await tenant();
    const b = await tenant();
    const loc = await mkLocation(a.c);
    expect(
      (await b.c.put(`/locations/${loc.id}/overrides/2027-12-25`, { closed: true })).status,
    ).toBe(404);
    expect(
      (await b.c.get(`/locations/${loc.id}/overrides?from=2027-12-01&to=2027-12-31`)).status,
    ).toBe(404);
  });
});

describe('feriados', () => {
  it('crea, renombra, lista por año y elimina', async () => {
    const { c } = await tenant();
    expect((await c.put('/holidays/2027-09-18', { name: 'Fiestas Patrias' })).body).toEqual({
      date: '2027-09-18',
      name: 'Fiestas Patrias',
    });
    expect((await c.put('/holidays/2027-09-18', { name: 'Independencia' })).body.name).toBe(
      'Independencia',
    ); // upsert
    await c.put('/holidays/2027-09-19', { name: 'Glorias del Ejército' });
    await c.put('/holidays/2028-01-01', { name: 'Año Nuevo' });
    expect((await c.get('/holidays?year=2027')).body.map((h: { date: string }) => h.date)).toEqual([
      '2027-09-18',
      '2027-09-19',
    ]);
    expect((await c.del('/holidays/2027-09-18')).status).toBe(204);
    expect((await c.del('/holidays/2027-09-18')).status).toBe(404);
    expect((await c.get('/holidays?year=1900')).status).toBe(400);
    expect((await c.put('/holidays/2027-02-30', { name: 'Imposible' })).status).toBe(400);
  });
  it('cada empresa tiene sus feriados', async () => {
    const a = await tenant();
    const b = await tenant();
    await a.c.put('/holidays/2027-09-18', { name: 'Solo A' });
    expect((await b.c.get('/holidays?year=2027')).body).toEqual([]);
    expect((await b.c.del('/holidays/2027-09-18')).status).toBe(404);
  });
});

describe('bloqueos', () => {
  const T = { startAt: '2027-02-01T12:00:00Z', endAt: '2027-02-03T12:00:00Z' };

  it('bloquea varios recursos a la vez, de forma atómica', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    const r1 = await mkResource(o.c, loc.id, 'Ana');
    const r2 = await mkResource(o.c, loc.id, 'Beto');
    const ok = await o.c.post('/blocks', {
      resourceIds: [r1.id, r2.id],
      kind: 'maintenance',
      reason: 'Cierre por obras',
      ...T,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toHaveLength(2);
    expect(ok.body[0]).toMatchObject({
      kind: 'maintenance',
      reason: 'Cierre por obras',
      startAt: '2027-02-01T12:00:00.000Z',
    });
    const by = await owner.query(`SELECT created_by FROM availability_blocks WHERE id=$1`, [
      ok.body[0].id,
    ]);
    expect(by.rows[0].created_by).not.toBeNull(); // quién lo creó

    // si UN recurso no existe, no se crea NINGUNO
    const before = (await o.c.get('/blocks?limit=100')).body.items.length;
    const bad = await o.c.post('/blocks', { resourceIds: [r1.id, randomUUID()], ...T });
    expect(bad.status).toBe(400);
    expect((await o.c.get('/blocks?limit=100')).body.items.length).toBe(before);
  });

  it('valida el rango: fin posterior, máximo 366 días, tipo y formato con zona', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    const r = await mkResource(o.c, loc.id);
    const mk = (extra: object) => o.c.post('/blocks', { resourceIds: [r.id], ...T, ...extra });
    expect((await mk({ endAt: T.startAt })).status).toBe(400);
    expect((await mk({ endAt: '2027-01-01T00:00:00Z' })).status).toBe(400);
    expect((await mk({ endAt: '2028-03-01T12:00:00Z' })).status).toBe(400); // > 366 días
    expect((await mk({ kind: 'vacaciones' })).status).toBe(400);
    expect((await mk({ startAt: '2027-02-01 12:00' })).status).toBe(400); // sin zona horaria
    expect((await o.c.post('/blocks', { resourceIds: [], ...T })).status).toBe(400);
    expect((await mk({ startAt: '2027-02-01T09:00:00-03:00' })).status).toBe(201); // con offset es válido
  });

  it('lista y filtra por recurso, sucursal y solapamiento con un rango', async () => {
    const o = await tenant();
    const l1 = await mkLocation(o.c, 'L1');
    const l2 = await mkLocation(o.c, 'L2');
    const r1 = await mkResource(o.c, l1.id, 'Ana');
    const r2 = await mkResource(o.c, l2.id, 'Beto');
    await o.c.post('/blocks', {
      resourceIds: [r1.id],
      startAt: '2027-02-01T00:00:00Z',
      endAt: '2027-02-05T00:00:00Z',
    });
    await o.c.post('/blocks', {
      resourceIds: [r2.id],
      startAt: '2027-03-01T00:00:00Z',
      endAt: '2027-03-02T00:00:00Z',
    });
    expect((await o.c.get(`/blocks?resourceId=${r1.id}`)).body.items).toHaveLength(1);
    expect((await o.c.get(`/blocks?locationId=${l2.id}`)).body.items).toHaveLength(1);
    const q = (from: string, to: string) =>
      o.c.get(`/blocks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect((await q('2027-02-03T00:00:00Z', '2027-02-04T00:00:00Z')).body.items).toHaveLength(1); // dentro del 1.º
    expect((await q('2027-02-05T00:00:00Z', '2027-02-10T00:00:00Z')).body.items).toHaveLength(0); // empieza justo al terminar: no se solapa
    expect((await q('2027-01-01T00:00:00Z', '2027-12-31T00:00:00Z')).body.items).toHaveLength(2);
  });

  it('edita (tipo, rango, motivo) validando el resultado final; elimina', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    const r = await mkResource(o.c, loc.id);
    const blk = (await o.c.post('/blocks', { resourceIds: [r.id], ...T })).body[0];
    expect(
      (await o.c.patch(`/blocks/${blk.id}`, { kind: 'time_off', reason: 'Vacaciones' })).body,
    ).toMatchObject({ kind: 'time_off', reason: 'Vacaciones' });
    expect(
      (await o.c.patch(`/blocks/${blk.id}`, { endAt: '2027-02-10T00:00:00Z' })).body.endAt,
    ).toBe('2027-02-10T00:00:00.000Z');
    // mover solo el inicio más allá del fin existente => rango inválido
    expect((await o.c.patch(`/blocks/${blk.id}`, { startAt: '2027-03-01T00:00:00Z' })).status).toBe(
      400,
    );
    expect((await o.c.patch(`/blocks/${blk.id}`, {})).status).toBe(400);
    expect((await o.c.del(`/blocks/${blk.id}`)).status).toBe(204);
    expect((await o.c.del(`/blocks/${blk.id}`)).status).toBe(404);
  });

  it('aislamiento: no se bloquean ni se tocan recursos o bloqueos de otra empresa', async () => {
    const a = await tenant();
    const b = await tenant();
    const loc = await mkLocation(a.c);
    const r = await mkResource(a.c, loc.id);
    const blk = (await a.c.post('/blocks', { resourceIds: [r.id], ...T })).body[0];
    expect((await b.c.post('/blocks', { resourceIds: [r.id], ...T })).status).toBe(400);
    expect((await b.c.patch(`/blocks/${blk.id}`, { reason: 'hack' })).status).toBe(404);
    expect((await b.c.del(`/blocks/${blk.id}`)).status).toBe(404);
    expect((await b.c.get('/blocks')).body.items).toEqual([]);
  });

  it('el profesional puede ver los bloqueos pero no crearlos', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    const r = await mkResource(o.c, loc.id);
    const pro = client(app, (await joinTenant(app, owner, o.tenantId, 'professional')).auth);
    expect((await pro.get('/blocks')).status).toBe(200);
    expect((await pro.post('/blocks', { resourceIds: [r.id], ...T })).status).toBe(403);
  });
});

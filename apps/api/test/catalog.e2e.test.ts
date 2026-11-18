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

async function tenant(opts: Parameters<typeof register>[1] = {}) {
  const r = await register(app, opts);
  return { ...r, c: client(app, r.auth) };
}

describe('permisos del catálogo', () => {
  it('propietario y administrador escriben; recepción solo lee; el profesional ve servicios y recursos pero no sucursales', async () => {
    const o = await tenant();
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');
    const rec = await joinTenant(app, owner, o.tenantId, 'receptionist');
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    const [ca, cr, cp] = [client(app, admin.auth), client(app, rec.auth), client(app, pro.auth)];

    expect((await ca.post('/locations', { name: 'Admin Loc' })).status).toBe(201);
    expect((await cr.get('/locations')).status).toBe(200);
    expect((await cr.post('/locations', { name: 'Recep Loc' })).status).toBe(403);
    expect(
      (await cr.post('/services', { name: 'Servicio X', durationMinutes: 30, price: '100' }))
        .status,
    ).toBe(403);
    expect(
      (await cr.post('/resources', { locationId: randomUUID(), kind: 'room', name: 'Sala' }))
        .status,
    ).toBe(403);
    expect((await cp.get('/services')).status).toBe(200);
    expect((await cp.get('/resources')).status).toBe(200);
    expect((await cp.get('/locations')).status).toBe(403);
    expect((await http(app).get('/api/v1/locations')).status).toBe(401);
  });
});

describe('sucursales', () => {
  it('crea, lista, edita, desactiva y elimina, con zona horaria efectiva', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c, 'Casa Matriz', {
      address: { city: 'Santiago' },
      phone: '+56911112222',
      email: 'Matriz@Example.test',
    });
    expect(loc.effectiveTimezone).toBe('America/Santiago'); // hereda la de la empresa

    const got = await c.get(`/locations/${loc.id}`);
    expect(got.body).toMatchObject({
      name: 'Casa Matriz',
      address: { city: 'Santiago' },
      email: 'matriz@example.test',
      timezone: null,
      isActive: true,
    });

    const ny = await c.patch(`/locations/${loc.id}`, { timezone: 'America/New_York' });
    expect(ny.body).toMatchObject({
      timezone: 'America/New_York',
      effectiveTimezone: 'America/New_York',
    });
    const back = await c.patch(`/locations/${loc.id}`, { timezone: null });
    expect(back.body.effectiveTimezone).toBe('America/Santiago');

    expect((await c.patch(`/locations/${loc.id}`, { isActive: false })).body.isActive).toBe(false);
    expect((await c.get('/locations?isActive=false')).body.items).toHaveLength(1);
    expect((await c.get('/locations?isActive=true')).body.items).toHaveLength(0);

    expect((await c.del(`/locations/${loc.id}`)).status).toBe(204);
    expect((await c.get(`/locations/${loc.id}`)).status).toBe(404);
  });

  it('valida los datos con errores por campo', async () => {
    const { c } = await tenant();
    const bad = await c.post('/locations', {
      name: 'X',
      email: 'no-es-email',
      timezone: 'Marte/Olympus',
      address: { calle: 'x' },
    });
    expect(bad.status).toBe(400);
    const paths = bad.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'timezone']));
    expect((await c.patch('/locations/' + randomUUID(), {})).status).toBe(400);
    expect((await c.get('/locations/no-uuid')).status).toBe(400);
  });

  it('el nombre es único por empresa sin distinguir mayúsculas (409 DUPLICATE) pero repetible entre empresas', async () => {
    const a = await tenant();
    const b = await tenant();
    await mkLocation(a.c, 'Sucursal Centro');
    const dup = await a.c.post('/locations', { name: 'SUCURSAL CENTRO' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
    expect(dup.body.errors[0].path).toBe('name');
    expect((await b.c.post('/locations', { name: 'Sucursal Centro' })).status).toBe(201);
    const other = await mkLocation(a.c, 'Otra');
    expect((await a.c.patch(`/locations/${other.id}`, { name: 'sucursal centro' })).status).toBe(
      409,
    );
  });

  it('pagina por cursor y filtra por nombre', async () => {
    const { c } = await tenant();
    for (const n of ['Alfa Norte', 'Beta Sur', 'Gamma Norte', 'Delta Este', 'Epsilon Oeste'])
      await mkLocation(c, n);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { id: string }[]; nextCursor: string | null } } = await c.get(
        `/locations?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...res.body.items.map((i) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect((await c.get('/locations?q=norte')).body.items).toHaveLength(2);
    expect((await c.get('/locations?limit=500')).status).toBe(400);
  });

  it('no se puede eliminar con recursos (IN_USE) y NO se pierde su configuración; vacía sí se elimina con ella', async () => {
    const { c, tenantId } = await tenant();
    const withRes = await mkLocation(c, 'Con recursos');
    await c.put(`/locations/${withRes.id}/business-hours`, { intervals: hours([1, 2]) });
    await mkResource(c, withRes.id);
    const res = await c.del(`/locations/${withRes.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IN_USE');
    expect((await c.get(`/locations/${withRes.id}/business-hours`)).body.intervals).toHaveLength(2); // transacción revertida

    const empty = await mkLocation(c, 'Vacía');
    await c.put(`/locations/${empty.id}/business-hours`, { intervals: hours([1]) });
    expect((await c.del(`/locations/${empty.id}`)).status).toBe(204);
    const left = await owner.query(
      `SELECT count(*)::int AS n FROM business_hours WHERE location_id=$1`,
      [empty.id],
    );
    expect(left.rows[0].n).toBe(0);
    expect(tenantId).toBeTruthy();
  });
});

describe('categorías y servicios', () => {
  it('categorías: CRUD, nombre único y no se borran con servicios', async () => {
    const { c } = await tenant();
    const cat = (await c.post('/service-categories', { name: 'Cabello', sortOrder: 2 })).body;
    expect(cat).toMatchObject({ name: 'Cabello', sortOrder: 2 });
    expect((await c.post('/service-categories', { name: 'cabello' })).status).toBe(409);
    expect((await c.patch(`/service-categories/${cat.id}`, { name: 'Pelo' })).body.name).toBe(
      'Pelo',
    );
    await mkService(c, 'Corte', { categoryId: cat.id });
    const del = await c.del(`/service-categories/${cat.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('IN_USE');
  });

  it('el precio es texto decimal; la moneda la fija el servidor, no el cliente', async () => {
    const usd = await register(app);
    // empresa en USD
    const reg = await http(app)
      .post('/api/v1/auth/register')
      .send({
        email: `usd-${randomUUID().slice(0, 6)}@example.test`,
        password: 'Str0ng-Passw0rd!',
        fullName: 'Dueño Dólar',
        businessName: `Dólar ${randomUUID().slice(0, 5)}`,
        currency: 'USD',
      });
    const c = client(app, { Authorization: `Bearer ${reg.body.accessToken}` });
    const svc = await c.post('/services', {
      name: 'Consulta',
      durationMinutes: 45,
      price: '49.5',
      currency: 'CLP',
    });
    expect(svc.status).toBe(201);
    expect(svc.body).toMatchObject({ price: '49.50', currency: 'USD' }); // ignora la moneda enviada
    expect(usd.tenantId).toBeTruthy();
  });

  it('rechaza precios inválidos (número, 3 decimales, negativo) y duraciones fuera de rango', async () => {
    const { c } = await tenant();
    const base = { name: 'Servicio', durationMinutes: 30, price: '100' };
    for (const price of [100, '10.999', '-5', '1e3', '', 'abc'])
      expect((await c.post('/services', { ...base, price })).status, String(price)).toBe(400);
    for (const durationMinutes of [0, 1441, 30.5])
      expect(
        (await c.post('/services', { ...base, name: 'D' + durationMinutes, durationMinutes }))
          .status,
      ).toBe(400);
    expect(
      (await c.post('/services', { ...base, name: 'B1', bufferBeforeMinutes: 241 })).status,
    ).toBe(400);
    expect((await c.post('/services', { ...base, name: 'B2', maxAdvanceDays: 0 })).status).toBe(
      400,
    );
    expect(
      (await c.post('/services', { ...base, name: 'B3', imageUrl: 'http://x.test/a.png' })).status,
    ).toBe(400);
    expect(
      (await c.post('/services', { ...base, name: 'B4', imageUrl: 'javascript:alert(1)' })).status,
    ).toBe(400);
    expect(
      (
        await c.post('/services', {
          ...base,
          name: 'B5',
          imageUrl: 'https://x.test/a.png',
          price: '0',
        })
      ).status,
    ).toBe(201); // gratis es válido
  });

  it('edita y desactiva; el nombre es único; la categoría debe existir en la empresa', async () => {
    const a = await tenant();
    const b = await tenant();
    const svc = await mkService(a.c, 'Tinte');
    expect(
      (
        await a.c.patch(`/services/${svc.id}`, {
          price: '20000',
          durationMinutes: 90,
          isActive: false,
        })
      ).body,
    ).toMatchObject({ price: '20000.00', durationMinutes: 90, isActive: false });
    expect(
      (await a.c.post('/services', { name: 'TINTE', durationMinutes: 30, price: '1' })).status,
    ).toBe(409);
    const foreignCat = (await b.c.post('/service-categories', { name: 'Ajena' })).body;
    const cross = await a.c.post('/services', {
      name: 'Cruzado',
      durationMinutes: 30,
      price: '1',
      categoryId: foreignCat.id,
    });
    expect(cross.status).toBe(400);
    expect(cross.body.errors[0].path).toBe('categoryId');
  });

  it('vincula sucursales y recursos de forma coherente', async () => {
    const { c } = await tenant();
    const l1 = await mkLocation(c, 'L1');
    const l2 = await mkLocation(c, 'L2');
    const r1 = await mkResource(c, l1.id, 'Ana');
    const r2 = await mkResource(c, l2.id, 'Beto');
    const svc = await mkService(c);

    // un recurso en una sucursal donde el servicio NO se ofrece => 400
    const early = await c.put(`/services/${svc.id}/resources`, { resourceIds: [r1.id] });
    expect(early.status).toBe(400);
    expect(early.body.errors[0].path).toBe('resourceIds');

    const withLocs = await c.put(`/services/${svc.id}/locations`, { locationIds: [l1.id, l2.id] });
    expect(withLocs.body.locationIds.sort()).toEqual([l1.id, l2.id].sort());
    const withRes = await c.put(`/services/${svc.id}/resources`, { resourceIds: [r1.id, r2.id] });
    expect(withRes.body.resourceIds.sort()).toEqual([r1.id, r2.id].sort());
    expect((await c.get(`/services?locationId=${l1.id}`)).body.items).toHaveLength(1);

    // quitar L2 desvincula automáticamente a Beto (su recurso estaba en L2)
    const dropped = await c.put(`/services/${svc.id}/locations`, { locationIds: [l1.id] });
    expect(dropped.body.locationIds).toEqual([l1.id]);
    expect(dropped.body.resourceIds).toEqual([r1.id]);

    expect(
      (await c.put(`/services/${svc.id}/locations`, { locationIds: [randomUUID()] })).status,
    ).toBe(400);
    expect(
      (await c.put(`/services/${svc.id}/resources`, { resourceIds: [randomUUID()] })).status,
    ).toBe(400);
    expect(
      (await c.put(`/services/${svc.id}/locations`, { locationIds: [] })).body.resourceIds,
    ).toEqual([]); // vaciar es válido
  });

  it('eliminar un servicio elimina sus vínculos', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const res = await mkResource(c, loc.id);
    const svc = await mkService(c);
    await c.put(`/services/${svc.id}/locations`, { locationIds: [loc.id] });
    await c.put(`/services/${svc.id}/resources`, { resourceIds: [res.id] });
    expect((await c.del(`/services/${svc.id}`)).status).toBe(204);
    expect((await c.get(`/resources/${res.id}`)).status).toBe(200); // el recurso sigue
    const left = await owner.query(
      `SELECT count(*)::int AS n FROM service_resources WHERE service_id=$1`,
      [svc.id],
    );
    expect(left.rows[0].n).toBe(0);
  });
});

describe('profesionales y recursos', () => {
  it('crea personal y recursos físicos; la sucursal y el tipo no se pueden cambiar', async () => {
    const { c } = await tenant();
    const l1 = await mkLocation(c, 'L1');
    const l2 = await mkLocation(c, 'L2');
    const room = await c.post('/resources', { locationId: l1.id, kind: 'room', name: 'Box 1' });
    expect(room.body).toMatchObject({
      kind: 'room',
      capacity: 1,
      isActive: true,
      isBookableOnline: true,
      autoAssignable: true,
    });
    const moved = await c.patch(`/resources/${room.body.id}`, {
      locationId: l2.id,
      kind: 'staff',
      name: 'Box 1 bis',
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ locationId: l1.id, kind: 'room', name: 'Box 1 bis' }); // location y kind ignorados
  });

  it('capacidad: solo 1 en el MVP (ADR-006)', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    expect(
      (
        await c.post('/resources', {
          locationId: loc.id,
          kind: 'room',
          name: 'Sala grande',
          capacity: 10,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.post('/resources', {
          locationId: loc.id,
          kind: 'room',
          name: 'Sala 0',
          capacity: 0,
        })
      ).status,
    ).toBe(400);
  });

  it('vincula un profesional con su usuario: solo staff, miembro activo, y uno por recurso', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c);
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    const ok = await o.c.post('/resources', {
      locationId: loc.id,
      kind: 'staff',
      name: 'María',
      membershipId: pro.membershipId,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.membershipId).toBe(pro.membershipId);

    const room = await o.c.post('/resources', {
      locationId: loc.id,
      kind: 'room',
      name: 'Sala',
      membershipId: pro.membershipId,
    });
    expect(room.status).toBe(400); // solo el personal
    const twice = await o.c.post('/resources', {
      locationId: loc.id,
      kind: 'staff',
      name: 'María bis',
      membershipId: pro.membershipId,
    });
    expect(twice.status).toBe(409);
    expect(
      (
        await o.c.post('/resources', {
          locationId: loc.id,
          kind: 'staff',
          name: 'Fantasma',
          membershipId: randomUUID(),
        })
      ).status,
    ).toBe(400);

    // un miembro de OTRA empresa no puede vincularse
    const other = await tenant();
    const otherPro = await joinTenant(app, owner, other.tenantId, 'professional');
    const cross = await o.c.post('/resources', {
      locationId: loc.id,
      kind: 'staff',
      name: 'Cruzada',
      membershipId: otherPro.membershipId,
    });
    expect(cross.status).toBe(400);

    // un miembro DESACTIVADO tampoco
    const off = await joinTenant(app, owner, o.tenantId, 'professional');
    await owner.query(`UPDATE tenant_memberships SET status='disabled' WHERE id=$1`, [
      off.membershipId,
    ]);
    expect(
      (
        await o.c.post('/resources', {
          locationId: loc.id,
          kind: 'staff',
          name: 'Inactiva',
          membershipId: off.membershipId,
        })
      ).status,
    ).toBe(400);
  });

  it('nombre único por sucursal (pero repetible en otra) y la sucursal debe existir y estar activa', async () => {
    const { c } = await tenant();
    const l1 = await mkLocation(c, 'L1');
    const l2 = await mkLocation(c, 'L2');
    await mkResource(c, l1.id, 'Ana');
    expect(
      (await c.post('/resources', { locationId: l1.id, kind: 'staff', name: 'ANA' })).status,
    ).toBe(409);
    expect(
      (await c.post('/resources', { locationId: l2.id, kind: 'staff', name: 'Ana' })).status,
    ).toBe(201);
    expect(
      (
        await c.post('/resources', {
          locationId: randomUUID(),
          kind: 'staff',
          name: 'Sin sucursal',
        })
      ).status,
    ).toBe(400);
    await c.patch(`/locations/${l2.id}`, { isActive: false });
    expect(
      (await c.post('/resources', { locationId: l2.id, kind: 'staff', name: 'En inactiva' }))
        .status,
    ).toBe(400);
  });

  it('lista con filtros (sucursal, tipo, estado) y eliminar borra su configuración', async () => {
    const { c } = await tenant();
    const l1 = await mkLocation(c, 'L1');
    const l2 = await mkLocation(c, 'L2');
    const ana = await mkResource(c, l1.id, 'Ana');
    await c.post('/resources', { locationId: l1.id, kind: 'room', name: 'Box' });
    await mkResource(c, l2.id, 'Beto');
    expect((await c.get(`/resources?locationId=${l1.id}`)).body.items).toHaveLength(2);
    expect((await c.get('/resources?kind=room')).body.items).toHaveLength(1);
    await c.patch(`/resources/${ana.id}`, { isActive: false });
    expect((await c.get('/resources?isActive=false')).body.items).toHaveLength(1);

    await c.put(`/resources/${ana.id}/schedule`, { intervals: hours([1]) });
    await c.post('/blocks', {
      resourceIds: [ana.id],
      startAt: '2027-02-01T10:00:00Z',
      endAt: '2027-02-02T10:00:00Z',
    });
    expect((await c.del(`/resources/${ana.id}`)).status).toBe(204);
    for (const t of ['resource_schedules', 'availability_blocks']) {
      const left = await owner.query(`SELECT count(*)::int AS n FROM ${t} WHERE resource_id=$1`, [
        ana.id,
      ]);
      expect(left.rows[0].n, t).toBe(0);
    }
  });
});

describe('editar un campo NO altera los demás (regresión: los esquemas de edición no heredan valores por defecto)', () => {
  it('sucursal', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c, 'Completa', {
      address: { city: 'Valdivia', line1: 'Calle 1' },
      phone: '+56911112222',
      email: 'a@b.test',
      timezone: 'America/Punta_Arenas',
    });
    const res = await c.patch(`/locations/${loc.id}`, { name: 'Completa v2' });
    expect(res.body).toMatchObject({
      name: 'Completa v2',
      address: { city: 'Valdivia', line1: 'Calle 1' },
      phone: '+56911112222',
      email: 'a@b.test',
      timezone: 'America/Punta_Arenas',
      isActive: true,
    });
  });

  it('servicio', async () => {
    const { c } = await tenant();
    const cat = (await c.post('/service-categories', { name: 'Cat' })).body;
    const svc = await mkService(c, 'Completo', {
      description: 'Descripción',
      categoryId: cat.id,
      durationMinutes: 45,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
      minNoticeMinutes: 60,
      maxAdvanceDays: 30,
      requiresConfirmation: true,
      imageUrl: 'https://x.test/i.png',
    });
    const res = await c.patch(`/services/${svc.id}`, { price: '5000' });
    expect(res.body).toMatchObject({
      price: '5000.00',
      description: 'Descripción',
      categoryId: cat.id,
      durationMinutes: 45,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
      minNoticeMinutes: 60,
      maxAdvanceDays: 30,
      requiresConfirmation: true,
      imageUrl: 'https://x.test/i.png',
      isActive: true,
    });
  });

  it('recurso', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const r = await mkResource(c, loc.id, 'Configurado', {
      isBookableOnline: false,
      autoAssignable: false,
      sortOrder: 7,
    });
    const res = await c.patch(`/resources/${r.id}`, { name: 'Configurado v2' });
    expect(res.body).toMatchObject({
      name: 'Configurado v2',
      isBookableOnline: false,
      autoAssignable: false,
      sortOrder: 7,
      capacity: 1,
      isActive: true,
    });
  });

  it('categoría', async () => {
    const { c } = await tenant();
    const cat = (await c.post('/service-categories', { name: 'Ordenada', sortOrder: 5 })).body;
    expect(
      (await c.patch(`/service-categories/${cat.id}`, { name: 'Ordenada v2' })).body.sortOrder,
    ).toBe(5);
  });

  it('un PATCH vacío se rechaza en todas las entidades', async () => {
    const { c } = await tenant();
    const loc = await mkLocation(c);
    const svc = await mkService(c);
    const r = await mkResource(c, loc.id);
    const cat = (await c.post('/service-categories', { name: 'Vacía' })).body;
    for (const path of [
      `/locations/${loc.id}`,
      `/services/${svc.id}`,
      `/resources/${r.id}`,
      `/service-categories/${cat.id}`,
    ]) {
      expect((await c.patch(path, {})).status, path).toBe(400);
    }
  });
});

describe('aislamiento entre empresas en el catálogo', () => {
  it('cada empresa ve solo lo suyo; los ids ajenos dan 404 y no se pueden modificar ni referenciar', async () => {
    const a = await tenant();
    const b = await tenant();
    const locA = await mkLocation(a.c, 'Loc A');
    const resA = await mkResource(a.c, locA.id, 'Res A');
    const svcA = await mkService(a.c, 'Svc A');
    await mkLocation(b.c, 'Loc B');

    expect((await b.c.get('/locations')).body.items.map((l: { name: string }) => l.name)).toEqual([
      'Loc B',
    ]);
    for (const path of [`/locations/${locA.id}`, `/resources/${resA.id}`, `/services/${svcA.id}`])
      expect((await b.c.get(path)).status, path).toBe(404);
    expect((await b.c.patch(`/locations/${locA.id}`, { name: 'Hackeada' })).status).toBe(404);
    expect((await b.c.del(`/resources/${resA.id}`)).status).toBe(404);
    expect((await b.c.put(`/services/${svcA.id}/locations`, { locationIds: [] })).status).toBe(404);
    expect(
      (await b.c.put(`/locations/${locA.id}/business-hours`, { intervals: hours([1]) })).status,
    ).toBe(404);

    // referenciar ids de otra empresa desde la propia
    const svcB = await mkService(b.c, 'Svc B');
    expect(
      (await b.c.post('/resources', { locationId: locA.id, kind: 'staff', name: 'Intruso' }))
        .status,
    ).toBe(400);
    expect(
      (await b.c.put(`/services/${svcB.id}/locations`, { locationIds: [locA.id] })).status,
    ).toBe(400);
    expect(
      (await b.c.put(`/services/${svcB.id}/resources`, { resourceIds: [resA.id] })).status,
    ).toBe(400);

    const intact = await owner.query(`SELECT name FROM locations WHERE id=$1`, [locA.id]);
    expect(intact.rows[0].name).toBe('Loc A');
  });
});

describe('auditoría del catálogo', () => {
  it('registra altas, cambios y bajas con el antes y el después', async () => {
    const o = await tenant();
    const loc = await mkLocation(o.c, 'Auditada');
    await o.c.patch(`/locations/${loc.id}`, { name: 'Auditada v2' });
    await o.c.del(`/locations/${loc.id}`);
    const log = await o.c.get('/tenants/current/audit-logs?entityType=location');
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual([
      'location.deleted',
      'location.updated',
      'location.created',
    ]);
    const updated = log.body.items.find((i: { action: string }) => i.action === 'location.updated');
    expect(updated.before.name).toBe('Auditada');
    expect(updated.after.name).toBe('Auditada v2');
  });
});

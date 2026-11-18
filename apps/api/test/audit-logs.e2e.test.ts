import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const url = '/api/v1/tenants/current/audit-logs';

describe('consulta de auditoría', () => {
  it('lista lo más reciente primero, con el nombre de quien actuó y el antes/después', async () => {
    const o = await register(app, { businessName: 'Auditada SA' });
    await http(app).patch('/api/v1/tenants/current').set(o.auth).send({ name: 'Auditada Renovada' });

    const res = await http(app).get(url).set(o.auth);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { action: string }) => i.action)).toEqual(['tenant.updated', 'tenant.created']);
    const updated = res.body.items[0];
    expect(updated.actorName).toBe('Persona de Prueba');
    expect(updated.before.name).toBe('Auditada SA');
    expect(updated.after.name).toBe('Auditada Renovada');
    expect(updated.requestId).toBeTruthy();
  });

  it('filtra por acción, entidad y fechas', async () => {
    const o = await register(app);
    await http(app).patch('/api/v1/tenants/current').set(o.auth).send({ name: 'Otro Nombre' });
    const byAction = await http(app).get(`${url}?action=tenant.created`).set(o.auth);
    expect(byAction.body.items).toHaveLength(1);
    const byEntity = await http(app).get(`${url}?entityType=tenant&entityId=${o.tenantId}`).set(o.auth);
    expect(byEntity.body.items).toHaveLength(2);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await http(app).get(`${url}?from=${encodeURIComponent(future)}`).set(o.auth)).body.items).toEqual([]);
    expect((await http(app).get(`${url}?from=ayer`).set(o.auth)).status).toBe(400);
  });

  it('pagina por cursor sin repetir ni perder entradas', async () => {
    const o = await register(app);
    for (let i = 0; i < 5; i++) await http(app).patch('/api/v1/tenants/current').set(o.auth).send({ name: `Nombre ${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Response = await http(app).get(`${url}?limit=2${cursor ? `&cursor=${cursor}` : ''}`).set(o.auth);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(6); // creada + 5 ediciones
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort().reverse()).toEqual(seen); // estrictamente de más nuevo a más antiguo
    expect((await http(app).get(`${url}?cursor=basura`).set(o.auth)).status).toBe(400);
  });

  it('un administrador la ve; recepción y profesionales no', async () => {
    const o = await register(app);
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');
    const rec = await joinTenant(app, owner, o.tenantId, 'receptionist');
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    expect((await http(app).get(url).set(admin.auth)).status).toBe(200);
    expect((await http(app).get(url).set(rec.auth)).status).toBe(403);
    expect((await http(app).get(url).set(pro.auth)).status).toBe(403);
    expect((await http(app).get(url)).status).toBe(401);
  });

  it('jamás muestra entradas de otra empresa, ni filtrando por sus ids', async () => {
    const a = await register(app);
    const b = await register(app);
    const res = await http(app).get(`${url}?entityId=${b.tenantId}&entityType=tenant`).set(a.auth);
    expect(res.body.items).toEqual([]);
    const all = await http(app).get(url).set(a.auth);
    for (const i of all.body.items) expect(i.entityId).toBe(a.tenantId);
  });

  it('registra la actividad de invitaciones y miembros', async () => {
    const o = await register(app);
    const m = await joinTenant(app, owner, o.tenantId, 'professional');
    await http(app).post('/api/v1/tenants/current/invitations').set(o.auth).send({ email: 'nuevo-aud@example.test', roleKey: 'receptionist' });
    await http(app).patch(`/api/v1/tenants/current/members/${m.membershipId}`).set(o.auth).send({ status: 'disabled' });
    const actions = (await http(app).get(url).set(o.auth)).body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['invitation.created', 'member.updated', 'tenant.created']));
  });
});

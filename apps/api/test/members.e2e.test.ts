import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '@reservepro/contracts';
import type { Response } from 'supertest';
import { type Auth, createTestApp, http, joinTenant, login, ownerPool, register } from './helpers.js';

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

const base = '/api/v1/tenants/current';
const patch = (auth: Auth, membershipId: string, body: object) =>
  http(app).patch(`${base}/members/${membershipId}`).set(auth).send(body);

describe('listado de miembros', () => {
  it('muestra los miembros de la empresa con sus roles y NUNCA datos sensibles', async () => {
    const o = await register(app, { businessName: 'Equipo Uno' });
    await joinTenant(app, owner, o.tenantId, 'professional');

    const res = await http(app).get(`${base}/members`).set(o.auth);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((m: { roles: { key: string }[] }) => m.roles[0]!.key).sort()).toEqual(['owner', 'professional']);
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2|token_hash/i);
  });

  it('pagina por cursor sin repetir ni perder miembros', async () => {
    const o = await register(app);
    for (let i = 0; i < 4; i++) await joinTenant(app, owner, o.tenantId, 'professional');

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `${base}/members?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res: Response = await http(app).get(url).set(o.auth);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((m: { membershipId: string }) => m.membershipId));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(5); // 1 propietario + 4
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  it('un cursor manipulado da 400, y un límite fuera de rango también', async () => {
    const o = await register(app);
    expect((await http(app).get(`${base}/members?cursor=basura`).set(o.auth)).status).toBe(400);
    expect((await http(app).get(`${base}/members?limit=1000`).set(o.auth)).status).toBe(400);
    const inyeccion = Buffer.from("' OR 1=1 --").toString('base64url');
    expect((await http(app).get(`${base}/members?cursor=${inyeccion}`).set(o.auth)).status).toBe(400);
  });

  it('jamás incluye miembros de otra empresa, ni con el cursor de otra', async () => {
    const a = await register(app);
    const b = await register(app);
    await joinTenant(app, owner, b.tenantId, 'professional');
    const bList = await http(app).get(`${base}/members?limit=1`).set(b.auth);

    const aList = await http(app).get(`${base}/members?cursor=${bList.body.nextCursor}`).set(a.auth);
    const aEmails = aList.body.items.map((m: { email: string }) => m.email);
    expect(aEmails.every((e: string) => e === a.email)).toBe(true);
    const all = await http(app).get(`${base}/members`).set(a.auth);
    expect(all.body.items).toHaveLength(1);
  });
});

describe('roles de la empresa', () => {
  it('lista los 5 roles de sistema con sus permisos', async () => {
    const o = await register(app);
    const res = await http(app).get(`${base}/roles`).set(o.auth);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { key: string }) => r.key)).toEqual(['admin', 'manager', 'owner', 'professional', 'receptionist']);
    const ownerRole = res.body.find((r: { key: string }) => r.key === 'owner');
    expect(ownerRole.permissions).toHaveLength(PERMISSION_KEYS.length);
    expect(ownerRole.isSystem).toBe(true);
  });
});

describe('modificar miembros', () => {
  it('desactivar a un miembro corta su acceso de inmediato; reactivar lo restablece', async () => {
    const o = await register(app);
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    expect((await http(app).get(`${base}`).set(pro.auth)).status).toBe(200);

    const off = await patch(o.auth, pro.membershipId, { status: 'disabled' });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('disabled');
    expect((await http(app).get(`${base}`).set(pro.auth)).status).toBe(401); // token aún vigente, acceso cortado

    const on = await patch(o.auth, pro.membershipId, { status: 'active' });
    expect(on.body.status).toBe('active');
    expect((await http(app).get(`${base}`).set(pro.auth)).status).toBe(200);
  });

  it('cambia los roles (reemplazo total) y los permisos efectivos cambian al instante', async () => {
    const o = await register(app);
    const m = await joinTenant(app, owner, o.tenantId, 'professional');
    expect((await http(app).get(`${base}/members`).set(m.auth)).status).toBe(403);

    const res = await patch(o.auth, m.membershipId, { roleKeys: ['manager'] });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([{ key: 'manager', name: 'Gerente' }]);
    expect((await http(app).get(`${base}/members`).set(m.auth)).status).toBe(200);
  });

  it('valida: vacío, rol inexistente, lista de roles vacía', async () => {
    const o = await register(app);
    const m = await joinTenant(app, owner, o.tenantId, 'professional');
    expect((await patch(o.auth, m.membershipId, {})).status).toBe(400);
    const unknown = await patch(o.auth, m.membershipId, { roleKeys: ['inventado'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0].path).toBe('roleKeys');
    expect((await patch(o.auth, m.membershipId, { roleKeys: [] })).status).toBe(400);
    expect((await patch(o.auth, m.membershipId, { status: 'borrado' })).status).toBe(400);
  });

  it('nadie puede modificarse a sí mismo (evita auto-bloqueo y auto-escalada)', async () => {
    const o = await register(app);
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');
    const self = await patch(admin.auth, admin.membershipId, { roleKeys: ['owner'] });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('CANNOT_MODIFY_SELF');
    expect((await patch(admin.auth, admin.membershipId, { status: 'disabled' })).status).toBe(409);
  });

  it('un miembro sin members:update no puede modificar a nadie', async () => {
    const o = await register(app);
    const rec = await joinTenant(app, owner, o.tenantId, 'receptionist');
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    expect((await patch(rec.auth, pro.membershipId, { status: 'disabled' })).status).toBe(403);
  });

  it('deja auditoría con el antes y el después', async () => {
    const o = await register(app);
    const m = await joinTenant(app, owner, o.tenantId, 'professional');
    await patch(o.auth, m.membershipId, { status: 'disabled', roleKeys: ['receptionist'] });
    const a = await owner.query(
      `SELECT before, after FROM audit_logs WHERE tenant_id=$1 AND action='member.updated'`,
      [o.tenantId],
    );
    expect(a.rows).toEqual([
      { before: { status: 'active', roles: ['professional'] }, after: { status: 'disabled', roles: ['receptionist'] } },
    ]);
  });
});

describe('anti-escalada de privilegios', () => {
  it('un administrador no puede modificar ni desactivar a un propietario', async () => {
    const o = await register(app);
    const ownerMembership = (await owner.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1`, [o.tenantId])).rows[0].id;
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');

    const r1 = await patch(admin.auth, ownerMembership, { status: 'disabled' });
    expect(r1.status).toBe(403);
    expect(r1.body.code).toBe('ROLE_NOT_ALLOWED');
    expect((await patch(admin.auth, ownerMembership, { roleKeys: ['professional'] })).status).toBe(403);

    const still = await owner.query(`SELECT status FROM tenant_memberships WHERE id=$1`, [ownerMembership]);
    expect(still.rows[0].status).toBe('active');
  });

  it('un administrador no puede ascender a nadie a propietario (ni a sí mismo ni a otro)', async () => {
    const o = await register(app);
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    const res = await patch(admin.auth, pro.membershipId, { roleKeys: ['owner'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROLE_NOT_ALLOWED');
    // tampoco combinando un rol permitido con uno prohibido
    expect((await patch(admin.auth, pro.membershipId, { roleKeys: ['manager', 'owner'] })).status).toBe(403);
  });

  it('un administrador SÍ gestiona a profesionales y gerentes', async () => {
    const o = await register(app);
    const admin = await joinTenant(app, owner, o.tenantId, 'admin');
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    expect((await patch(admin.auth, pro.membershipId, { roleKeys: ['manager'] })).status).toBe(200);
    expect((await patch(admin.auth, pro.membershipId, { status: 'disabled' })).status).toBe(200);
  });

  it('un propietario puede ascender a otro a propietario y degradarlo después', async () => {
    const o = await register(app);
    const m = await joinTenant(app, owner, o.tenantId, 'admin');
    expect((await patch(o.auth, m.membershipId, { roleKeys: ['owner'] })).status).toBe(200);
    expect((await patch(o.auth, m.membershipId, { roleKeys: ['admin'] })).status).toBe(200);
  });
});

describe('la empresa nunca se queda sin propietario', () => {
  it('dos propietarios que se desactivan mutuamente a la vez: nunca ambos, siempre queda uno activo', async () => {
    for (let round = 0; round < 6; round++) {
      const o1 = await register(app);
      const o2 = await joinTenant(app, owner, o1.tenantId, 'owner');
      const m1 = (await owner.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [o1.tenantId, o1.body.user.id])).rows[0].id;

      const [r1, r2] = await Promise.all([
        patch(o1.auth, o2.membershipId, { status: 'disabled' }),
        patch(o2.auth, m1, { status: 'disabled' }),
      ]);

      const active = await owner.query(
        `SELECT count(*)::int AS n FROM tenant_memberships m
           JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id
          WHERE m.tenant_id=$1 AND m.status='active' AND r.key='owner'`,
        [o1.tenantId],
      );
      expect(active.rows[0].n, `ronda ${round}: ${r1.status}/${r2.status}`).toBeGreaterThanOrEqual(1);
      expect([r1.status, r2.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    }
  });

  it('un propietario puede degradar a otro mientras quede alguno, pero el último no puede dejarse sin rol', async () => {
    const o1 = await register(app);
    const o2 = await joinTenant(app, owner, o1.tenantId, 'owner');
    // o1 degrada a o2: quedan o1 como propietario => permitido
    expect((await patch(o1.auth, o2.membershipId, { roleKeys: ['admin'] })).status).toBe(200);
    // ahora o2 es admin: no puede tocar al único propietario (anti-escalada)
    const m1 = (await owner.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [o1.tenantId, o1.body.user.id])).rows[0].id;
    expect((await patch(o2.auth, m1, { status: 'disabled' })).status).toBe(403);
  });
});

describe('aislamiento entre empresas', () => {
  it('no se puede modificar un miembro de otra empresa (404, como si no existiera)', async () => {
    const a = await register(app);
    const b = await register(app);
    const victim = await joinTenant(app, owner, b.tenantId, 'professional');
    const res = await patch(a.auth, victim.membershipId, { status: 'disabled' });
    expect(res.status).toBe(404);
    const row = await owner.query(`SELECT status FROM tenant_memberships WHERE id=$1`, [victim.membershipId]);
    expect(row.rows[0].status).toBe('active');
  });

  it('un administrador de A con membresía también en B solo gestiona la empresa activa', async () => {
    const a = await register(app);
    const b = await register(app);
    const adminA = await joinTenant(app, owner, a.tenantId, 'professional'); // usuario X: profesional en A
    // X también es administrador de B
    const m = await owner.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES (gen_random_uuid(),$1,$2) RETURNING id`, [b.tenantId, adminA.userId]);
    await owner.query(`INSERT INTO membership_roles(tenant_id,membership_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND key='admin'`, [b.tenantId, m.rows[0].id]);

    const inA = await login(app, adminA.email, { tenantId: a.tenantId });
    // En A es profesional: no puede gestionar miembros aunque en B sea administrador.
    expect((await http(app).get(`${base}/members`).set(inA.auth)).status).toBe(403);
    const inB = await login(app, adminA.email, { tenantId: b.tenantId });
    expect((await http(app).get(`${base}/members`).set(inB.auth)).status).toBe(200);
  });
});

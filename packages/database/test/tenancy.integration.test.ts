import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, createSystemClient, withTenant, withUser } from '../src/index.js';
import { testUrls } from './urls.js';

/**
 * Suite de aislamiento multi-tenant (ADR-004). Corre contra PostgreSQL real con el rol `rp_app`
 * (sujeto a RLS). Los datos de partida se insertan con el rol dueño (bypass), simulando datos ya existentes.
 */
const urls = testUrls();

const ids = {
  tA: randomUUID(),
  tB: randomUUID(),
  uA: randomUUID(),
  uB: randomUUID(),
  mA: randomUUID(),
  mB: randomUUID(),
  rA: randomUUID(),
  rB: randomUUID(),
};

const owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
const db = createPrismaClient(urls.app, { max: 3 });
const system = createSystemClient(urls.system, { max: 2 });
// Pool de UNA sola conexión: obliga a reutilizarla entre transacciones (prueba de fuga de contexto).
const singleConn = createPrismaClient(urls.app, { max: 1 });

beforeAll(async () => {
  await owner.query(`INSERT INTO permissions(key, description) VALUES ('reservations:read','x') ON CONFLICT DO NOTHING`);
  await owner.query(
    `INSERT INTO users(id,email,password_hash,full_name) VALUES ($1,'a@a.test','h','User A'),($2,'b@b.test','h','User B')`,
    [ids.uA, ids.uB],
  );
  await owner.query(
    `INSERT INTO tenants(id,name,slug) VALUES ($1,'Tenant A','tenant-a'),($2,'Tenant B','tenant-b')`,
    [ids.tA, ids.tB],
  );
  await owner.query(
    `INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES ($1,$2,$3),($4,$5,$6)`,
    [ids.mA, ids.tA, ids.uA, ids.mB, ids.tB, ids.uB],
  );
  await owner.query(
    `INSERT INTO roles(id,tenant_id,key,name) VALUES ($1,$2,'owner','Owner'),($3,$4,'owner','Owner')`,
    [ids.rA, ids.tA, ids.rB, ids.tB],
  );
});

afterAll(async () => {
  await Promise.all([db.$disconnect(), system.$disconnect(), singleConn.$disconnect(), owner.end()]);
});

describe('aislamiento por contexto de tenant', () => {
  it('con contexto A solo se ven filas de A', async () => {
    const rows = await withTenant(db, { tenantId: ids.tA }, (tx) => tx.tenants.findMany());
    expect(rows.map((r) => r.slug)).toEqual(['tenant-a']);

    const roles = await withTenant(db, { tenantId: ids.tA }, (tx) => tx.roles.findMany());
    expect(roles.map((r) => r.tenant_id)).toEqual([ids.tA]);
  });

  it('SIN contexto no se ve ninguna fila (falla cerrado)', async () => {
    expect(await db.tenants.count()).toBe(0);
    expect(await db.roles.count()).toBe(0);
    expect(await db.tenant_memberships.count()).toBe(0);
  });

  it('un WHERE explícito a otro tenant no devuelve nada bajo contexto A', async () => {
    const rows = await withTenant(db, { tenantId: ids.tA }, (tx) =>
      tx.roles.findMany({ where: { tenant_id: ids.tB } }),
    );
    expect(rows).toEqual([]);
  });

  it('no se puede INSERTAR una fila de otro tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(db, { tenantId: ids.tA }, (tx) =>
        tx.roles.create({ data: { id: randomUUID(), tenant_id: ids.tB, key: 'intruso', name: 'Intruso' } }),
      ),
    ).rejects.toThrow();
    const intruso = await owner.query(`SELECT 1 FROM roles WHERE key='intruso'`);
    expect(intruso.rowCount).toBe(0);
  });

  it('UPDATE sobre filas de otro tenant afecta 0 filas y no modifica nada', async () => {
    const res = await withTenant(db, { tenantId: ids.tA }, (tx) =>
      tx.tenants.updateMany({ where: { id: ids.tB }, data: { name: 'HACK' } }),
    );
    expect(res.count).toBe(0);
    const row = await owner.query(`SELECT name FROM tenants WHERE id=$1`, [ids.tB]);
    expect(row.rows[0].name).toBe('Tenant B');
  });

  it('DELETE sobre filas de otro tenant afecta 0 filas', async () => {
    const res = await withTenant(db, { tenantId: ids.tA }, (tx) =>
      tx.roles.deleteMany({ where: { id: ids.rB } }),
    );
    expect(res.count).toBe(0);
    expect((await owner.query(`SELECT 1 FROM roles WHERE id=$1`, [ids.rB])).rowCount).toBe(1);
  });

  it('el alta de una empresa nueva exige fijar su propio id como contexto', async () => {
    const nuevo = randomUUID();
    // contexto = otro tenant: rechazado
    await expect(
      withTenant(db, { tenantId: ids.tA }, (tx) =>
        tx.tenants.create({ data: { id: nuevo, name: 'Nueva', slug: 'nueva' } }),
      ),
    ).rejects.toThrow();
    // contexto = el propio id nuevo: permitido
    await withTenant(db, { tenantId: nuevo }, (tx) =>
      tx.tenants.create({ data: { id: nuevo, name: 'Nueva', slug: 'nueva' } }),
    );
    expect((await owner.query(`SELECT 1 FROM tenants WHERE id=$1`, [nuevo])).rowCount).toBe(1);
  });
});

describe('el contexto no se filtra entre transacciones (R4: pooling)', () => {
  it('con UNA conexión reutilizada, tras una tx de A la siguiente sin contexto ve 0 filas', async () => {
    const a = await withTenant(singleConn, { tenantId: ids.tA }, (tx) => tx.tenants.count());
    expect(a).toBe(1);
    expect(await singleConn.tenants.count()).toBe(0);
  });

  it('transacciones concurrentes de A y B intercaladas ven siempre solo lo suyo', async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => {
      const tenantId = i % 2 === 0 ? ids.tA : ids.tB;
      return withTenant(db, { tenantId }, async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(0.01)`; // fuerza intercalado real
        const rows = await tx.tenants.findMany();
        return { tenantId, seen: rows.map((r) => r.id) };
      });
    });
    for (const r of await Promise.all(jobs)) expect(r.seen).toEqual([r.tenantId]);
  });

  it('rechaza ids que no son UUID (sin llegar a la base de datos)', async () => {
    await expect(withTenant(db, { tenantId: "x'; DROP TABLE tenants;--" }, async () => 1)).rejects.toThrow(/UUID/);
    await expect(withTenant(db, { tenantId: ids.tA, userId: 'no-uuid' }, async () => 1)).rejects.toThrow(/UUID/);
  });
});

describe('integridad referencial entre tenants (FK compuestas)', () => {
  it('no se puede asignar un rol de B a una membresía de A', async () => {
    await expect(
      withTenant(db, { tenantId: ids.tA }, (tx) =>
        tx.membership_roles.create({
          data: { tenant_id: ids.tA, membership_id: ids.mA, role_id: ids.rB },
        }),
      ),
    ).rejects.toThrow();
  });

  it('tampoco como rol dueño (la FK compuesta es independiente de RLS)', async () => {
    await expect(
      owner.query(`INSERT INTO membership_roles(tenant_id,membership_id,role_id) VALUES ($1,$2,$3)`, [
        ids.tA,
        ids.mA,
        ids.rB,
      ]),
    ).rejects.toThrow(/foreign key/i);
  });

  it('la asignación válida (mismo tenant) sí funciona', async () => {
    await withTenant(db, { tenantId: ids.tA }, (tx) =>
      tx.membership_roles.create({ data: { tenant_id: ids.tA, membership_id: ids.mA, role_id: ids.rA } }),
    );
    const n = await withTenant(db, { tenantId: ids.tA }, (tx) => tx.membership_roles.count());
    expect(n).toBe(1);
  });
});

describe('membresías propias del usuario (login, sin tenant activo)', () => {
  it('un usuario solo ve SUS membresías y SUS empresas', async () => {
    const ms = await withUser(db, ids.uA, (tx) => tx.tenant_memberships.findMany());
    expect(ms.map((m) => m.id)).toEqual([ids.mA]);
    const ts = await withUser(db, ids.uA, (tx) => tx.tenants.findMany());
    expect(ts.map((t) => t.id)).toEqual([ids.tA]);
  });

  it('un usuario sin membresías no ve nada', async () => {
    expect(await withUser(db, randomUUID(), (tx) => tx.tenant_memberships.count())).toBe(0);
  });
});

describe('usuario con membresías en varias empresas (regresión migración 0002)', () => {
  const uC = randomUUID();
  const mCA = randomUUID();
  const mCB = randomUUID();

  beforeAll(async () => {
    await owner.query(`INSERT INTO users(id,email,password_hash,full_name) VALUES ($1,'c@c.test','h','User C')`, [uC]);
    await owner.query(
      `INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES ($1,$2,$3),($4,$5,$3)`,
      [mCA, ids.tA, uC, mCB, ids.tB],
    );
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM tenant_memberships WHERE user_id=$1`, [uC]);
    await owner.query(`DELETE FROM users WHERE id=$1`, [uC]);
  });

  it('SIN tenant activo ve todas SUS empresas y membresías (selector de empresa al hacer login)', async () => {
    const ts = await withUser(db, uC, (tx) => tx.tenants.findMany({ orderBy: { slug: 'asc' } }));
    expect(ts.map((t) => t.slug)).toEqual(['tenant-a', 'tenant-b']);
    const ms = await withUser(db, uC, (tx) => tx.tenant_memberships.count());
    expect(ms).toBe(2);
  });

  it('CON tenant activo ve SOLO ese tenant, aunque el contexto también incluya al usuario', async () => {
    const ts = await withTenant(db, { tenantId: ids.tA, userId: uC }, (tx) => tx.tenants.findMany());
    expect(ts.map((t) => t.slug)).toEqual(['tenant-a']);

    const ms = await withTenant(db, { tenantId: ids.tB, userId: uC }, (tx) => tx.tenant_memberships.findMany());
    expect(ms.every((m) => m.tenant_id === ids.tB)).toBe(true);
  });

  it('un findFirst sin WHERE bajo un tenant activo devuelve ese tenant, no otro del usuario', async () => {
    const t = await withTenant(db, { tenantId: ids.tB, userId: uC }, (tx) => tx.tenants.findFirst());
    expect(t?.id).toBe(ids.tB);
  });
});

describe('auditoría', () => {
  it('se puede insertar bajo el tenant propio y es visible solo para ese tenant', async () => {
    await withTenant(db, { tenantId: ids.tA }, (tx) =>
      tx.audit_logs.create({
        data: { id: randomUUID(), tenant_id: ids.tA, actor_type: 'user', action: 'test.created', entity_type: 'test' },
      }),
    );
    expect(await withTenant(db, { tenantId: ids.tA }, (tx) => tx.audit_logs.count())).toBe(1);
    expect(await withTenant(db, { tenantId: ids.tB }, (tx) => tx.audit_logs.count())).toBe(0);
  });

  it('no se puede registrar una auditoría a nombre de otro tenant', async () => {
    await expect(
      withTenant(db, { tenantId: ids.tA }, (tx) =>
        tx.audit_logs.create({
          data: { id: randomUUID(), tenant_id: ids.tB, actor_type: 'user', action: 'x', entity_type: 'x' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('es append-only para el runtime: UPDATE y DELETE denegados', async () => {
    await expect(
      withTenant(db, { tenantId: ids.tA }, (tx) => tx.audit_logs.deleteMany()),
    ).rejects.toThrow(/permission denied|denegado/i);
    await expect(
      withTenant(db, { tenantId: ids.tA }, (tx) => tx.audit_logs.updateMany({ data: { action: 'tamper' } })),
    ).rejects.toThrow(/permission denied|denegado/i);
  });
});

describe('resolución pública por slug (sin contexto de tenant)', () => {
  it('devuelve solo los campos mínimos de un tenant existente', async () => {
    const rows = await db.$queryRaw<{ id: string; status: string; timezone: string; currency: string }[]>`
      SELECT * FROM rp_resolve_tenant_by_slug('tenant-b')`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ids.tB, status: 'active', timezone: 'America/Santiago', currency: 'CLP' });
    expect(Object.keys(rows[0]!).sort()).toEqual(['currency', 'id', 'status', 'timezone']);
  });

  it('un slug inexistente no devuelve filas', async () => {
    const rows = await db.$queryRaw<unknown[]>`SELECT * FROM rp_resolve_tenant_by_slug('no-existe')`;
    expect(rows).toHaveLength(0);
  });
});

describe('rp_system (BYPASSRLS)', () => {
  it('ve todos los tenants: por eso su uso queda restringido y revisado', async () => {
    const n = await system.tenants.count();
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe('catálogo de RLS (control automático de CI)', () => {
  it('toda tabla con columna tenant_id tiene RLS forzado y al menos una política', async () => {
    const res = await owner.query(`SELECT * FROM rp_rls_violations`);
    expect(res.rows).toEqual([]);
  });

  it('meta-test: la vista SÍ detecta una tabla nueva con tenant_id sin RLS', async () => {
    await owner.query(`CREATE TABLE zz_leaky (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`);
    try {
      const res = await owner.query(`SELECT table_name FROM rp_rls_violations`);
      expect(res.rows.map((r) => r.table_name)).toEqual(['zz_leaky']);
    } finally {
      await owner.query(`DROP TABLE zz_leaky`);
    }
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, withTenant } from '../src/index.js';
import { testUrls } from './urls.js';

/**
 * La garantía anti doble reserva vive en PostgreSQL (migración 0006). Estas pruebas la ejercitan DIRECTAMENTE,
 * con el rol dueño (sin RLS) y con conexiones paralelas reales: no dependen de que la aplicación haga lo correcto.
 */
const urls = testUrls();
const owner = new pg.Pool({ connectionString: urls.owner, max: 12 });
const db = createPrismaClient(urls.app, { max: 2 });
const id = () => randomUUID();

const A = id();
const B = id();
const locA = id();
const locB = id();
const resA = id();
const resA2 = id();
const resB = id();
const svcA = id();
const svcB = id();
const custA = id();
const custB = id();

const T = (h: number, m = 0) =>
  `2027-07-05T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

/** Inserta una reserva completa (reserva + ítem + ocupación) como lo haría el motor. Devuelve su id. */
async function book(
  client: pg.Pool | pg.PoolClient,
  opts: {
    tenant?: string;
    resource?: string;
    customer?: string;
    start: string;
    end: string;
    exclusive?: boolean;
    status?: string;
  },
): Promise<string> {
  const tenant = opts.tenant ?? A;
  const rid = id();
  const item = id();
  const cancelled = opts.status === 'cancelled';
  await client.query(
    `INSERT INTO reservations(id,tenant_id,code,location_id,customer_id,status,source,start_at,end_at,time_zone,total_amount,currency,cancelled_at)
     VALUES ($1,$2,$3,$4,$5,$6,'admin',$7,$8,'America/Santiago',1000,'CLP',$9)`,
    [
      rid,
      tenant,
      `RP-${rid.slice(0, 6)}`,
      tenant === A ? locA : locB,
      opts.customer ?? (tenant === A ? custA : custB),
      opts.status ?? 'confirmed',
      opts.start,
      opts.end,
      cancelled ? new Date() : null,
    ],
  );
  await client.query(
    `INSERT INTO reservation_items(id,tenant_id,reservation_id,service_id,service_name,duration_minutes,buffer_before_minutes,buffer_after_minutes,unit_price,currency,start_at,end_at)
     VALUES ($1,$2,$3,$4,'Corte',60,0,0,1000,'CLP',$5,$6)`,
    [item, tenant, rid, tenant === A ? svcA : svcB, opts.start, opts.end],
  );
  await client.query(
    `INSERT INTO reservation_resources(id,tenant_id,reservation_id,reservation_item_id,resource_id,occupy_start,occupy_end,is_exclusive,is_active)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenant,
      rid,
      item,
      opts.resource ?? resA,
      opts.start,
      opts.end,
      opts.exclusive ?? true,
      !cancelled,
    ],
  );
  return rid;
}

/** Igual que `book` pero dentro de una transacción en una conexión dedicada (para la prueba de carrera). */
async function bookInTx(start: string, end: string): Promise<'ok' | 'conflict'> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await book(c, { start, end });
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK');
    if ((e as { code?: string }).code === '23P01') return 'conflict';
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants(id,name,slug) VALUES ($1,'Res A','res-a'),($2,'Res B','res-b')`,
    [A, B],
  );
  await owner.query(
    `INSERT INTO locations(id,tenant_id,name) VALUES ($1,$2,'Centro A'),($3,$4,'Centro B')`,
    [locA, A, locB, B],
  );
  await owner.query(
    `INSERT INTO resources(id,tenant_id,location_id,kind,name) VALUES ($1,$2,$3,'staff','Ana'),($4,$2,$3,'staff','Beto'),($5,$6,$7,'staff','Carla')`,
    [resA, A, locA, resA2, resB, B, locB],
  );
  await owner.query(
    `INSERT INTO services(id,tenant_id,name,duration_minutes,price,currency) VALUES ($1,$2,'Corte',60,1000,'CLP')`,
    [svcA, A],
  );
  await owner.query(
    `INSERT INTO customers(id,tenant_id,first_name,phone_e164) VALUES ($1,$2,'Cliente A','+56911111111'),($3,$4,'Cliente B','+56922222222')`,
    [custA, A, custB, B],
  );
  // la empresa B necesita su propio servicio para sus ítems
  await owner.query(
    `INSERT INTO services(id,tenant_id,name,duration_minutes,price,currency) VALUES ($1,$2,'Corte B',60,1000,'CLP')`,
    [svcB, B],
  );
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), owner.end()]);
});

describe('anti doble reserva (EXCLUDE en PostgreSQL)', () => {
  it('rechaza dos reservas activas solapadas en el MISMO recurso', async () => {
    await book(owner, { start: T(10), end: T(11) });
    await expect(book(owner, { start: T(10, 30), end: T(11, 30) })).rejects.toMatchObject({
      code: '23P01',
    });
    await expect(book(owner, { start: T(9), end: T(12) })).rejects.toMatchObject({ code: '23P01' }); // la contiene
  });

  it('permite reservas que solo se tocan (10-11 y 11-12) y en otro recurso a la misma hora', async () => {
    await book(owner, { start: T(11), end: T(12) });
    await book(owner, { resource: resA2, start: T(10), end: T(11) });
  });

  it('cancelar LIBERA el hueco (lo hace el trigger, no la aplicación)', async () => {
    const r = await book(owner, { start: T(14), end: T(15) });
    await expect(book(owner, { start: T(14), end: T(15) })).rejects.toMatchObject({
      code: '23P01',
    });
    await owner.query(
      `UPDATE reservations SET status='cancelled', cancelled_at=now() WHERE id=$1`,
      [r],
    );
    const rr = await owner.query(
      `SELECT is_active FROM reservation_resources WHERE reservation_id=$1`,
      [r],
    );
    expect(rr.rows[0].is_active).toBe(false);
    await book(owner, { start: T(14), end: T(15) }); // ahora sí
  });

  it('reactivar una reserva cancelada cuyo hueco ya está ocupado es rechazado por la BD', async () => {
    const r = await book(owner, { start: T(16), end: T(17) });
    await owner.query(
      `UPDATE reservations SET status='cancelled', cancelled_at=now() WHERE id=$1`,
      [r],
    );
    await book(owner, { start: T(16), end: T(17) });
    await expect(
      owner.query(`UPDATE reservations SET status='confirmed', cancelled_at=NULL WHERE id=$1`, [r]),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('completada y no-show siguen ocupando su tiempo', async () => {
    const r = await book(owner, { start: T(18), end: T(19) });
    await owner.query(`UPDATE reservations SET status='completed' WHERE id=$1`, [r]);
    await expect(book(owner, { start: T(18), end: T(19) })).rejects.toMatchObject({
      code: '23P01',
    });
  });

  it('las ocupaciones NO exclusivas (capacidad > 1, fuera del MVP) no se bloquean entre sí', async () => {
    await book(owner, { resource: resA2, start: T(20), end: T(21), exclusive: false });
    await book(owner, { resource: resA2, start: T(20), end: T(21), exclusive: false });
  });

  it('CARRERA REAL: 10 transacciones en paralelo por el mismo hueco => exactamente 1 gana', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => bookInTx(T(22), T(23))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(9);
    const rows = await owner.query(
      `SELECT count(*)::int AS n FROM reservation_resources WHERE resource_id=$1 AND is_active AND occupy_start=$2`,
      [resA, T(22)],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('invariantes de la reserva', () => {
  it('cancelada <=> tiene fecha de cancelación', async () => {
    await expect(
      owner.query(
        `UPDATE reservations SET status='cancelled' WHERE code IS NOT NULL AND status='confirmed' AND start_at=$1`,
        [T(11)],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      owner.query(
        `INSERT INTO reservations(id,tenant_id,code,location_id,customer_id,status,source,start_at,end_at,time_zone,total_amount,currency,cancelled_at)
         VALUES (gen_random_uuid(),$1,'RP-BAD001',$2,$3,'confirmed','admin',$4,$5,'UTC',0,'CLP',now())`,
        [A, locA, custA, T(1), T(2)],
      ),
    ).rejects.toThrow(/check/i);
  });
  it('fin posterior al inicio, estado y origen válidos, importes no negativos', async () => {
    const ins = (status: string, source: string, start: string, end: string, amount: number) =>
      owner.query(
        `INSERT INTO reservations(id,tenant_id,code,location_id,customer_id,status,source,start_at,end_at,time_zone,total_amount,currency)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'UTC',$9,'CLP')`,
        [A, `RP-${randomUUID().slice(0, 6)}`, locA, custA, status, source, start, end, amount],
      );
    await expect(ins('confirmed', 'admin', T(2), T(2), 0)).rejects.toThrow(/check/i);
    await expect(ins('aprobada', 'admin', T(2), T(3), 0)).rejects.toThrow(/check/i);
    await expect(ins('confirmed', 'telepatia', T(2), T(3), 0)).rejects.toThrow(/check/i);
    await expect(ins('confirmed', 'admin', T(2), T(3), -1)).rejects.toThrow(/check/i);
  });
  it('el código es único por empresa', async () => {
    await owner.query(
      `INSERT INTO reservations(id,tenant_id,code,location_id,customer_id,source,start_at,end_at,time_zone,total_amount,currency) VALUES (gen_random_uuid(),$1,'RP-SAME01',$2,$3,'admin',$4,$5,'UTC',0,'CLP')`,
      [A, locA, custA, T(3), T(4)],
    );
    await expect(
      owner.query(
        `INSERT INTO reservations(id,tenant_id,code,location_id,customer_id,source,start_at,end_at,time_zone,total_amount,currency) VALUES (gen_random_uuid(),$1,'RP-SAME01',$2,$3,'admin',$4,$5,'UTC',0,'CLP')`,
        [A, locA, custA, T(4), T(5)],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });
});

describe('clientes', () => {
  it('todo cliente es contactable (teléfono o email) salvo anonimizado; teléfono E.164', async () => {
    await expect(
      owner.query(
        `INSERT INTO customers(id,tenant_id,first_name) VALUES (gen_random_uuid(),$1,'Sin contacto')`,
        [A],
      ),
    ).rejects.toThrow(/check/i);
    await owner.query(
      `INSERT INTO customers(id,tenant_id,first_name,anonymized_at) VALUES (gen_random_uuid(),$1,'Anónimo',now())`,
      [A],
    );
    await owner.query(
      `INSERT INTO customers(id,tenant_id,first_name,email) VALUES (gen_random_uuid(),$1,'Solo email','a@b.test')`,
      [A],
    );
    await expect(
      owner.query(
        `INSERT INTO customers(id,tenant_id,first_name,phone_e164) VALUES (gen_random_uuid(),$1,'Mal','912345678')`,
        [A],
      ),
    ).rejects.toThrow(/check/i);
  });
  it('el teléfono es único por empresa entre clientes no anonimizados; en otra empresa se repite', async () => {
    await expect(
      owner.query(
        `INSERT INTO customers(id,tenant_id,first_name,phone_e164) VALUES (gen_random_uuid(),$1,'Dup','+56911111111')`,
        [A],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
    await owner.query(
      `INSERT INTO customers(id,tenant_id,first_name,phone_e164) VALUES (gen_random_uuid(),$1,'Otro tenant','+56911111111')`,
      [B],
    );
  });
});

describe('aislamiento y referencias entre empresas', () => {
  it('una reserva no puede usar el cliente, la sucursal ni el recurso de otra empresa', async () => {
    await expect(book(owner, { customer: custB, start: T(5), end: T(6) })).rejects.toThrow(
      /foreign key/i,
    );
    await expect(book(owner, { resource: resB, start: T(5), end: T(6) })).rejects.toThrow(
      /foreign key/i,
    );
  });
  it('con RLS cada empresa ve solo sus reservas, clientes y ocupaciones', async () => {
    await book(owner, { tenant: B, resource: resB, start: T(7), end: T(8) });
    const seenByA = await withTenant(db, { tenantId: A }, (tx) =>
      tx.reservations.findMany({ select: { tenant_id: true } }),
    );
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((r) => r.tenant_id === A)).toBe(true);
    expect(await withTenant(db, { tenantId: B }, (tx) => tx.customers.count())).toBe(2);
    expect(await db.reservation_resources.count()).toBe(0); // sin contexto: nada
  });
  it('el historial de eventos es inmutable para el runtime', async () => {
    const r = await book(owner, { start: T(6), end: T(7) });
    await owner.query(
      `INSERT INTO reservation_events(id,tenant_id,reservation_id,type,actor_type) VALUES (gen_random_uuid(),$1,$2,'reservation.created','user')`,
      [A, r],
    );
    await expect(
      withTenant(db, { tenantId: A }, (tx) =>
        tx.reservation_events.updateMany({ data: { type: 'falsificado' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(db, { tenantId: A }, (tx) => tx.reservation_events.deleteMany()),
    ).rejects.toThrow(/permission denied/i);
  });
});

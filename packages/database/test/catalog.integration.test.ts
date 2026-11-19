import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, withTenant } from '../src/index.js';
import { testUrls } from './urls.js';

/**
 * Restricciones del catálogo y la agenda (migración 0005). Se prueban contra PostgreSQL REAL con el rol dueño
 * (que ignora RLS) para demostrar que las garantías son de la base de datos y no de la aplicación.
 */
const urls = testUrls();
const owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
const db = createPrismaClient(urls.app, { max: 2 });

const id = () => randomUUID();
const A = id();
const B = id();
const locA = id();
const locA2 = id();
const locB = id();
const resA = id();
const resB = id();
const mA = id();

async function insertLocation(tenant: string, lid: string, name: string) {
  await owner.query(`INSERT INTO locations(id,tenant_id,name) VALUES ($1,$2,$3)`, [
    lid,
    tenant,
    name,
  ]);
}
async function insertResource(
  tenant: string,
  rid: string,
  loc: string,
  name: string,
  kind = 'staff',
  membership: string | null = null,
) {
  await owner.query(
    `INSERT INTO resources(id,tenant_id,location_id,kind,name,membership_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [rid, tenant, loc, kind, name, membership],
  );
}
/** La sentencia debe ser RECHAZADA por la BD con un mensaje que cumpla `re`. */
async function rejects(sql: string, params: unknown[], re: RegExp) {
  await expect(owner.query(sql, params)).rejects.toThrow(re);
}
const hours = (loc: string, wd: number, s: number, e: number) =>
  owner.query(
    `INSERT INTO business_hours(id,tenant_id,location_id,weekday,start_minute,end_minute) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
    [A, loc, wd, s, e],
  );

beforeAll(async () => {
  await owner.query(
    `INSERT INTO tenants(id,name,slug) VALUES ($1,'Catálogo A','catalogo-a'),($2,'Catálogo B','catalogo-b')`,
    [A, B],
  );
  const u = id();
  await owner.query(
    `INSERT INTO users(id,email,password_hash,full_name) VALUES ($1,'cat@x.test','h','Cat')`,
    [u],
  );
  await owner.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES ($1,$2,$3)`, [
    mA,
    A,
    u,
  ]);
  await insertLocation(A, locA, 'Sucursal Centro');
  await insertLocation(A, locA2, 'Sucursal Norte');
  await insertLocation(B, locB, 'Sucursal Centro'); // mismo nombre, OTRA empresa: permitido
  await insertResource(A, resA, locA, 'Ana');
  await insertResource(B, resB, locB, 'Beto');
});
afterAll(async () => {
  await Promise.all([db.$disconnect(), owner.end()]);
});

describe('aislamiento (RLS) del catálogo', () => {
  it('cada empresa ve solo lo suyo y sin contexto no ve nada', async () => {
    const a = await withTenant(db, { tenantId: A }, (tx) => tx.locations.findMany());
    expect(a.map((l) => l.id).sort()).toEqual([locA, locA2].sort());
    expect(await withTenant(db, { tenantId: B }, (tx) => tx.locations.count())).toBe(1);
    expect(await db.locations.count()).toBe(0);
    expect(await db.resources.count()).toBe(0);
    expect(await db.availability_blocks.count()).toBe(0);
  });

  it('no se puede insertar ni modificar filas de otra empresa', async () => {
    await expect(
      withTenant(db, { tenantId: A }, (tx) =>
        tx.locations.create({ data: { id: id(), tenant_id: B, name: 'Intruso' } }),
      ),
    ).rejects.toThrow();
    const res = await withTenant(db, { tenantId: A }, (tx) =>
      tx.locations.updateMany({ where: { id: locB }, data: { name: 'HACK' } }),
    );
    expect(res.count).toBe(0);
  });
});

describe('claves foráneas COMPUESTAS: nada cruza empresas', () => {
  it('un recurso no puede apuntar a la sucursal de otra empresa', async () => {
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name) VALUES ($1,$2,$3,'staff','Cruzado')`,
      [id(), A, locB],
      /foreign key/i,
    );
  });
  it('un servicio no puede usar una categoría de otra empresa', async () => {
    const cat = id();
    await owner.query(`INSERT INTO service_categories(id,tenant_id,name) VALUES ($1,$2,'Cortes')`, [
      cat,
      B,
    ]);
    await rejects(
      `INSERT INTO services(id,tenant_id,category_id,name,duration_minutes,price,currency) VALUES ($1,$2,$3,'Corte',30,1000,'CLP')`,
      [id(), A, cat],
      /foreign key/i,
    );
  });
  it('los vínculos servicio↔sucursal y servicio↔recurso no mezclan empresas', async () => {
    const svc = id();
    await owner.query(
      `INSERT INTO services(id,tenant_id,name,duration_minutes,price,currency) VALUES ($1,$2,'Servicio A',30,1000,'CLP')`,
      [svc, A],
    );
    await rejects(
      `INSERT INTO service_locations(tenant_id,service_id,location_id) VALUES ($1,$2,$3)`,
      [A, svc, locB],
      /foreign key/i,
    );
    await rejects(
      `INSERT INTO service_resources(tenant_id,service_id,resource_id) VALUES ($1,$2,$3)`,
      [A, svc, resB],
      /foreign key/i,
    );
    await owner.query(
      `INSERT INTO service_locations(tenant_id,service_id,location_id) VALUES ($1,$2,$3)`,
      [A, svc, locA],
    );
    await owner.query(
      `INSERT INTO service_resources(tenant_id,service_id,resource_id) VALUES ($1,$2,$3)`,
      [A, svc, resA],
    );
  });
  it('horarios, excepciones y bloqueos tampoco cruzan empresas', async () => {
    await rejects(
      `INSERT INTO business_hours(id,tenant_id,location_id,weekday,start_minute,end_minute) VALUES (gen_random_uuid(),$1,$2,1,540,1080)`,
      [A, locB],
      /foreign key/i,
    );
    await rejects(
      `INSERT INTO resource_schedules(id,tenant_id,resource_id,weekday,start_minute,end_minute) VALUES (gen_random_uuid(),$1,$2,1,540,1080)`,
      [A, resB],
      /foreign key/i,
    );
    await rejects(
      `INSERT INTO schedule_overrides(id,tenant_id,resource_id,on_date,start_minute,end_minute) VALUES (gen_random_uuid(),$1,$2,'2027-01-05',540,600)`,
      [A, resB],
      /foreign key/i,
    );
    await rejects(
      `INSERT INTO availability_blocks(id,tenant_id,resource_id,kind,start_at,end_at) VALUES (gen_random_uuid(),$1,$2,'manual',now(),now()+interval '1 hour')`,
      [A, resB],
      /foreign key/i,
    );
  });
  it('un recurso solo se vincula a un usuario de SU empresa', async () => {
    const otherUser = id();
    const mB = id();
    await owner.query(
      `INSERT INTO users(id,email,password_hash,full_name) VALUES ($1,'catb@x.test','h','Cat B')`,
      [otherUser],
    );
    await owner.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES ($1,$2,$3)`, [
      mB,
      B,
      otherUser,
    ]);
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name,membership_id) VALUES ($1,$2,$3,'staff','Pirata',$4)`,
      [id(), A, locA, mB],
      /foreign key/i,
    );
  });
});

describe('nombres únicos (sin distinguir mayúsculas)', () => {
  it('sucursales, categorías y servicios: único por empresa', async () => {
    await rejects(
      `INSERT INTO locations(id,tenant_id,name) VALUES ($1,$2,'SUCURSAL CENTRO')`,
      [id(), A],
      /duplicate|unique/i,
    );
    await owner.query(`INSERT INTO service_categories(id,tenant_id,name) VALUES ($1,$2,'Color')`, [
      id(),
      A,
    ]);
    await rejects(
      `INSERT INTO service_categories(id,tenant_id,name) VALUES ($1,$2,'color')`,
      [id(), A],
      /duplicate|unique/i,
    );
    await owner.query(
      `INSERT INTO services(id,tenant_id,name,duration_minutes,price,currency) VALUES ($1,$2,'Tintura',60,5000,'CLP')`,
      [id(), A],
    );
    await rejects(
      `INSERT INTO services(id,tenant_id,name,duration_minutes,price,currency) VALUES ($1,$2,'tintura',60,5000,'CLP')`,
      [id(), A],
      /duplicate|unique/i,
    );
  });
  it('un recurso: único por sucursal, pero el mismo nombre en otra sucursal sí', async () => {
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name) VALUES ($1,$2,$3,'staff','ANA')`,
      [id(), A, locA],
      /duplicate|unique/i,
    );
    await insertResource(A, id(), locA2, 'Ana'); // otra sucursal: permitido
  });
  it('los nombres demasiado cortos o largos se rechazan', async () => {
    await rejects(
      `INSERT INTO locations(id,tenant_id,name) VALUES ($1,$2,'X')`,
      [id(), A],
      /check/i,
    );
    await rejects(
      `INSERT INTO locations(id,tenant_id,name) VALUES ($1,$2,$3)`,
      [id(), A, 'x'.repeat(101)],
      /check/i,
    );
  });
});

describe('recursos', () => {
  it('solo el personal (staff) puede vincularse a un usuario, y un usuario es un solo recurso', async () => {
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name,membership_id) VALUES ($1,$2,$3,'room','Sala 1',$4)`,
      [id(), A, locA, mA],
      /check/i,
    );
    await insertResource(A, id(), locA, 'María', 'staff', mA);
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name,membership_id) VALUES ($1,$2,$3,'staff','María bis',$4)`,
      [id(), A, locA2, mA],
      /duplicate|unique/i,
    );
  });
  it('tipo y capacidad válidos', async () => {
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name) VALUES ($1,$2,$3,'dragon','Smaug')`,
      [id(), A, locA],
      /check/i,
    );
    await rejects(
      `INSERT INTO resources(id,tenant_id,location_id,kind,name,capacity) VALUES ($1,$2,$3,'room','Sala 0',0)`,
      [id(), A, locA],
      /check/i,
    );
  });
});

describe('servicios: invariantes numéricas', () => {
  const ins = (extra: string, vals: unknown[]) =>
    owner.query(
      `INSERT INTO services(id,tenant_id,name,duration_minutes,price,currency${extra.split('|')[0]}) VALUES ($1,$2,$3,$4,$5,'CLP'${extra.split('|')[1] ?? ''})`,
      [id(), A, `S-${id()}`, ...vals],
    );
  it('duración 1..1440 y precio ≥ 0', async () => {
    await expect(ins('', [0, 100])).rejects.toThrow(/check/i);
    await expect(ins('', [1441, 100])).rejects.toThrow(/check/i);
    await expect(ins('', [30, -1])).rejects.toThrow(/check/i);
    await ins('', [1440, 0]); // extremos válidos
    await ins('', [1, 99999999.99]);
  });
  it('buffers 0..240, antelación mínima ≥ 0 y máxima 1..730', async () => {
    await expect(ins(',buffer_before_minutes|,$6', [30, 100, 241])).rejects.toThrow(/check/i);
    await expect(ins(',buffer_after_minutes|,$6', [30, 100, -5])).rejects.toThrow(/check/i);
    await expect(ins(',max_advance_days|,$6', [30, 100, 0])).rejects.toThrow(/check/i);
    await expect(ins(',max_advance_days|,$6', [30, 100, 731])).rejects.toThrow(/check/i);
    await expect(ins(',min_notice_minutes|,$6', [30, 100, -1])).rejects.toThrow(/check/i);
  });
});

describe('horarios semanales de la sucursal (EXCLUDE: sin solapes)', () => {
  it('rechaza tramos que se pisan, pero acepta los que solo se tocan', async () => {
    await hours(locA, 1, 540, 780); // lun 09:00-13:00
    await expect(hours(locA, 1, 720, 900)).rejects.toThrow(/business_hours_no_overlap|exclusion/i); // 12-15 pisa
    await expect(hours(locA, 1, 600, 660)).rejects.toThrow(/exclusion/i); // contenido
    await hours(locA, 1, 780, 1080); // 13:00-18:00 toca el borde: permitido (turno partido)
  });
  it('otro día u otra sucursal no interfieren; se permite cerrar a las 24:00', async () => {
    await hours(locA, 2, 540, 780);
    await hours(locA2, 1, 540, 780);
    await hours(locA, 5, 1080, 1440); // viernes 18:00-24:00
  });
  it('minutos y días inválidos se rechazan', async () => {
    await expect(hours(locA, 3, 600, 600)).rejects.toThrow(/check/i); // vacío
    await expect(hours(locA, 3, 700, 600)).rejects.toThrow(/check/i); // invertido
    await expect(hours(locA, 3, 0, 1441)).rejects.toThrow(/check/i); // pasa de 24:00
    await expect(hours(locA, 3, -1, 60)).rejects.toThrow(/check/i);
    await expect(hours(locA, 0, 60, 120)).rejects.toThrow(/check/i); // weekday ISO: 1..7
    await expect(hours(locA, 8, 60, 120)).rejects.toThrow(/check/i);
  });
});

describe('horarios del recurso con vigencia', () => {
  const sched = (wd: number, s: number, e: number, from: string | null, to: string | null) =>
    owner.query(
      `INSERT INTO resource_schedules(id,tenant_id,resource_id,weekday,start_minute,end_minute,valid_from,valid_to) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
      [A, resA, wd, s, e, from, to],
    );

  it('mismo horario en vigencias DISTINTAS convive (temporada alta / baja)', async () => {
    await sched(1, 540, 1080, '2027-01-01', '2027-03-31');
    await sched(1, 540, 1080, '2027-04-01', '2027-06-30');
  });
  it('rechaza vigencias que se pisan, incluidas las abiertas', async () => {
    await expect(sched(1, 600, 700, '2027-03-15', '2027-04-15')).rejects.toThrow(
      /resource_schedules_no_overlap|exclusion/i,
    );
    await expect(sched(1, 600, 700, null, null)).rejects.toThrow(/exclusion/i); // sin límites pisa todo
    await expect(sched(1, 600, 700, '2027-06-30', null)).rejects.toThrow(/exclusion/i); // comparte el 30-jun (límites inclusivos)
  });
  it('tramos horarios distintos con la misma vigencia no se pisan', async () => {
    await sched(1, 1080, 1200, '2027-01-01', '2027-03-31');
  });
  it('vigencia invertida se rechaza', async () => {
    await expect(sched(2, 540, 600, '2027-05-01', '2027-04-01')).rejects.toThrow(/check/i);
  });
});

describe('excepciones por fecha', () => {
  const ov = (
    scope: { loc?: string; res?: string },
    date: string,
    closed: boolean,
    s: number,
    e: number,
  ) =>
    owner.query(
      `INSERT INTO schedule_overrides(id,tenant_id,location_id,resource_id,on_date,is_closed,start_minute,end_minute) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
      [A, scope.loc ?? null, scope.res ?? null, date, closed, s, e],
    );

  it('un día cerrado NO admite tramos abiertos el mismo día (ni al revés)', async () => {
    await ov({ loc: locA }, '2027-12-25', true, 0, 1440);
    await expect(ov({ loc: locA }, '2027-12-25', false, 600, 700)).rejects.toThrow(
      /schedule_overrides_no_overlap|exclusion/i,
    );
    await expect(ov({ loc: locA }, '2027-12-25', true, 0, 1440)).rejects.toThrow(/exclusion/i);
    await ov({ loc: locA }, '2027-12-26', false, 600, 700);
    await expect(ov({ loc: locA }, '2027-12-26', true, 0, 1440)).rejects.toThrow(/exclusion/i);
  });
  it('varios tramos abiertos que no se pisan en el mismo día, sí', async () => {
    await ov({ loc: locA }, '2027-12-27', false, 540, 780);
    await ov({ loc: locA }, '2027-12-27', false, 840, 1080);
  });
  it('la excepción de una sucursal y la de un recurso del mismo día no se pisan entre sí', async () => {
    await ov({ res: resA }, '2027-12-25', false, 600, 700); // la sucursal está cerrada ese día; el recurso es otro ámbito
  });
  it('exige exactamente UN ámbito y coherencia de "cerrado"', async () => {
    await expect(ov({}, '2027-11-01', false, 540, 600)).rejects.toThrow(/check/i); // ningún ámbito
    await expect(ov({ loc: locA, res: resA }, '2027-11-01', false, 540, 600)).rejects.toThrow(
      /check/i,
    ); // dos ámbitos
    await expect(ov({ loc: locA }, '2027-11-02', true, 540, 600)).rejects.toThrow(/check/i); // cerrado debe ser 0-1440
  });
});

describe('feriados y bloqueos', () => {
  it('un feriado por fecha y empresa', async () => {
    await owner.query(
      `INSERT INTO holidays(tenant_id,on_date,name) VALUES ($1,'2027-09-18','Fiestas Patrias')`,
      [A],
    );
    await expect(
      owner.query(`INSERT INTO holidays(tenant_id,on_date,name) VALUES ($1,'2027-09-18','Otro')`, [
        A,
      ]),
    ).rejects.toThrow(/duplicate|unique/i);
    await owner.query(
      `INSERT INTO holidays(tenant_id,on_date,name) VALUES ($1,'2027-09-18','Fiestas Patrias')`,
      [B],
    ); // otra empresa: permitido
  });
  it('bloqueos: fin posterior al inicio, máx. 366 días y tipo válido', async () => {
    const blk = (kind: string, from: string, to: string) =>
      owner.query(
        `INSERT INTO availability_blocks(id,tenant_id,resource_id,kind,start_at,end_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
        [A, resA, kind, from, to],
      );
    await blk('time_off', '2027-02-01T12:00:00Z', '2027-02-05T12:00:00Z');
    await expect(blk('manual', '2027-02-01T12:00:00Z', '2027-02-01T12:00:00Z')).rejects.toThrow(
      /check/i,
    );
    await expect(blk('manual', '2027-02-02T12:00:00Z', '2027-02-01T12:00:00Z')).rejects.toThrow(
      /check/i,
    );
    await expect(blk('manual', '2027-01-01T00:00:00Z', '2028-02-01T00:00:00Z')).rejects.toThrow(
      /check/i,
    ); // > 366 días
    await expect(blk('vacaciones', '2027-02-01T12:00:00Z', '2027-02-02T12:00:00Z')).rejects.toThrow(
      /check/i,
    );
  });
  it('la dirección de una sucursal tiene tamaño máximo', async () => {
    await expect(
      owner.query(`UPDATE locations SET address = $1::jsonb WHERE id=$2`, [
        JSON.stringify({ calle: 'x'.repeat(2100) }),
        locA,
      ]),
    ).rejects.toThrow(/check/i);
  });
});

describe('integridad al borrar', () => {
  it('no se puede borrar una sucursal con recursos ni un recurso vinculado a un servicio', async () => {
    await expect(owner.query(`DELETE FROM locations WHERE id=$1`, [locA])).rejects.toThrow(
      /foreign key/i,
    );
    await expect(owner.query(`DELETE FROM resources WHERE id=$1`, [resA])).rejects.toThrow(
      /foreign key/i,
    );
  });
});

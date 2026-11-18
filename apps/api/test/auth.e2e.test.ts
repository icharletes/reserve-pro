import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '@reservepro/contracts';
import {
  PASSWORD,
  addMembership,
  cookieValue,
  createTestApp,
  http,
  login,
  ownerPool,
  register,
} from './helpers.js';

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

describe('salud y formato de errores', () => {
  it('liveness y readiness responden', async () => {
    expect((await http(app).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await http(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database).toBe('up');
  });

  it('los errores son application/problem+json con código estable y requestId', async () => {
    const res = await http(app).get('/api/v1/no-existe');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('acepta un x-request-id válido del cliente y descarta uno inseguro', async () => {
    const ok = await http(app).get('/health').set('x-request-id', 'trace-abc-12345');
    expect(ok.headers['x-request-id']).toBe('trace-abc-12345');
    const bad = await http(app).get('/health').set('x-request-id', 'id con espacios <script>alert(1)</script>');
    expect(bad.headers['x-request-id']).not.toContain('script');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/); // se reemplazó por un uuid
  });

  it('envía cabeceras de seguridad (helmet)', async () => {
    const res = await http(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('registro', () => {
  it('crea usuario, empresa, roles y membresía de propietario', async () => {
    const r = await register(app);
    expect(r.body.memberships).toHaveLength(1);
    expect(r.body.activeTenantId).toBe(r.tenantId);
    expect(r.body.accessToken).toBeTruthy();

    const me = await http(app).get('/api/v1/me').set(r.auth);
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['owner']);
    expect(me.body.permissions).toHaveLength(PERMISSION_KEYS.length);
    expect(me.body.tenant.id).toBe(r.tenantId);

    const roles = await owner.query(`SELECT key FROM roles WHERE tenant_id=$1 ORDER BY key`, [r.tenantId]);
    expect(roles.rows.map((x) => x.key)).toEqual(['admin', 'manager', 'owner', 'professional', 'receptionist']);
  });

  it('el refresh token viaja SOLO en cookie HttpOnly y nunca en el JSON', async () => {
    const res = await http(app)
      .post('/api/v1/auth/register')
      .send({ email: 'cookie@example.test', password: PASSWORD, fullName: 'Ana Pérez', businessName: 'Cookie Shop' });
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rp_refresh='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(JSON.stringify(res.body)).not.toContain(cookieValue([cookie])!);
  });

  it('genera slugs distintos para negocios con el mismo nombre', async () => {
    const a = await register(app, { businessName: 'Peluquería Central' });
    const b = await register(app, { businessName: 'Peluquería Central' });
    const slugs = [a, b].map((x) => x.body.memberships[0]!.tenantSlug);
    expect(slugs[0]).toBe('peluqueria-central');
    expect(slugs[1]).not.toBe(slugs[0]);
    expect(slugs[1]).toMatch(/^peluqueria-central-[0-9a-f]{4}$/);
  });

  it('rechaza email duplicado, slug reservado y slug ocupado', async () => {
    const a = await register(app, { slug: 'mi-slug-unico' });
    const dup = await http(app)
      .post('/api/v1/auth/register')
      .send({ email: a.email, password: PASSWORD, fullName: 'Otro', businessName: 'Otro Negocio' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');

    const reserved = await http(app)
      .post('/api/v1/auth/register')
      .send({ email: 'r@example.test', password: PASSWORD, fullName: 'Rosa Ruiz', businessName: 'Reservado', slug: 'admin' });
    expect(reserved.body.code).toBe('SLUG_TAKEN');

    const taken = await http(app)
      .post('/api/v1/auth/register')
      .send({ email: 't@example.test', password: PASSWORD, fullName: 'Tomás Toro', businessName: 'Tomado', slug: 'mi-slug-unico' });
    expect(taken.body.code).toBe('SLUG_TAKEN');
  });

  it('valida los datos con errores por campo', async () => {
    const res = await http(app)
      .post('/api/v1/auth/register')
      .send({ email: 'no-es-email', password: 'corta', fullName: 'A', businessName: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'fullName', 'businessName']));
  });

  it('no registra nada si falla a mitad (transacción atómica)', async () => {
    const before = await owner.query(`SELECT count(*)::int AS n FROM users`);
    await http(app).post('/api/v1/auth/register').send({ email: 'x@example.test', password: 'corta' });
    const after = await owner.query(`SELECT count(*)::int AS n FROM users`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('no guarda la contraseña en claro (Argon2id)', async () => {
    const r = await register(app);
    const row = await owner.query(`SELECT password_hash FROM users WHERE email=$1`, [r.email]);
    expect(row.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(row.rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('deja auditoría tenant.created en la misma transacción', async () => {
    const r = await register(app);
    const rows = await owner.query(`SELECT action, actor_id FROM audit_logs WHERE tenant_id=$1`, [r.tenantId]);
    expect(rows.rows).toEqual([{ action: 'tenant.created', actor_id: r.body.user.id }]);
  });
});

describe('login', () => {
  it('autentica y activa la empresa única', async () => {
    const r = await register(app);
    const l = await login(app, r.email);
    expect(l.res.status).toBe(200);
    expect(l.body.activeTenantId).toBe(r.tenantId);
    expect(l.refresh).toBeTruthy();
  });

  it('da la MISMA respuesta para contraseña incorrecta y email inexistente', async () => {
    const r = await register(app);
    const wrong = await login(app, r.email, { password: 'incorrecta-123456' });
    const unknown = await login(app, 'nadie@example.test');
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.res.body.detail).toBe(unknown.res.body.detail);
  });

  it('bloquea la cuenta tras 5 intentos fallidos, incluso con la contraseña correcta', async () => {
    const r = await register(app);
    for (let i = 0; i < 5; i++) await login(app, r.email, { password: 'incorrecta-123456' });
    const locked = await login(app, r.email); // contraseña correcta
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('una cuenta desactivada no puede iniciar sesión', async () => {
    const r = await register(app);
    await owner.query(`UPDATE users SET status='disabled' WHERE email=$1`, [r.email]);
    expect((await login(app, r.email)).res.status).toBe(401);
  });

  it('la respuesta nunca incluye el hash de la contraseña', async () => {
    const r = await register(app);
    const l = await login(app, r.email);
    expect(JSON.stringify(l.res.body)).not.toMatch(/password|argon2/i);
  });
});

describe('tokens de acceso', () => {
  it('sin token o con token basura: 401', async () => {
    expect((await http(app).get('/api/v1/me')).status).toBe(401);
    const bad = await http(app).get('/api/v1/me').set('Authorization', 'Bearer abc.def.ghi');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('TOKEN_INVALID');
  });

  it('rechaza un token con alg=none', async () => {
    const r = await register(app);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: r.body.user.id,
      sid: 'x',
      iss: 'reservepro',
      aud: 'reservepro-api',
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    expect((await http(app).get('/api/v1/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('un token bien firmado pero con claims que no son UUID da 401, no 500 (regresión)', async () => {
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ sid: "x'; DROP TABLE users;--" })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('no-es-uuid')
      .setIssuer('reservepro')
      .setAudience('reservepro-api')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(process.env['JWT_ACCESS_SECRET']!));
    const res = await http(app).get('/api/v1/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('un token firmado con otro secreto es rechazado', async () => {
    const { SignJWT } = await import('jose');
    const r = await register(app);
    const fake = await new SignJWT({ sid: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(r.body.user.id)
      .setIssuer('reservepro')
      .setAudience('reservepro-api')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('otro-secreto-distinto-de-32-caracteres-xx'));
    expect((await http(app).get('/api/v1/me').set('Authorization', `Bearer ${fake}`)).status).toBe(401);
  });
});

describe('refresh con rotación y detección de reutilización', () => {
  it('exige la cabecera anti-CSRF', async () => {
    const r = await register(app);
    const res = await http(app).post('/api/v1/auth/refresh').set('Cookie', `rp_refresh=${r.refresh}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_REJECTED');
  });

  it('rota el token y entrega un access token válido', async () => {
    const r = await register(app);
    const res = await http(app)
      .post('/api/v1/auth/refresh')
      .set('x-rp-csrf', '1')
      .set('Cookie', `rp_refresh=${r.refresh}`);
    expect(res.status).toBe(200);
    const next = cookieValue(res.headers['set-cookie'])!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(r.refresh);
    const me = await http(app).get('/api/v1/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('reutilizar un token ya rotado revoca TODA la sesión (posible robo)', async () => {
    const r = await register(app);
    const rotated = await http(app)
      .post('/api/v1/auth/refresh')
      .set('x-rp-csrf', '1')
      .set('Cookie', `rp_refresh=${r.refresh}`);
    const newest = cookieValue(rotated.headers['set-cookie'])!;

    // El atacante reutiliza el token viejo…
    const replay = await http(app)
      .post('/api/v1/auth/refresh')
      .set('x-rp-csrf', '1')
      .set('Cookie', `rp_refresh=${r.refresh}`);
    expect(replay.status).toBe(401);

    // …y la sesión legítima también queda muerta, igual que su access token.
    const legit = await http(app)
      .post('/api/v1/auth/refresh')
      .set('x-rp-csrf', '1')
      .set('Cookie', `rp_refresh=${newest}`);
    expect(legit.status).toBe(401);
    const me = await http(app).get('/api/v1/me').set('Authorization', `Bearer ${rotated.body.accessToken}`);
    expect(me.status).toBe(401);
  });

  it('dos refresh simultáneos con el mismo token: no pueden ganar ambos', async () => {
    const r = await register(app);
    const call = () =>
      http(app).post('/api/v1/auth/refresh').set('x-rp-csrf', '1').set('Cookie', `rp_refresh=${r.refresh}`);
    const results = await Promise.all([call(), call(), call()]);
    expect(results.filter((x) => x.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('un refresh token inventado: 401', async () => {
    const res = await http(app)
      .post('/api/v1/auth/refresh')
      .set('x-rp-csrf', '1')
      .set('Cookie', 'rp_refresh=inventado');
    expect(res.status).toBe(401);
  });
});

describe('logout', () => {
  it('invalida la sesión y su access token de inmediato', async () => {
    const r = await register(app);
    expect((await http(app).get('/api/v1/me').set(r.auth)).status).toBe(200);

    const out = await http(app).post('/api/v1/auth/logout').set('x-rp-csrf', '1').set('Cookie', `rp_refresh=${r.refresh}`);
    expect(out.status).toBe(204);

    expect((await http(app).get('/api/v1/me').set(r.auth)).status).toBe(401);
    const refresh = await http(app)
      .post('/api/v1/auth/refresh')
      .set('x-rp-csrf', '1')
      .set('Cookie', `rp_refresh=${r.refresh}`);
    expect(refresh.status).toBe(401);
  });

  it('es idempotente y exige CSRF', async () => {
    expect((await http(app).post('/api/v1/auth/logout')).status).toBe(403);
    const again = await http(app).post('/api/v1/auth/logout').set('x-rp-csrf', '1');
    expect(again.status).toBe(204);
  });
});

describe('varias empresas y cambio de empresa activa', () => {
  it('sin empresa activa solo funcionan los endpoints @Authenticated', async () => {
    const a = await register(app);
    const b = await register(app);
    const userA = a.body.user.id;
    await owner.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES (gen_random_uuid(),$1,$2)`, [
      b.tenantId,
      userA,
    ]);

    const l = await login(app, a.email);
    expect(l.body.memberships).toHaveLength(2);
    expect(l.body.activeTenantId).toBeNull();

    expect((await http(app).get('/api/v1/me').set(l.auth)).status).toBe(200);
    const blocked = await http(app).get('/api/v1/tenants/current').set(l.auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TENANT_REQUIRED');
  });

  it('switch-tenant activa la empresa elegida; una ajena da 403', async () => {
    const a = await register(app);
    const b = await register(app);
    const c = await register(app);
    await addMembership(owner, { tenantId: b.tenantId, userId: a.body.user.id, roleKey: 'admin' });
    const l = await login(app, a.email);

    const sw = await http(app).post('/api/v1/auth/switch-tenant').set(l.auth).send({ tenantId: b.tenantId });
    expect(sw.status).toBe(200);
    const cur = await http(app)
      .get('/api/v1/tenants/current')
      .set('Authorization', `Bearer ${sw.body.accessToken}`);
    expect(cur.body.id).toBe(b.tenantId);

    const foreign = await http(app).post('/api/v1/auth/switch-tenant').set(l.auth).send({ tenantId: c.tenantId });
    expect(foreign.status).toBe(403);
  });
});

describe('RBAC', () => {
  it('un profesional lee la empresa pero no puede modificarla', async () => {
    const a = await register(app);
    const p = await register(app); // otro usuario que será profesional en la empresa de A
    await owner.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES (gen_random_uuid(),$1,$2)`, [
      a.tenantId,
      p.body.user.id,
    ]);
    const mId = (
      await owner.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [a.tenantId, p.body.user.id])
    ).rows[0].id;
    await owner.query(
      `INSERT INTO membership_roles(tenant_id,membership_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND key='professional'`,
      [a.tenantId, mId],
    );

    const l = await login(app, p.email, { tenantId: a.tenantId });
    expect((await http(app).get('/api/v1/tenants/current').set(l.auth)).status).toBe(200);
    const patch = await http(app).patch('/api/v1/tenants/current').set(l.auth).send({ name: 'Hackeado' });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe('FORBIDDEN');
    const name = await owner.query(`SELECT name FROM tenants WHERE id=$1`, [a.tenantId]);
    expect(name.rows[0].name).not.toBe('Hackeado');
  });

  it('desactivar la membresía surte efecto inmediato, sin esperar a que expire el token', async () => {
    const r = await register(app);
    expect((await http(app).get('/api/v1/tenants/current').set(r.auth)).status).toBe(200);
    await owner.query(`UPDATE tenant_memberships SET status='disabled' WHERE tenant_id=$1`, [r.tenantId]);
    expect((await http(app).get('/api/v1/tenants/current').set(r.auth)).status).toBe(401);
  });

  it('una empresa suspendida bloquea el acceso de todos sus usuarios', async () => {
    const r = await register(app);
    await owner.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [r.tenantId]);
    expect((await http(app).get('/api/v1/tenants/current').set(r.auth)).status).toBe(401);
  });

  it('desactivar el usuario invalida su token existente', async () => {
    const r = await register(app);
    await owner.query(`UPDATE users SET status='disabled' WHERE email=$1`, [r.email]);
    expect((await http(app).get('/api/v1/me').set(r.auth)).status).toBe(401);
  });
});

describe('aislamiento entre empresas a través de la API', () => {
  it('cada empresa ve y modifica solo la suya, y todo queda auditado', async () => {
    const a = await register(app, { businessName: 'Empresa Alfa' });
    const b = await register(app, { businessName: 'Empresa Beta' });

    expect((await http(app).get('/api/v1/tenants/current').set(a.auth)).body.name).toBe('Empresa Alfa');
    expect((await http(app).get('/api/v1/tenants/current').set(b.auth)).body.name).toBe('Empresa Beta');

    const patch = await http(app).patch('/api/v1/tenants/current').set(a.auth).send({ name: 'Alfa Renombrada' });
    expect(patch.status).toBe(200);

    const names = await owner.query(`SELECT id, name FROM tenants WHERE id = ANY($1)`, [[a.tenantId, b.tenantId]]);
    const byId = Object.fromEntries(names.rows.map((r) => [r.id, r.name]));
    expect(byId[a.tenantId]).toBe('Alfa Renombrada');
    expect(byId[b.tenantId]).toBe('Empresa Beta'); // B intacta

    const audit = await owner.query(
      `SELECT tenant_id, before->>'name' AS antes, after->>'name' AS despues
         FROM audit_logs WHERE action='tenant.updated' AND tenant_id = ANY($1)`,
      [[a.tenantId, b.tenantId]],
    );
    expect(audit.rows).toEqual([{ tenant_id: a.tenantId, antes: 'Empresa Alfa', despues: 'Alfa Renombrada' }]);
  });

  it('un token con tenant de OTRA empresa (credenciales cruzadas) es rechazado', async () => {
    // Simula un bug de emisión: token válido y firmado, pero con tid/mid que no pertenecen al usuario.
    const { SignJWT } = await import('jose');
    const a = await register(app);
    const b = await register(app);
    const bMembership = (
      await owner.query(`SELECT id FROM tenant_memberships WHERE tenant_id=$1`, [b.tenantId])
    ).rows[0].id;

    // sid REAL de la sesión de A (se lee del payload de su token): el ataque es solo el tenant cruzado.
    const sid = JSON.parse(Buffer.from(a.body.accessToken.split('.')[1]!, 'base64url').toString()).sid as string;

    const forged = await new SignJWT({ sid, tid: b.tenantId, mid: bMembership })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(a.body.user.id) // usuario A…
      .setIssuer('reservepro')
      .setAudience('reservepro-api')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(process.env['JWT_ACCESS_SECRET']!));

    const res = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401); // …con la membresía de B: la BD no la asocia a A
    expect(JSON.stringify(res.body)).not.toContain(b.tenantId);
  });

  it('el cuerpo de la petición no puede cambiar de tenant ni forzar campos internos', async () => {
    const a = await register(app);
    const b = await register(app);
    const res = await http(app)
      .patch('/api/v1/tenants/current')
      .set(a.auth)
      .send({ name: 'Nombre Válido', id: b.tenantId, tenant_id: b.tenantId, status: 'cancelled', slug: 'pirata' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(a.tenantId);
    const row = await owner.query(`SELECT slug, status FROM tenants WHERE id=$1`, [a.tenantId]);
    expect(row.rows[0].status).toBe('active');
    expect(row.rows[0].slug).not.toBe('pirata');
  });

  it('PATCH valida: vacío o zona horaria inválida => 400', async () => {
    const a = await register(app);
    expect((await http(app).patch('/api/v1/tenants/current').set(a.auth).send({})).status).toBe(400);
    expect(
      (await http(app).patch('/api/v1/tenants/current').set(a.auth).send({ timezone: 'Marte/Olympus' })).status,
    ).toBe(400);
  });
});

describe('slugs reservados', () => {
  it('la lista de @reservepro/contracts coincide EXACTAMENTE con la tabla reserved_slugs', async () => {
    const { RESERVED_SLUGS } = await import('@reservepro/contracts');
    const db = await owner.query(`SELECT slug FROM reserved_slugs ORDER BY slug`);
    expect(db.rows.map((r) => r.slug)).toEqual([...RESERVED_SLUGS].sort());
  });
});

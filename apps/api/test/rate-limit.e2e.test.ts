import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, createTestApp, http, login, register } from './helpers.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
let redis: Redis;
let app: INestApplication | undefined;

async function clearLimits(): Promise<void> {
  const keys = await redis.keys('rl:test:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(() => {
  redis = new Redis(REDIS_URL);
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(clearLimits);
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const uniqueEmail = () => `rl-${randomUUID().slice(0, 8)}@example.test`;
const badLogin = (a: INestApplication, email: string) =>
  http(a).post('/api/v1/auth/login').send({ email, password: 'incorrecta-123456' });

describe('rate limiting con Redis', () => {
  it('login: más de 20 intentos por minuto desde una IP => 429 con Retry-After y problem+json', async () => {
    app = await createTestApp([], { rateLimit: true, env: { REDIS_URL, TRUST_PROXY: '0' } });
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await badLogin(app, uniqueEmail())).status);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);

    const blocked = await badLogin(app, uniqueEmail());
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    const retry = Number(blocked.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(blocked.body.requestId).toBeTruthy();
  });

  it('login: el límite por IP+email no afecta a otros emails de la misma IP', async () => {
    app = await createTestApp([], { rateLimit: true, env: { REDIS_URL } });
    const victim = uniqueEmail();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await badLogin(app, victim)).status);
    expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await badLogin(app, uniqueEmail())).status).toBe(401); // otro email: no limitado
  });

  it('forgot-password: 3 por hora por email, sin revelar si existe y sin afectar a otros', async () => {
    app = await createTestApp([], { rateLimit: true, env: { REDIS_URL } });
    const target = uniqueEmail();
    const send = (e: string) => http(app!).post('/api/v1/auth/forgot-password').send({ email: e });
    expect([
      (await send(target)).status,
      (await send(target)).status,
      (await send(target)).status,
    ]).toEqual([202, 202, 202]);
    const fourth = await send(target);
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(60); // ventana de una hora
    expect((await send(uniqueEmail())).status).toBe(202);
  });

  it('register: 5 altas por hora por IP', async () => {
    app = await createTestApp([], { rateLimit: true, env: { REDIS_URL } });
    for (let i = 0; i < 5; i++) await register(app);
    const sixth = await http(app).post('/api/v1/auth/register').send({
      email: uniqueEmail(),
      password: PASSWORD,
      fullName: 'Persona Extra',
      businessName: 'Negocio Extra',
    });
    expect(sixth.status).toBe(429);
  });

  it('límite por USUARIO: reenviar verificación 3 veces por hora; otro usuario no se ve afectado', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL, RATE_LIMIT_GLOBAL_PER_MIN: '1000' },
    });
    // 5 altas desde la misma IP es el máximo permitido por hora: se crean exactamente 2 aquí.
    const a = await register(app, { verified: false });
    const b = await register(app, { verified: false });
    const resend = (u: { auth: object }) =>
      http(app!)
        .post('/api/v1/auth/resend-verification')
        .set(u.auth as Record<string, string>);
    expect([(await resend(a)).status, (await resend(a)).status, (await resend(a)).status]).toEqual([
      204, 204, 204,
    ]);
    expect((await resend(a)).status).toBe(429);
    expect((await resend(b)).status).toBe(204);
  });

  it('límite por USUARIO en invitaciones: la 31.ª en una hora se rechaza', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL, RATE_LIMIT_GLOBAL_PER_MIN: '1000' },
    });
    const o = await register(app);
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      const r = await http(app)
        .post('/api/v1/tenants/current/invitations')
        .set(o.auth)
        .send({ email: uniqueEmail(), roleKey: 'receptionist' });
      codes.push(r.status);
    }
    expect(codes.slice(0, 30).every((c) => c === 201)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('límite general por IP en TODA la API (red de seguridad), incluidas rutas públicas', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL, RATE_LIMIT_GLOBAL_PER_MIN: '10' },
    });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await http(app).get('/health')).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('la IP no se puede falsear con X-Forwarded-For si no hay proxy confiable (TRUST_PROXY=0)', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL, RATE_LIMIT_GLOBAL_PER_MIN: '10', TRUST_PROXY: '0' },
    });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++)
      codes.push((await http(app).get('/health').set('X-Forwarded-For', `10.0.0.${i}`)).status);
    expect(codes[11]).toBe(429); // cambiar de "IP" no reinicia el contador
  });

  it('con un proxy confiable (TRUST_PROXY=1) cada cliente real tiene su propio contador', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL, RATE_LIMIT_GLOBAL_PER_MIN: '10', TRUST_PROXY: '1' },
    });
    for (let i = 0; i < 10; i++)
      await http(app).get('/health').set('X-Forwarded-For', '203.0.113.1');
    expect((await http(app).get('/health').set('X-Forwarded-For', '203.0.113.1')).status).toBe(429);
    expect((await http(app).get('/health').set('X-Forwarded-For', '203.0.113.2')).status).toBe(200);
  });

  it('Redis no guarda emails ni IPs en claro', async () => {
    app = await createTestApp([], { rateLimit: true, env: { REDIS_URL } });
    const email = uniqueEmail();
    await badLogin(app, email);
    const keys = await redis.keys('rl:test:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toContain(email);
      expect(k).not.toMatch(/127\.0\.0\.1|::1|example\.test/);
    }
  });

  it('las ventanas expiran solas (no quedan claves huérfanas)', async () => {
    app = await createTestApp([], { rateLimit: true, env: { REDIS_URL } });
    await badLogin(app, uniqueEmail());
    for (const k of await redis.keys('rl:test:*')) expect(await redis.pttl(k)).toBeGreaterThan(0);
  });

  it('desactivado por configuración: no limita', async () => {
    app = await createTestApp([], {
      rateLimit: false,
      env: { REDIS_URL, RATE_LIMIT_GLOBAL_PER_MIN: '10' },
    });
    for (let i = 0; i < 15; i++) expect((await http(app).get('/health')).status).toBe(200);
  });
});

describe('resiliencia', () => {
  it('si Redis no responde se DEJA PASAR (fail-open): ni 429 ni 500', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL: 'redis://127.0.0.1:6390', RATE_LIMIT_GLOBAL_PER_MIN: '10' },
    });
    for (let i = 0; i < 15; i++) expect((await http(app).get('/health')).status).toBe(200);
    // las defensas por cuenta siguen activas aunque no haya Redis
    const l = await login(app, uniqueEmail());
    expect(l.res.status).toBe(401);
  });

  it('readiness refleja la caída de Redis (503)', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL: 'redis://127.0.0.1:6390' },
    });
    const res = await http(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'up', redis: 'down' } });
  });

  it('sin REDIS_URL usa memoria local y también limita', async () => {
    app = await createTestApp([], {
      rateLimit: true,
      env: { REDIS_URL: '', RATE_LIMIT_GLOBAL_PER_MIN: '10' },
    });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await http(app).get('/health')).status);
    expect(codes[11]).toBe(429);
  });
});

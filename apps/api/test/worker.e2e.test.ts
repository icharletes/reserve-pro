import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaintenanceProcessor, MAINTENANCE_QUEUE } from '../src/worker/maintenance/maintenance.processor.js';
import { MaintenanceService } from '../src/worker/maintenance/maintenance.service.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { createTestApp, ownerPool, register } from './helpers.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const PREFIX = `rp:test:worker-${randomUUID().slice(0, 8)}`;
let owner: pg.Pool;
let userId: string;
let service: MaintenanceService;
let moduleRef: TestingModule;

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

async function startWorker(env: Record<string, string | undefined> = {}): Promise<TestingModule> {
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['REDIS_URL'] = REDIS_URL;
  process.env['QUEUE_PREFIX'] = PREFIX;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const m = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  await m.init();
  return m;
}

beforeAll(async () => {
  // La API de pruebas crea el usuario y deja la base lista (migraciones aplicadas por el globalSetup).
  const app = await createTestApp();
  const u = await register(app);
  userId = u.body.user.id;
  await app.close();
  owner = ownerPool();
  moduleRef = await startWorker();
  service = moduleRef.get(MaintenanceService);
});

afterAll(async () => {
  await moduleRef.close();
  const conn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const q = new Queue(MAINTENANCE_QUEUE, { connection: conn, prefix: PREFIX });
  await q.obliterate({ force: true }).catch(() => undefined);
  await q.close();
  await conn.quit();
  await owner.end();
});

const insertRefresh = (expiresAt: Date, revokedAt: Date | null = null, n = 1) =>
  owner.query(
    `INSERT INTO refresh_tokens(id,user_id,family_id,token_hash,expires_at,revoked_at)
     SELECT gen_random_uuid(), $1, gen_random_uuid(), gen_random_bytes(32), $2, $3 FROM generate_series(1,$4)`,
    [userId, expiresAt, revokedAt, n],
  );
const count = async (table: string) => (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [userId])).rows[0].n as number;

describe('purga de tokens vencidos (MaintenanceService)', () => {
  it('borra los vencidos hace más de 7 días y conserva los recientes y los vigentes', async () => {
    await owner.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [userId]);
    await insertRefresh(ago(30)); // vencido hace 30 d  => se borra
    await insertRefresh(ago(8)); //  vencido hace 8 d   => se borra
    await insertRefresh(ago(2)); //  vencido hace 2 d   => se conserva (ventana de gracia)
    await insertRefresh(new Date(Date.now() + 86_400_000)); // vigente => se conserva
    await insertRefresh(new Date(Date.now() + 86_400_000), ago(1)); // revocado pero aún no vencido => se conserva

    const res = await service.purgeExpiredTokens();
    expect(res.refreshTokens).toBe(2);
    expect(await count('refresh_tokens')).toBe(3);
  });

  it('tokens de un solo uso: borra los vencidos o usados hace más de 7 días', async () => {
    await owner.query(`DELETE FROM password_reset_tokens WHERE user_id=$1`, [userId]);
    await owner.query(`DELETE FROM email_verification_tokens WHERE user_id=$1`, [userId]);
    for (const table of ['password_reset_tokens', 'email_verification_tokens']) {
      const ins = (exp: Date, used: Date | null) =>
        owner.query(`INSERT INTO ${table}(id,user_id,token_hash,expires_at,used_at) VALUES (gen_random_uuid(),$1,gen_random_bytes(32),$2,$3)`, [userId, exp, used]);
      await ins(ago(10), null); //            vencido hace 10 d      => se borra
      await ins(new Date(Date.now() + 3_600_000), ago(10)); // usado hace 10 d => se borra
      await ins(new Date(Date.now() + 3_600_000), ago(1)); //  usado hace 1 d  => se conserva
      await ins(new Date(Date.now() + 3_600_000), null); //    vigente         => se conserva
    }
    const res = await service.purgeExpiredTokens();
    expect(res.passwordResetTokens).toBe(2);
    expect(res.emailVerificationTokens).toBe(2);
    expect(await count('password_reset_tokens')).toBe(2);
    expect(await count('email_verification_tokens')).toBe(2);
  });

  it('procesa volúmenes grandes por lotes (2 500 filas) y es idempotente', async () => {
    await owner.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [userId]);
    await insertRefresh(ago(40), null, 2_500);
    await insertRefresh(new Date(Date.now() + 86_400_000), null, 3);
    const first = await service.purgeExpiredTokens();
    expect(first.refreshTokens).toBe(2_500);
    expect(await count('refresh_tokens')).toBe(3);
    const second = await service.purgeExpiredTokens();
    expect(second).toEqual({ refreshTokens: 0, passwordResetTokens: 0, emailVerificationTokens: 0 });
  });

  it('la purga NO afecta a las sesiones activas de nadie (el access token sigue siendo válido)', async () => {
    const app = await createTestApp();
    const u = await register(app);
    await service.purgeExpiredTokens();
    const { default: request } = await import('supertest');
    const me = await request(app.getHttpServer()).get('/api/v1/me').set(u.auth);
    expect(me.status).toBe(200);
    await app.close();
  });
});

describe('worker real con BullMQ y Redis', () => {
  it('registra el programador diario a las 03:00 UTC', async () => {
    const processor = moduleRef.get(MaintenanceProcessor);
    const schedulers = await processor.schedulers();
    const s = schedulers.find((x) => x.key === 'purge-expired-tokens-daily');
    expect(s?.pattern).toBe('0 3 * * *');
    expect(s?.tz).toBe('UTC');
  });

  it('ejecuta un job encolado: la purga ocurre de verdad', async () => {
    await owner.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [userId]);
    await insertRefresh(ago(60), null, 5);
    const processor = moduleRef.get(MaintenanceProcessor);
    await processor.enqueue('purge-expired-tokens');

    const deadline = Date.now() + 8_000;
    while ((await count('refresh_tokens')) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(await count('refresh_tokens')).toBe(0);
  });

  it('un job con nombre desconocido FALLA (no se ignora en silencio)', async () => {
    const processor = moduleRef.get(MaintenanceProcessor);
    await expect(processor.process({ name: 'inventado' } as never)).rejects.toThrow(/job desconocido/);
  });

  it('dos réplicas del worker comparten UN solo programador (sin trabajo duplicado)', async () => {
    const second = await startWorker();
    const schedulers = await second.get(MaintenanceProcessor).schedulers();
    expect(schedulers.filter((x) => x.key === 'purge-expired-tokens-daily')).toHaveLength(1);
    await second.close();
  });

  it('exige REDIS_URL: sin ella el worker no arranca', async () => {
    const saved = process.env['REDIS_URL'];
    await expect(startWorker({ REDIS_URL: undefined })).rejects.toThrow(/REDIS_URL/);
    process.env['REDIS_URL'] = saved;
  });

  it('el cierre es ordenado (no deja conexiones colgadas)', async () => {
    const m = await startWorker();
    await expect(m.close()).resolves.toBeUndefined();
  });
});

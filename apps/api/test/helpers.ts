import { randomUUID } from 'node:crypto';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { AuthResponse } from '@reservepro/contracts';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

export const PASSWORD = 'Str0ng-Passw0rd!';

export async function createTestApp(extraControllers: Type[] = []): Promise<INestApplication> {
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['JWT_ACCESS_SECRET'] ||= 'test-secret-that-is-at-least-32-characters-long';
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

/** Conexión con el rol dueño (bypass de RLS) para preparar y verificar datos que la API no expone. */
export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER'], max: 2 });
}

export const http = (app: INestApplication) => request(app.getHttpServer());

export function cookieValue(setCookie: string[] | string | undefined, name = 'rp_refresh'): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const line = list.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  const value = line.split(';')[0]!.slice(name.length + 1);
  return value || undefined;
}

export interface Registered {
  body: AuthResponse;
  refresh: string;
  email: string;
  tenantId: string;
  auth: { Authorization: string };
}

export async function register(
  app: INestApplication,
  overrides: Partial<{ email: string; businessName: string; slug: string; password: string }> = {},
): Promise<Registered> {
  const email = overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.test`;
  const res = await http(app)
    .post('/api/v1/auth/register')
    .send({
      email,
      password: overrides.password ?? PASSWORD,
      fullName: 'Persona de Prueba',
      businessName: overrides.businessName ?? `Negocio ${randomUUID().slice(0, 6)}`,
      ...(overrides.slug ? { slug: overrides.slug } : {}),
    });
  if (res.status !== 201) throw new Error(`register falló: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as AuthResponse;
  return {
    body,
    email,
    refresh: cookieValue(res.headers['set-cookie'])!,
    tenantId: body.activeTenantId!,
    auth: { Authorization: `Bearer ${body.accessToken}` },
  };
}

export async function login(
  app: INestApplication,
  email: string,
  extra: { tenantId?: string; password?: string } = {},
): Promise<{ res: Response; body: AuthResponse; refresh: string | undefined; auth: { Authorization: string } }> {
  const res = await http(app)
    .post('/api/v1/auth/login')
    .send({ email, password: extra.password ?? PASSWORD, ...(extra.tenantId ? { tenantId: extra.tenantId } : {}) });
  return {
    res,
    body: res.body as AuthResponse,
    refresh: cookieValue(res.headers['set-cookie']),
    auth: { Authorization: `Bearer ${(res.body as AuthResponse).accessToken}` },
  };
}

/** Da a `userId` una membresía con el rol `roleKey` en `tenantId` (simula una invitación aceptada). */
export async function addMembership(
  owner: pg.Pool,
  args: { tenantId: string; userId: string; roleKey: string },
): Promise<string> {
  const membershipId = randomUUID();
  await owner.query(`INSERT INTO tenant_memberships(id,tenant_id,user_id) VALUES ($1,$2,$3)`, [
    membershipId,
    args.tenantId,
    args.userId,
  ]);
  await owner.query(
    `INSERT INTO membership_roles(tenant_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND key=$3`,
    [args.tenantId, membershipId, args.roleKey],
  );
  return membershipId;
}

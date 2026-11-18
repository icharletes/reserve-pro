import { randomUUID } from 'node:crypto';
import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { AuthResponse } from '@reservepro/contracts';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import {
  EMAIL_PROVIDER,
  type EmailMessage,
  type EmailProvider,
} from '../src/platform/email/email.module.js';

export const PASSWORD = 'Str0ng-Passw0rd!';
export type Auth = { Authorization: string };

/** Buzón falso: captura los emails que enviaría la API (sin red) para poder leer el token como lo haría una persona. */
export class CapturingEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  private failures = 0;

  async send(message: EmailMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('SMTP caído (simulado)');
    }
    this.sent.push(message);
  }
  /** Hace fallar los próximos `n` envíos. */
  failNext(n = 1): void {
    this.failures = n;
  }
  last(to: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
export const mailbox = new CapturingEmailProvider();

/** Extrae el token del enlace (#token=…) del cuerpo de texto del email. */
export function tokenFrom(message: EmailMessage | undefined): string {
  const match = message ? /#token=([A-Za-z0-9_-]+)/.exec(message.text) : null;
  if (!match) throw new Error('el email no contiene un enlace con token');
  return match[1]!;
}

export async function createTestApp(
  extraControllers: Type[] = [],
  options: { rateLimit?: boolean; env?: Record<string, string> } = {},
): Promise<INestApplication> {
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  // El rate limit se desactiva por defecto (las suites hacen decenas de logins desde la misma IP) y se activa
  // solo en su propia suite. Se fija ANTES de construir la app, que lee el entorno al crearse.
  process.env['RATE_LIMIT_ENABLED'] = options.rateLimit ? 'true' : 'false';
  for (const [k, v] of Object.entries(options.env ?? {})) process.env[k] = v;
  process.env['JWT_ACCESS_SECRET'] ||= 'test-secret-that-is-at-least-32-characters-long';
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  })
    .overrideProvider(EMAIL_PROVIDER)
    .useValue(mailbox)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

/** Conexión con el rol dueño (bypass de RLS) para preparar y verificar datos que la API no expone. */
export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: process.env['DATABASE_URL_OWNER'], max: 2 });
}

// Pool interno de los helpers: no retiene el proceso al terminar (allowExitOnIdle).
let helperPool: pg.Pool | undefined;
function adminDb(): pg.Pool {
  helperPool ??= new pg.Pool({
    connectionString: process.env['DATABASE_URL_OWNER'],
    max: 2,
    idleTimeoutMillis: 500,
    allowExitOnIdle: true,
  });
  return helperPool;
}

/** Espera (hasta 3 s) a que llegue un email a `to`; los correos se envían en segundo plano. */
export async function waitForMail(
  to: string,
  match?: (m: EmailMessage) => boolean,
): Promise<EmailMessage> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const found = [...mailbox.sent].reverse().find((m) => m.to === to && (!match || match(m)));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no llegó ningún email a ${to}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const http = (app: INestApplication) => request(app.getHttpServer());

export function cookieValue(
  setCookie: string[] | string | undefined,
  name = 'rp_refresh',
): string | undefined {
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
  overrides: Partial<{
    email: string;
    businessName: string;
    slug: string;
    password: string;
    verified: boolean;
  }> = {},
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
  if (res.status !== 201)
    throw new Error(`register falló: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as AuthResponse;
  // Por defecto el email queda verificado (la mayoría de las pruebas no tratan sobre eso).
  if (overrides.verified !== false) {
    await adminDb().query(`UPDATE users SET email_verified_at = now() WHERE email = $1`, [email]);
  }
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
): Promise<{
  res: Response;
  body: AuthResponse;
  refresh: string | undefined;
  auth: { Authorization: string };
}> {
  const res = await http(app)
    .post('/api/v1/auth/login')
    .send({
      email,
      password: extra.password ?? PASSWORD,
      ...(extra.tenantId ? { tenantId: extra.tenantId } : {}),
    });
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

export interface Joined {
  email: string;
  userId: string;
  membershipId: string;
  auth: { Authorization: string };
}

/** Crea un usuario nuevo y lo une a `tenantId` con el rol indicado; devuelve su sesión ya con esa empresa activa. */
export async function joinTenant(
  app: INestApplication,
  owner: pg.Pool,
  tenantId: string,
  roleKey: string,
): Promise<Joined> {
  const u = await register(app);
  const membershipId = await addMembership(owner, { tenantId, userId: u.body.user.id, roleKey });
  const l = await login(app, u.email, { tenantId });
  return { email: u.email, userId: u.body.user.id, membershipId, auth: l.auth };
}

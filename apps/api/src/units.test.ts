import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_KEYS, isPermissionKey } from '@reservepro/contracts';
import { uuidv7 } from './common/ids.js';
import { loadEnv } from './config/env.js';
import { ROLE_TEMPLATES } from './platform/rbac/role-templates.js';
import { slugify } from './modules/tenants/slug.js';
import { TokenService } from './platform/auth/token.service.js';

describe('uuidv7', () => {
  it('tiene formato UUID v7 válido', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('es ordenable por tiempo', () => {
    const ids = [1000, 2000, 3000, 4000].map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });
  it('no repite', () => {
    expect(new Set(Array.from({ length: 5000 }, () => uuidv7())).size).toBe(5000);
  });
});

describe('slugify', () => {
  it.each([
    ['Peluquería Central', 'peluqueria-central'],
    ['  Café & Té — Ñandú  ', 'cafe-te-nandu'],
    ['A', 'a-app'],
    ['!!!', 'negocio'],
    ['x'.repeat(100), 'x'.repeat(40)],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
  it('siempre produce un slug aceptado por el CHECK de la BD', () => {
    for (const s of ['Hola Mundo', 'ÁÉÍÓÚ', '123', '---a---', 'Salón "VIP" #1']) {
      expect(slugify(s)).toMatch(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/);
    }
  });
});

describe('plantillas de roles', () => {
  it('todos los permisos referenciados existen en el catálogo', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of t.permissions) expect(isPermissionKey(p), `${t.key}:${p}`).toBe(true);
    }
  });
  it('sin permisos duplicados dentro de un rol', () => {
    for (const t of ROLE_TEMPLATES) expect(new Set(t.permissions).size).toBe(t.permissions.length);
  });
  it('el propietario tiene todos los permisos; el admin todos salvo facturación', () => {
    const owner = ROLE_TEMPLATES.find((t) => t.key === 'owner')!;
    const admin = ROLE_TEMPLATES.find((t) => t.key === 'admin')!;
    expect(owner.permissions).toHaveLength(PERMISSION_KEYS.length);
    expect(admin.permissions).not.toContain('billing:manage');
    expect(admin.permissions).toContain('members:invite');
  });
  it('el profesional no puede escribir catálogo, ver todas las reservas ni gestionar la empresa', () => {
    const pro = ROLE_TEMPLATES.find((t) => t.key === 'professional')!;
    expect(pro.permissions).toContain('reservations:read:own');
    for (const forbidden of ['reservations:read', 'services:write', 'tenant:update', 'billing:manage', 'customers:erase']) {
      expect(pro.permissions).not.toContain(forbidden);
    }
  });
  it('solo el propietario puede gestionar facturación', () => {
    const withBilling = ROLE_TEMPLATES.filter((t) => t.permissions.includes('billing:manage')).map((t) => t.key);
    expect(withBilling).toEqual(['owner']);
  });
  it('el catálogo tiene descripción para cada permiso', () => {
    for (const key of PERMISSION_KEYS) expect(PERMISSIONS[key].length).toBeGreaterThan(3);
  });
});

describe('validación de entorno', () => {
  const base = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'a'.repeat(40) };
  it('acepta una configuración mínima válida y aplica valores por defecto', () => {
    const env = loadEnv(base);
    expect(env.API_PORT).toBe(3000);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });
  it('falla si falta DATABASE_URL o el secreto es corto', () => {
    expect(() => loadEnv({ JWT_ACCESS_SECRET: 'a'.repeat(40) })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'corto' })).toThrow(/JWT_ACCESS_SECRET/);
  });
  it('prohíbe el secreto de desarrollo en producción', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'dev-only-' + 'a'.repeat(30) }),
    ).toThrow(/producción/);
  });
  it('parsea la lista de orígenes CORS', () => {
    expect(loadEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test ,' }).CORS_ORIGINS).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });
});

describe('refresh token', () => {
  it('es aleatorio, de 256 bits, y solo se guarda su hash', () => {
    const svc = new TokenService({
      env: { JWT_ACCESS_SECRET: 'a'.repeat(40), ACCESS_TOKEN_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 30 },
    } as never);
    const a = svc.generateRefreshToken();
    const b = svc.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.hash).toHaveLength(32);
    expect(Buffer.from(a.hash).equals(Buffer.from(TokenService.hashRefreshToken(a.token)))).toBe(true);
    expect(Buffer.from(a.hash).toString('base64url')).not.toBe(a.token);
  });
});

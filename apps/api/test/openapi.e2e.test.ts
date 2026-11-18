import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPermissionKey } from '@reservepro/contracts';
import { OpenApiService } from '../src/platform/openapi/openapi.service.js';
import { createTestApp, http } from './helpers.js';

type Op = {
  operationId: string;
  summary: string;
  security: object[];
  parameters?: { name: string; in: string }[];
  responses: Record<string, unknown>;
  'x-authorization': string;
  'x-permissions'?: string[];
  'x-rate-limits'?: unknown[];
};
type Doc = { openapi: string; paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, unknown> } };

let app: INestApplication;
let doc: Doc;

beforeAll(async () => {
  app = await createTestApp();
  doc = app.get(OpenApiService).build() as unknown as Doc;
});
afterAll(async () => app.close());

const operations = (): { method: string; path: string; op: Op }[] =>
  Object.entries(doc.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ method, path, op })));

describe('cobertura de la documentación', () => {
  it('TODA ruta registrada está documentada con @ApiDoc y declara su política de autorización', () => {
    const routes = app.get(OpenApiService).routes();
    expect(routes.length).toBeGreaterThan(20);
    const undocumented = routes.filter((r) => !r.doc).map((r) => `${r.method.toUpperCase()} ${r.path} (${r.controller}.${r.handler})`);
    expect(undocumented, 'añade @ApiDoc a estas rutas').toEqual([]);
    expect(operations().filter((o) => o.op['x-authorization'] === 'undeclared')).toEqual([]);
  });

  it('el archivo docs/api/openapi.json está al día con el código', () => {
    const committed = readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8');
    const current = `${JSON.stringify(doc, null, 2)}\n`;
    expect(committed === current, 'el contrato cambió: ejecuta `pnpm --filter @reservepro/api openapi:generate` y versiona el resultado').toBe(true);
  });
});

describe('validez estructural', () => {
  it('es OpenAPI 3.1 con operationIds únicos y al menos una respuesta de éxito por operación', () => {
    expect(doc.openapi).toBe('3.1.0');
    const ids = operations().map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { method, path, op } of operations()) {
      expect(Object.keys(op.responses).some((s) => /^2\d\d$/.test(s)), `${method} ${path}`).toBe(true);
      expect(op.summary.length, `${method} ${path}`).toBeGreaterThan(3);
    }
  });

  it('cada {parámetro} de la ruta está declarado como parámetro de path', () => {
    for (const { method, path, op } of operations()) {
      for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
        expect(op.parameters?.some((p) => p.in === 'path' && p.name === name), `${method} ${path} -> {${name}}`).toBe(true);
      }
    }
  });

  it('todas las referencias $ref apuntan a un componente existente', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(doc.components.schemas[r], r).toBeDefined();
  });

  it('el cuerpo de error es problem+json y no hay secretos de ejemplo en el documento', () => {
    expect(JSON.stringify(doc)).toContain('application/problem+json');
    expect(JSON.stringify(doc)).not.toMatch(/JWT_ACCESS_SECRET|password_hash|argon2id\$/i);
  });
});

describe('controles de seguridad derivados del contrato', () => {
  /** Lista CERRADA de endpoints sin autenticación. Añadir uno exige actualizar esta lista conscientemente. */
  const PUBLIC = [
    'GET /health',
    'GET /health/ready',
    'POST /auth/register',
    'POST /auth/login',
    'POST /auth/refresh',
    'POST /auth/logout',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'POST /auth/verify-email',
    'POST /invitations/preview',
    'POST /invitations/accept',
  ].sort();

  it('los únicos endpoints públicos son los esperados', () => {
    const found = operations()
      .filter((o) => o.op['x-authorization'] === 'public')
      .map((o) => `${o.method.toUpperCase()} ${o.path}`)
      .sort();
    expect(found).toEqual(PUBLIC);
  });

  it('todo endpoint no público exige bearer, y los públicos no', () => {
    for (const { method, path, op } of operations()) {
      const isPublic = op['x-authorization'] === 'public';
      expect(op.security.length === 0, `${method} ${path}`).toBe(isPublic);
    }
  });

  it('todo POST público tiene rate limit propio (anti-abuso)', () => {
    for (const { method, path, op } of operations()) {
      if (op['x-authorization'] === 'public' && method === 'post') {
        expect(op['x-rate-limits']?.length ?? 0, `POST ${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('los permisos exigidos existen en el catálogo y los endpoints de escritura no son solo lectura', () => {
    for (const { method, path, op } of operations()) {
      for (const p of op['x-permissions'] ?? []) expect(isPermissionKey(p), `${method} ${path}: ${p}`).toBe(true);
      if (op['x-authorization'] === 'permissions' && method !== 'get') {
        expect(op['x-permissions']!.every((p) => !p.endsWith(':read')), `${method} ${path}`).toBe(true);
      }
    }
  });
});

describe('publicación', () => {
  it('GET /api/v1/openapi.json sirve el documento (fuera de producción)', async () => {
    const res = await http(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/auth/login']).toBeDefined();
  });

  it('con OPENAPI_ENABLED=false responde 404', async () => {
    const off = await createTestApp([], { env: { OPENAPI_ENABLED: 'false' } });
    expect((await http(off).get('/api/v1/openapi.json')).status).toBe(404);
    await off.close();
    delete process.env['OPENAPI_ENABLED'];
  });
});

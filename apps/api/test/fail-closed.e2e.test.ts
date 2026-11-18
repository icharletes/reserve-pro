import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, http, register } from './helpers.js';

let handlerRan = false;

/** Controlador "olvidado": NO declara @Public / @Authenticated / @RequirePermissions. */
@Controller('rogue')
class RogueController {
  @Get()
  secret() {
    handlerRan = true;
    return { secret: 'datos-sensibles' };
  }
}

let app: INestApplication;

beforeAll(async () => {
  app = await createTestApp([RogueController]);
});
afterAll(async () => app.close());

describe('autorización por defecto: falla cerrado', () => {
  it('un endpoint sin política declarada NO se ejecuta, ni siquiera con un usuario autenticado', async () => {
    const r = await register(app);
    const res = await http(app).get('/api/v1/rogue').set(r.auth);
    expect(res.status).toBe(500);
    expect(handlerRan).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('datos-sensibles');
  });

  it('tampoco sin autenticación', async () => {
    const res = await http(app).get('/api/v1/rogue');
    expect(res.status).toBe(500);
    expect(handlerRan).toBe(false);
  });
});

import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import { type Auth, http } from './helpers.js';

/** Cliente mínimo de la API para las pruebas del catálogo y la agenda. */
export function client(app: INestApplication, auth: Auth) {
  const url = (p: string) => `/api/v1${p}`;
  return {
    get: (p: string): Promise<Response> => http(app).get(url(p)).set(auth),
    post: (p: string, body: object = {}): Promise<Response> =>
      http(app).post(url(p)).set(auth).send(body),
    put: (p: string, body: object = {}): Promise<Response> =>
      http(app).put(url(p)).set(auth).send(body),
    patch: (p: string, body: object = {}): Promise<Response> =>
      http(app).patch(url(p)).set(auth).send(body),
    del: (p: string): Promise<Response> => http(app).delete(url(p)).set(auth),
  };
}
export type Client = ReturnType<typeof client>;

export async function mkLocation(c: Client, name = 'Sucursal Centro', extra: object = {}) {
  const res = await c.post('/locations', { name, ...extra });
  if (res.status !== 201) throw new Error(`mkLocation: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; effectiveTimezone: string };
}

export async function mkResource(c: Client, locationId: string, name = 'Ana', extra: object = {}) {
  const res = await c.post('/resources', { locationId, kind: 'staff', name, ...extra });
  if (res.status !== 201) throw new Error(`mkResource: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; locationId: string };
}

export async function mkService(c: Client, name = 'Corte de pelo', extra: object = {}) {
  const res = await c.post('/services', { name, durationMinutes: 30, price: '12990', ...extra });
  if (res.status !== 201) throw new Error(`mkService: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; price: string; currency: string };
}

export const hours = (weekdays: number[], start = '09:00', end = '18:00') =>
  weekdays.map((weekday) => ({ weekday, start, end }));

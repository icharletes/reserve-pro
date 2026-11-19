import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogView,
  blockView,
  businessHoursView,
  calendarResponse,
  categoryView,
  holidayView,
  locationView,
  memberView,
  overrideView,
  pageOf,
  resourceScheduleView,
  resourceView,
  roleView,
  serviceView,
  tenantView,
} from '@reservepro/contracts';
import { client, hours, mkLocation, mkResource, mkService } from './catalog-helpers.js';
import { createTestApp, joinTenant, ownerPool, register } from './helpers.js';

/**
 * Contrato real: lo que la API DEVUELVE debe cumplir el esquema que usa el cliente de la interfaz
 * (`@reservepro/api-client` valida cada respuesta). Si un servicio se desvía del contrato, esta prueba falla
 * antes de que lo haga una pantalla.
 */
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

function expectContract(name: string, schema: ZodType, body: unknown) {
  const r = schema.safeParse(body);
  expect(r.success, `${name}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(
    true,
  );
}

describe('las respuestas reales cumplen los contratos', () => {
  it('catálogo, agenda, calendario, equipo y auditoría', async () => {
    const o = await register(app);
    const c = client(app, o.auth);

    const loc = await mkLocation(c, 'Contrato', {
      address: { city: 'Temuco' },
      phone: '+56911112222',
      email: 'c@x.test',
    });
    const cat = (await c.post('/service-categories', { name: 'Cat', sortOrder: 1 })).body;
    const pro = await joinTenant(app, owner, o.tenantId, 'professional');
    const res = await mkResource(c, loc.id, 'Ana', { membershipId: pro.membershipId });
    const svc = await mkService(c, 'Corte', {
      categoryId: cat.id,
      description: 'd',
      imageUrl: 'https://x.test/a.png',
      minNoticeMinutes: 30,
      maxAdvanceDays: 60,
      requiresConfirmation: false,
    });
    await c.put(`/services/${svc.id}/locations`, { locationIds: [loc.id] });
    await c.put(`/services/${svc.id}/resources`, { resourceIds: [res.id] });
    await c.put(`/locations/${loc.id}/business-hours`, { intervals: hours([1, 2, 3, 4, 5]) });
    await c.put(`/resources/${res.id}/schedule`, {
      intervals: [
        { weekday: 1, start: '09:00', end: '12:00', validFrom: '2027-01-01', validTo: null },
      ],
    });
    await c.put(`/locations/${loc.id}/overrides/2027-07-06`, {
      closed: false,
      intervals: [{ start: '10:00', end: '12:00' }],
      reason: 'Especial',
    });
    await c.put('/holidays/2027-09-18', { name: 'Fiestas Patrias' });
    await c.post('/blocks', {
      resourceIds: [res.id],
      startAt: '2027-07-07T12:00:00Z',
      endAt: '2027-07-07T16:00:00Z',
      reason: 'x',
    });

    const get = async (p: string) => (await c.get(p)).body;
    expectContract('GET /tenants/current', tenantView, await get('/tenants/current'));
    expectContract('GET /locations', pageOf(locationView), await get('/locations'));
    expectContract('GET /locations/:id', locationView, await get(`/locations/${loc.id}`));
    expectContract(
      'GET /service-categories',
      pageOf(categoryView),
      await get('/service-categories'),
    );
    expectContract('GET /services', pageOf(serviceView), await get('/services'));
    expectContract('GET /services/:id', serviceView, await get(`/services/${svc.id}`));
    expectContract('GET /resources', pageOf(resourceView), await get('/resources'));
    expectContract('GET /resources/:id', resourceView, await get(`/resources/${res.id}`));
    expectContract(
      'GET business-hours',
      businessHoursView,
      await get(`/locations/${loc.id}/business-hours`),
    );
    expectContract(
      'GET schedule',
      resourceScheduleView,
      await get(`/resources/${res.id}/schedule`),
    );
    expectContract(
      'GET overrides',
      z.array(overrideView),
      await get(`/locations/${loc.id}/overrides?from=2027-07-01&to=2027-07-31`),
    );
    expectContract('GET holidays', z.array(holidayView), await get('/holidays?year=2027'));
    expectContract('GET blocks', pageOf(blockView), await get('/blocks'));
    expectContract(
      'GET calendar',
      calendarResponse,
      await get('/calendar?from=2027-07-05&to=2027-07-11'),
    );
    expectContract('GET members', pageOf(memberView), await get('/tenants/current/members'));
    expectContract('GET roles', z.array(roleView), await get('/tenants/current/roles'));
    expectContract(
      'GET audit-logs',
      pageOf(auditLogView),
      await get('/tenants/current/audit-logs'),
    );

    // y las respuestas de ESCRITURA
    expectContract(
      'POST /locations',
      locationView,
      (await c.post('/locations', { name: 'Otra' })).body,
    );
    expectContract(
      'PATCH /services/:id',
      serviceView,
      (await c.patch(`/services/${svc.id}`, { price: '1500' })).body,
    );
    expectContract(
      'PUT overrides',
      overrideView,
      (await c.put(`/locations/${loc.id}/overrides/2027-07-08`, { closed: true })).body,
    );
    expectContract(
      'POST /blocks',
      z.array(blockView),
      (
        await c.post('/blocks', {
          resourceIds: [res.id],
          startAt: '2027-08-01T00:00:00Z',
          endAt: '2027-08-02T00:00:00Z',
        })
      ).body,
    );
  });
});

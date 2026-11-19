import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type Page, expect, request, test } from '@playwright/test';
import pg from 'pg';
import { API_BASE, OWNER_DB_URL } from '../playwright.config';

/**
 * Un cliente REAL de extremo a extremo (ARCHITECTURE.md §9, Fase 4: "un cliente real reserva de extremo a
 * extremo"): navegador -> portal Astro -> API -> PostgreSQL, y de vuelta. El negocio se configura por la API
 * del panel, como lo haría su dueño.
 */

interface Biz {
  slug: string;
  token: string;
}

async function call(
  api: APIRequestContext,
  method: string,
  path: string,
  token: string,
  data?: unknown,
) {
  const res = await api.fetch(`${API_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(data !== undefined ? { data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function createBusiness(): Promise<Biz> {
  const api = await request.newContext();
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const reg = await api.post(`${API_BASE}/auth/register`, {
    data: {
      email: `${slug}@example.test`,
      password: 'E2e-Contrasena-Segura-1',
      fullName: 'Dueña E2E',
      businessName: 'Peluquería E2E',
      slug,
    },
  });
  expect(reg.status()).toBe(201);
  const t: string = (await reg.json()).accessToken;
  const loc = await call(api, 'POST', '/locations', t, {
    name: 'Centro',
    address: { line1: 'Calle Falsa 123', city: 'Santiago' },
  });
  // Todos los días 08-20: siempre hay horarios mañana, sea cual sea el día en que corra la prueba.
  await call(api, 'PUT', `/locations/${loc.id}/business-hours`, t, {
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })),
  });
  const ana = await call(api, 'POST', '/resources', t, {
    locationId: loc.id,
    kind: 'staff',
    name: 'Ana',
    sortOrder: 1,
  });
  const beto = await call(api, 'POST', '/resources', t, {
    locationId: loc.id,
    kind: 'staff',
    name: 'Beto',
    sortOrder: 2,
  });
  const svc = await call(api, 'POST', '/services', t, {
    name: 'Corte de pelo',
    durationMinutes: 45,
    price: '15000',
  });
  await call(api, 'PUT', `/services/${svc.id}/locations`, t, { locationIds: [loc.id] });
  await call(api, 'PUT', `/services/${svc.id}/resources`, t, { resourceIds: [ana.id, beto.id] });
  await api.dispose();
  return { slug, token: t };
}

/**
 * Elige un día (0 = hoy, 1 = mañana…) y un horario libre. Devuelve su texto (HH:MM). El negocio abre todos los
 * días 08-20, así que mañana y pasado siempre tienen horarios. Pasado mañana queda a más de 24 h: dentro de las
 * políticas de cambio y cancelación por defecto.
 */
async function pickSlot(page: Page, day: number, index = 0): Promise<string> {
  await page.getByRole('radiogroup', { name: 'Día' }).getByRole('radio').nth(day).click();
  const slots = page.getByRole('group', { name: 'Horarios disponibles' }).getByRole('button');
  await expect(slots.first()).toBeVisible();
  const slot = slots.nth(index);
  const text = (await slot.textContent())!.trim();
  await slot.click();
  return text;
}

let biz: Biz;
test.beforeAll(async () => {
  biz = await createBusiness();
});

test('un cliente reserva, cambia el horario y cancela desde su enlace', async ({ page }) => {
  // 1) Página del negocio (SSR): los servicios ya vienen en el HTML
  await page.goto(`/${biz.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Peluquería E2E' })).toBeVisible();
  await expect(page).toHaveTitle(/Peluquería E2E/);
  await page.getByRole('button', { name: /Corte de pelo/ }).click();

  // 2) Profesional
  await expect(page.getByRole('heading', { name: '¿Con quién?' })).toBeFocused();
  await page.getByRole('button', { name: /Cualquiera disponible/ }).click();

  // 3) Día y hora (en la hora del NEGOCIO aunque el navegador esté en Madrid)
  await expect(page.getByText('(America/Santiago)')).toBeVisible();
  const time = await pickSlot(page, 2);

  // 4) Datos: validación antes de enviar
  await expect(page.getByRole('heading', { name: 'Tus datos' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(page.getByText('Revisa el teléfono')).toBeVisible();
  await page.getByLabel('Nombre').fill('Camila');
  await page.getByLabel('Teléfono móvil').fill('9 8765 4321');
  await page.getByLabel(/Email/).fill('camila@example.test');
  await page.getByRole('button', { name: 'Confirmar reserva' }).click();

  // 5) Página de gestión: el token viaja en el FRAGMENTO, y el aviso de "nueva" no queda en la URL
  await expect(page).toHaveURL(/\/mi-reserva#token=[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText('¡Reserva lista!')).toBeVisible();
  await expect(page.getByText('Confirmada')).toBeVisible();
  await expect(page.getByText(`${time} a`)).toBeVisible();
  const link = await page.getByLabel('Enlace de tu reserva').inputValue();
  expect(link).toMatch(/\/mi-reserva#token=/);
  // sin datos personales en la página de gestión
  await expect(page.getByText('camila@example.test')).toHaveCount(0);

  // 6) Abrir el enlace guardado "en frío" funciona (y ya no muestra el aviso de "nueva").
  //    Ir a otra página antes: cambiar solo el fragmento de la URL no recarga la página.
  await page.goto('about:blank');
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page.getByRole('heading', { name: 'Tu reserva en Peluquería E2E' })).toBeVisible();
  await expect(page.getByText('¡Reserva lista!')).toHaveCount(0);

  // 7) Cambiar horario (mismo profesional)
  await page.getByRole('button', { name: 'Cambiar horario' }).click();
  const newTime = await pickSlot(page, 3, 3);
  await page.getByRole('button', { name: new RegExp(`Cambiar al .*${newTime} h`) }).click();
  await expect(page.getByText('Listo, cambiamos el horario de tu reserva.')).toBeVisible();
  await expect(page.getByText(`${newTime} a`)).toBeVisible();

  // 8) Cancelar
  await page.getByRole('button', { name: 'Cancelar reserva' }).click();
  await page.getByLabel(/Motivo/).fill('Me surgió un viaje');
  await page.getByRole('button', { name: 'Sí, cancelar' }).click();
  await expect(page.getByText('Tu reserva quedó cancelada.')).toBeVisible();
  await expect(page.getByText('Cancelada', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar reserva' })).toHaveCount(0);
});

test('el horario elegido que otro tomó entre medio: aviso y horarios actualizados', async ({
  page,
}) => {
  await page.goto(`/${biz.slug}`);
  await page.getByRole('button', { name: /Corte de pelo/ }).click();
  await page.getByRole('button', { name: 'Ana' }).click();
  const time = await pickSlot(page, 1, 5);

  // Otra persona reserva ESE horario con Ana justo antes (por la API pública)
  const api = await request.newContext();
  const pub = (path: string) =>
    api.get(`${API_BASE}/public/tenants/${biz.slug}${path}`).then((r) => r.json());
  const tenant = await pub('');
  const locationId: string = tenant.locations[0].id;
  const svc = (await pub(`/services?locationId=${locationId}`))[0];
  const anaId: string = svc.resources.find((r: { name: string }) => r.name === 'Ana').id;
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(
    new Date(Date.now() + 86_400_000),
  );
  const av = await pub(
    `/availability?serviceId=${svc.id}&locationId=${locationId}&from=${tomorrow}&resourceId=${anaId}`,
  );
  const taken = await api.post(`${API_BASE}/public/tenants/${biz.slug}/reservations`, {
    headers: { 'idempotency-key': randomUUID() },
    data: {
      serviceId: svc.id,
      locationId,
      resourceId: anaId,
      startAt: av.resources[0].slots[5].start, // el mismo que eligió el cliente en pantalla
      customer: { firstName: 'Rápido', phoneE164: '+56900000001' },
    },
  });
  expect(taken.status()).toBe(201);
  await api.dispose();

  await page.getByLabel('Nombre').fill('Lento');
  await page.getByLabel('Teléfono móvil').fill('+56 9 0000 0002');
  await page.getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(
    page.getByText('Ese horario se acaba de ocupar. Elige otro, por favor.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '¿Qué día y a qué hora?' })).toBeVisible();
  // tras recargar, ese horario ya no se ofrece para Ana
  await page.getByRole('radiogroup', { name: 'Día' }).getByRole('radio').nth(1).click();
  await expect(
    page
      .getByRole('group', { name: 'Horarios disponibles' })
      .getByRole('button', { name: time, exact: true }),
  ).toHaveCount(0);
});

test('negocio inexistente: 404; enlace inválido: mensaje claro sin detalles', async ({ page }) => {
  const res = await page.goto('/este-negocio-no-existe');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Página no encontrada' })).toBeVisible();

  await page.goto(`/mi-reserva#token=${'A'.repeat(43)}`);
  await expect(page.getByText('Este enlace no es válido o ya venció.')).toBeVisible();
  await page.goto('/mi-reserva');
  await expect(page.getByText('Falta el enlace de tu reserva.')).toBeVisible();
});

test('cabeceras de seguridad y el token nunca llega al servidor del portal', async ({ page }) => {
  const res = await page.goto(`/mi-reserva#token=${'B'.repeat(43)}`);
  const h = res!.headers();
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cache-control']).toBe('no-store');
  expect(h['content-security-policy']).toContain("connect-src 'self'");
  expect(h['x-frame-options']).toBe('DENY');
  // la petición de la página no incluye el fragmento
  expect(res!.url()).not.toContain('token=');
});

test('fuera de plazo: no se ofrece cancelar ni cambiar, y se explica por qué', async ({ page }) => {
  // Negocio aparte con plazos de 1000 h: cualquier reserva queda "fuera de plazo", sea la hora que sea.
  const strict = await createBusiness();
  const db = new pg.Client({ connectionString: OWNER_DB_URL });
  await db.connect();
  await db.query(
    `UPDATE tenant_settings SET cancel_window_hours = 1000, reschedule_window_hours = 1000
      WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)`,
    [strict.slug],
  );
  await db.end();

  await page.goto(`/${strict.slug}`);
  await expect(page.getByText('Puedes cancelar hasta 1000 h antes')).toBeVisible();
  await page.getByRole('button', { name: /Corte de pelo/ }).click();
  await page.getByRole('button', { name: 'Beto' }).click();
  await pickSlot(page, 2, 0);
  await page.getByLabel('Nombre').fill('Pronto');
  await page.getByLabel('Teléfono móvil').fill('+56 9 1111 2222');
  await page.getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(page.getByText('¡Reserva lista!')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar reserva' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cambiar horario' })).toHaveCount(0);
  await expect(
    page.getByText(/Las cancelaciones en línea se aceptan hasta 1000 h antes/),
  ).toBeVisible();
});

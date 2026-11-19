import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.js';
import { ApiError } from './errors.js';

const U1 = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f60';
const U2 = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f61';

const authBody = (token = 'access-1') => ({
  accessToken: token,
  expiresIn: 900,
  user: { id: U1, email: 'a@b.test', fullName: 'Ana Pérez', emailVerified: true },
  activeTenantId: U2,
  memberships: [
    { membershipId: U1, tenantId: U2, tenantName: 'Mi Negocio', tenantSlug: 'mi-negocio' },
  ],
});
const meBody = {
  user: {
    id: U1,
    email: 'a@b.test',
    fullName: 'Ana Pérez',
    isPlatformAdmin: false,
    emailVerified: true,
  },
  tenant: {
    id: U2,
    name: 'Mi Negocio',
    slug: 'mi-negocio',
    timezone: 'America/Santiago',
    currency: 'CLP',
  },
  membershipId: U1,
  roles: ['owner'],
  permissions: ['tenant:read'],
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const problem = (status: number, code: string, extra: object = {}) =>
  json(status, {
    type: 'x',
    title: code,
    status,
    code,
    detail: `detalle ${code}`,
    requestId: 'req-12345678',
    ...extra,
  });

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('sesión y token', () => {
  it('login guarda el token SOLO en memoria y lo envía como Bearer; la cookie viaja con credentials', async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.endsWith('/auth/login') ? json(200, authBody()) : json(200, meBody),
    );
    const api = new ApiClient({ fetch: fn });
    await api.login({ email: 'a@b.test', password: 'x' });
    await api.me();
    expect(header(calls[1]!, 'authorization')).toBe('Bearer access-1');
    expect(calls.every((c) => c.init.credentials === 'include')).toBe(true);
    expect(api.isAuthenticated).toBe(true);
  });

  it('no usa localStorage ni sessionStorage', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    const { fn } = mockFetch(() => json(200, authBody()));
    await new ApiClient({ fetch: fn }).login({ email: 'a@b.test', password: 'x' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('los endpoints públicos NO envían el token', async () => {
    const { fn, calls } = mockFetch(() => json(200, authBody()));
    const api = new ApiClient({ fetch: fn });
    api.setAccessToken('secreto');
    await api.login({ email: 'a@b.test', password: 'x' });
    expect(header(calls[0]!, 'authorization')).toBeUndefined();
  });

  it('refresh y logout envían la cabecera anti-CSRF; el resto no', async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.includes('/me')
        ? json(200, meBody)
        : c.url.endsWith('/logout')
          ? new Response(null, { status: 204 })
          : json(200, authBody()),
    );
    const api = new ApiClient({ fetch: fn });
    await api.restoreSession();
    await api.me();
    await api.logout();
    expect(header(calls[0]!, 'x-rp-csrf')).toBe('1');
    expect(header(calls[1]!, 'x-rp-csrf')).toBeUndefined();
    expect(header(calls[2]!, 'x-rp-csrf')).toBe('1');
    expect(api.isAuthenticated).toBe(false);
  });

  it('restoreSession devuelve null si no hay sesión, y propaga errores reales', async () => {
    const none = new ApiClient({ fetch: mockFetch(() => problem(401, 'TOKEN_INVALID')).fn });
    expect(await none.restoreSession()).toBeNull();
    const down = new ApiClient({ fetch: mockFetch(() => problem(500, 'INTERNAL_ERROR')).fn });
    await expect(down.restoreSession()).rejects.toMatchObject({ status: 500 });
  });
});

describe('refresco automático ante 401', () => {
  it('refresca UNA vez y reintenta la petición original', async () => {
    let meCalls = 0;
    const { fn, calls } = mockFetch((c) => {
      if (c.url.endsWith('/auth/refresh')) return json(200, authBody('access-2'));
      meCalls++;
      return meCalls === 1 ? problem(401, 'TOKEN_INVALID') : json(200, meBody);
    });
    const api = new ApiClient({ fetch: fn });
    api.setAccessToken('access-1');
    const me = await api.me();
    expect(me.user.email).toBe('a@b.test');
    expect(calls.map((c) => c.url.split('/api/v1')[1])).toEqual(['/me', '/auth/refresh', '/me']);
    expect(header(calls[2]!, 'authorization')).toBe('Bearer access-2');
  });

  it('cinco peticiones simultáneas con token vencido provocan UN SOLO refresh', async () => {
    const valid = new Set<string>();
    const { fn, calls } = mockFetch(async (c) => {
      if (c.url.endsWith('/auth/refresh')) {
        await new Promise((r) => setTimeout(r, 20));
        valid.add('nuevo');
        return json(200, authBody('nuevo'));
      }
      return header(c, 'authorization') === 'Bearer nuevo'
        ? json(200, meBody)
        : problem(401, 'TOKEN_INVALID');
    });
    const api = new ApiClient({ fetch: fn });
    api.setAccessToken('viejo');
    const results = await Promise.all(Array.from({ length: 5 }, () => api.me()));
    expect(results).toHaveLength(5);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('si el refresh falla: limpia el token, avisa onAuthLost y lanza 401 (sin bucle infinito)', async () => {
    const onAuthLost = vi.fn();
    const { fn, calls } = mockFetch(() => problem(401, 'TOKEN_INVALID'));
    const api = new ApiClient({ fetch: fn, onAuthLost });
    api.setAccessToken('viejo');
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(api.isAuthenticated).toBe(false);
    expect(calls).toHaveLength(2); // /me + /auth/refresh; no reintenta indefinidamente
  });

  it('un 401 en un endpoint público (login) NO dispara refresh ni onAuthLost', async () => {
    const onAuthLost = vi.fn();
    const { fn, calls } = mockFetch(() => problem(401, 'INVALID_CREDENTIALS'));
    const api = new ApiClient({ fetch: fn, onAuthLost });
    await expect(api.login({ email: 'a@b.test', password: 'mala' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(calls).toHaveLength(1);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('un 403 NO cierra la sesión', async () => {
    const onAuthLost = vi.fn();
    const api = new ApiClient({ fetch: mockFetch(() => problem(403, 'FORBIDDEN')).fn, onAuthLost });
    api.setAccessToken('ok');
    await expect(api.getTenant()).rejects.toMatchObject({ status: 403 });
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(api.isAuthenticated).toBe(true);
  });
});

describe('errores', () => {
  it('problem+json: código, detalle, errores por campo y requestId', async () => {
    const body = { errors: [{ path: 'email', message: 'Email inválido' }] };
    const api = new ApiClient({
      fetch: mockFetch(() => problem(400, 'VALIDATION_ERROR', body)).fn,
    });
    const err = await api.login({ email: 'x', password: 'y' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', requestId: 'req-12345678' });
    expect(e.fieldError('email')).toBe('Email inválido');
    expect(e.fieldError('otro')).toBeUndefined();
  });

  it('429 expone Retry-After', async () => {
    const api = new ApiClient({ fetch: mockFetch(() => problem(429, 'RATE_LIMITED')).fn });
    const res = mockFetch(() =>
      json(
        429,
        { code: 'RATE_LIMITED', status: 429, title: 'x', type: 'x' },
        { 'retry-after': '42' },
      ),
    );
    const e = (await new ApiClient({ fetch: res.fn })
      .login({ email: 'a@b.test', password: 'x' })
      .catch((x: unknown) => x)) as ApiError;
    expect(e.isRateLimited).toBe(true);
    expect(e.retryAfter).toBe(42);
    expect(api).toBeDefined();
  });

  it('un fallo de red se convierte en NETWORK_ERROR (sin filtrar el error original)', async () => {
    const api = new ApiClient({
      fetch: (async () => {
        throw new TypeError('Failed to fetch: https://secreto.interno');
      }) as typeof fetch,
    });
    const e = (await api
      .login({ email: 'a@b.test', password: 'x' })
      .catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(e.message).not.toContain('secreto');
  });

  it('una respuesta no JSON (HTML de un proxy) no se expone al usuario', async () => {
    const api = new ApiClient({
      fetch: mockFetch(
        () => new Response('<html>502 Bad Gateway nginx/1.2</html>', { status: 502 }),
      ).fn,
    });
    const e = (await api
      .login({ email: 'a@b.test', password: 'x' })
      .catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(502);
    expect(e.message).not.toContain('nginx');
  });

  it('una respuesta que no cumple el contrato se rechaza (detecta divergencias API/cliente)', async () => {
    const api = new ApiClient({
      fetch: mockFetch(() => json(200, { ...meBody, permissions: 'no-es-lista' })).fn,
    });
    api.setAccessToken('t');
    await expect(api.me()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('204 sin cuerpo se resuelve como undefined', async () => {
    const api = new ApiClient({ fetch: mockFetch(() => new Response(null, { status: 204 })).fn });
    await expect(api.forgotPassword({ email: 'a@b.test' })).resolves.toBeUndefined();
  });
});

describe('construcción de peticiones', () => {
  it('serializa query omitiendo undefined y escapa los ids de ruta', async () => {
    const { fn, calls } = mockFetch(() => json(200, { items: [], nextCursor: null }));
    const api = new ApiClient({ fetch: fn, baseUrl: 'https://api.test/api/v1/' });
    api.setAccessToken('t');
    await api.listMembers({ limit: 10, cursor: undefined });
    expect(calls[0]!.url).toBe('https://api.test/api/v1/tenants/current/members?limit=10');

    const m = mockFetch(() => new Response(null, { status: 204 }));
    const api2 = new ApiClient({ fetch: m.fn });
    api2.setAccessToken('t');
    await api2.revokeInvitation('../../x?y=1');
    expect(m.calls[0]!.url).toContain(encodeURIComponent('../../x?y=1'));
  });

  it('el token de una invitación va en el cuerpo, nunca en la URL', async () => {
    const { fn, calls } = mockFetch(() =>
      json(200, { tenantName: 'N', roleName: 'R', email: 'a@b.test', accountExists: false }),
    );
    await new ApiClient({ fetch: fn }).previewInvitation('TOKEN-SECRETO-123456789');
    expect(calls[0]!.url).not.toContain('TOKEN-SECRETO');
    expect(calls[0]!.init.body).toContain('TOKEN-SECRETO');
  });
});

describe('endpoints de catálogo y agenda', () => {
  const U = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f60';
  type Call = [
    name: string,
    run: (api: ApiClient) => Promise<unknown>,
    method: string,
    path: string,
    body?: unknown,
  ];
  const table: Call[] = [
    [
      'listLocations',
      (a) => a.listLocations({ q: 'x', limit: 5 }),
      'GET',
      '/locations?q=x&limit=5',
    ],
    [
      'createLocation',
      (a) => a.createLocation({ name: 'Centro', address: {} }),
      'POST',
      '/locations',
      { name: 'Centro', address: {} },
    ],
    [
      'updateLocation',
      (a) => a.updateLocation(U, { isActive: false }),
      'PATCH',
      `/locations/${U}`,
      { isActive: false },
    ],
    ['deleteLocation', (a) => a.deleteLocation(U), 'DELETE', `/locations/${U}`],
    ['listServices', (a) => a.listServices({ isActive: true }), 'GET', '/services?isActive=true'],
    [
      'setServiceLocations',
      (a) => a.setServiceLocations(U, { locationIds: [U] }),
      'PUT',
      `/services/${U}/locations`,
      { locationIds: [U] },
    ],
    [
      'setServiceResources',
      (a) => a.setServiceResources(U, { resourceIds: [] }),
      'PUT',
      `/services/${U}/resources`,
      { resourceIds: [] },
    ],
    [
      'listResources',
      (a) => a.listResources({ locationId: U }),
      'GET',
      `/resources?locationId=${U}`,
    ],
    [
      'setBusinessHours',
      (a) => a.setBusinessHours(U, { intervals: [] }),
      'PUT',
      `/locations/${U}/business-hours`,
      { intervals: [] },
    ],
    [
      'setResourceSchedule',
      (a) => a.setResourceSchedule(U, { intervals: [] }),
      'PUT',
      `/resources/${U}/schedule`,
      { intervals: [] },
    ],
    [
      'listOverrides',
      (a) => a.listOverrides('resources', U, { from: '2027-01-01', to: '2027-01-31' }),
      'GET',
      `/resources/${U}/overrides?from=2027-01-01&to=2027-01-31`,
    ],
    [
      'putOverride',
      (a) => a.putOverride('locations', U, '2027-12-25', { closed: true, intervals: [] }),
      'PUT',
      `/locations/${U}/overrides/2027-12-25`,
      { closed: true, intervals: [] },
    ],
    [
      'deleteOverride',
      (a) => a.deleteOverride('locations', U, '2027-12-25'),
      'DELETE',
      `/locations/${U}/overrides/2027-12-25`,
    ],
    ['listHolidays', (a) => a.listHolidays(2027), 'GET', '/holidays?year=2027'],
    [
      'putHoliday',
      (a) => a.putHoliday('2027-09-18', { name: 'Fiestas' }),
      'PUT',
      '/holidays/2027-09-18',
      { name: 'Fiestas' },
    ],
    [
      'updateBlock',
      (a) => a.updateBlock(U, { reason: 'x' }),
      'PATCH',
      `/blocks/${U}`,
      { reason: 'x' },
    ],
    ['deleteBlock', (a) => a.deleteBlock(U), 'DELETE', `/blocks/${U}`],
    [
      'getCalendar',
      (a) => a.getCalendar({ from: '2027-07-05', to: '2027-07-11' }),
      'GET',
      '/calendar?from=2027-07-05&to=2027-07-11',
    ],
  ];

  it.each(table)(
    '%s usa el método, la ruta y el cuerpo correctos',
    async (_name, run, method, path, body) => {
      const { fn, calls } = mockFetch(() => new Response(null, { status: 204 }));
      const api = new ApiClient({ fetch: fn, validateResponses: false });
      api.setAccessToken('t');
      await run(api);
      const call = calls[0]!;
      expect(call.init.method).toBe(method);
      expect(call.url).toBe(`/api/v1${path}`);
      if (body !== undefined) expect(JSON.parse(call.init.body as string)).toEqual(body);
      else expect(call.init.body).toBeUndefined();
    },
  );

  it('los ids y fechas se escapan: no pueden alterar la ruta', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 204 }));
    const api = new ApiClient({ fetch: fn });
    api.setAccessToken('t');
    await api.deleteLocation('../../tenants/current?x=1');
    await api.deleteOverride('locations', U, '../../x');
    expect(calls[0]!.url).toBe(
      `/api/v1/locations/${encodeURIComponent('../../tenants/current?x=1')}`,
    );
    expect(calls[1]!.url).not.toContain('/../');
  });

  it('valida la forma de un listado de servicios (precio como texto) y rechaza una respuesta distinta', async () => {
    const service = {
      id: U,
      name: 'Corte',
      description: null,
      categoryId: null,
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      price: '12990.00',
      currency: 'CLP',
      minNoticeMinutes: null,
      maxAdvanceDays: null,
      requiresConfirmation: null,
      imageUrl: null,
      isActive: true,
      locationIds: [],
      resourceIds: [],
      createdAt: '2027-01-01T00:00:00.000Z',
    };
    const ok = new ApiClient({
      fetch: mockFetch(() => json(200, { items: [service], nextCursor: null })).fn,
    });
    ok.setAccessToken('t');
    expect((await ok.listServices()).items[0]!.price).toBe('12990.00');

    const numeric = new ApiClient({
      fetch: mockFetch(() => json(200, { items: [{ ...service, price: 12990 }], nextCursor: null }))
        .fn,
    });
    numeric.setAccessToken('t');
    await expect(numeric.listServices()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); // el dinero NO viaja como número
  });
});

describe('endpoints de reservas', () => {
  const U = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f60';
  const setup = () => {
    const m = mockFetch(() => json(200, {}));
    const api = new ApiClient({ fetch: m.fn, validateResponses: false });
    api.setAccessToken('t');
    return { api, calls: m.calls };
  };

  it('crear envía la Idempotency-Key indicada; reintentar con la misma la repite', async () => {
    const { api, calls } = setup();
    const body = {
      serviceId: U,
      locationId: U,
      startAt: '2027-07-05T13:00:00.000Z',
      customer: { id: U },
    };
    await api.createReservation(body, 'clave-intento-0001');
    await api.createReservation(body, 'clave-intento-0001');
    expect(calls.map((c) => header(c, 'idempotency-key'))).toEqual([
      'clave-intento-0001',
      'clave-intento-0001',
    ]);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/v1/reservations');
    // una cabecera extra no puede pisar el token
    expect(header(calls[0]!, 'authorization')).toBe('Bearer t');
  });

  it('las transiciones envían la versión y van a su ruta', async () => {
    const { api, calls } = setup();
    await api.confirmReservation(U, 3);
    await api.cancelReservation(U, { version: 4, reason: 'x' });
    await api.changeReservationStatus(U, { version: 5, status: 'completed' });
    await api.rescheduleReservation(U, { version: 6, startAt: '2027-07-05T15:00:00.000Z' });
    expect(calls.map((c) => [c.url, JSON.parse(String(c.init.body)).version])).toEqual([
      [`/api/v1/reservations/${U}/confirm`, 3],
      [`/api/v1/reservations/${U}/cancel`, 4],
      [`/api/v1/reservations/${U}/status`, 5],
      [`/api/v1/reservations/${U}/reschedule`, 6],
    ]);
    expect(calls.some((c) => header(c, 'idempotency-key') !== undefined)).toBe(false);
  });

  it('disponibilidad, listados y clientes construyen la query', async () => {
    const { api, calls } = setup();
    await api.getAvailability({ serviceId: U, locationId: U, from: '2027-07-05', days: 7 });
    await api.listReservations({ status: 'confirmed', limit: 20 });
    await api.listCustomers({ q: 'ana' });
    await api.listReservationEvents(U);
    expect(calls.map((c) => c.url)).toEqual([
      `/api/v1/availability?serviceId=${U}&locationId=${U}&from=2027-07-05&days=7`,
      '/api/v1/reservations?status=confirmed&limit=20',
      '/api/v1/customers?q=ana',
      `/api/v1/reservations/${U}/events`,
    ]);
  });
});

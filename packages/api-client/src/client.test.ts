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

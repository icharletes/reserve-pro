import { ApiError } from '@reservepro/api-client';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, auth, ids, me } from './helpers';

vi.mock('../api', () => ({
  api: apiMock,
  setAuthLostHandler: (fn: () => void) => (lostHandler = fn),
}));
let lostHandler: () => void = () => undefined;

import { resetBootstrapForTests, useAuthStore } from '../stores/auth';

beforeEach(() => {
  setActivePinia(createPinia());
  resetBootstrapForTests();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  lostHandler = () => undefined;
});

describe('bootstrap (restaurar la sesión al abrir la app)', () => {
  it('restaura usuario, empresas y permisos desde la cookie', async () => {
    apiMock.restoreSession.mockResolvedValue(auth());
    apiMock.me.mockResolvedValue(me(['tenant:read', 'members:read']));
    const s = useAuthStore();
    await s.bootstrap();
    expect(s.ready).toBe(true);
    expect(s.isAuthenticated).toBe(true);
    expect(s.activeMembership?.tenantName).toBe('Barbería Uno');
    expect(s.can('members:read')).toBe(true);
    expect(s.can('audit:read')).toBe(false);
  });

  it('sin sesión: queda como visitante pero "listo"', async () => {
    apiMock.restoreSession.mockResolvedValue(null);
    const s = useAuthStore();
    await s.bootstrap();
    expect(s.ready).toBe(true);
    expect(s.isAuthenticated).toBe(false);
  });

  it('se ejecuta UNA sola vez aunque se llame varias veces (guards simultáneos)', async () => {
    apiMock.restoreSession.mockResolvedValue(null);
    const s = useAuthStore();
    await Promise.all([s.bootstrap(), s.bootstrap(), s.bootstrap()]);
    expect(apiMock.restoreSession).toHaveBeenCalledTimes(1);
  });

  it('si la API no responde al abrir, NO deja la app colgada: degrada a visitante', async () => {
    apiMock.restoreSession.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'sin red'));
    const s = useAuthStore();
    await expect(s.bootstrap()).resolves.toBeUndefined();
    expect(s.ready).toBe(true);
    expect(s.isAuthenticated).toBe(false);
  });
});

describe('acciones', () => {
  it('login: carga /me solo si hay empresa activa', async () => {
    const s = useAuthStore();
    apiMock.login.mockResolvedValue(auth(null)); // varias empresas, ninguna activa
    await s.login('ana@x.test', 'x');
    expect(s.isAuthenticated).toBe(true);
    expect(s.hasTenant).toBe(false);
    expect(apiMock.me).not.toHaveBeenCalled();

    apiMock.switchTenant.mockResolvedValue(auth(ids.T2));
    apiMock.me.mockResolvedValue(me());
    await s.switchTenant(ids.T2);
    expect(s.hasTenant).toBe(true);
    expect(s.activeTenantId).toBe(ids.T2);
  });

  it('un login fallido no deja estado a medias', async () => {
    apiMock.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'x'));
    const s = useAuthStore();
    await expect(s.login('ana@x.test', 'mala')).rejects.toBeInstanceOf(ApiError);
    expect(s.isAuthenticated).toBe(false);
  });

  it('logout limpia TODO el estado incluso si la API falla', async () => {
    apiMock.restoreSession.mockResolvedValue(auth());
    apiMock.me.mockResolvedValue(me());
    const s = useAuthStore();
    await s.bootstrap();
    apiMock.logout.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'x'));
    await expect(s.logout()).rejects.toBeInstanceOf(ApiError);
    expect(s.isAuthenticated).toBe(false);
    expect(s.me).toBeNull();
    expect(s.memberships).toEqual([]);
  });

  it('si el cliente pierde la sesión (refresh fallido), el store se limpia', async () => {
    apiMock.restoreSession.mockResolvedValue(auth());
    apiMock.me.mockResolvedValue(me());
    const s = useAuthStore();
    await s.bootstrap();
    expect(s.isAuthenticated).toBe(true);
    lostHandler();
    expect(s.isAuthenticated).toBe(false);
  });

  it('can() es falso sin datos de /me (nunca concede por omisión)', () => {
    expect(useAuthStore().can('tenant:read')).toBe(false);
  });
});

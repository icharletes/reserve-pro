import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import { apiMock, auth, ids, me } from './helpers';

vi.mock('../api', () => ({ api: apiMock, setAuthLostHandler: () => undefined }));

import { createAppRouter } from '../router';
import { resetBootstrapForTests, useAuthStore } from '../stores/auth';

type Session = 'none' | 'no-tenant' | 'tenant';
async function setup(session: Session, permissions: string[] = ['tenant:read']) {
  setActivePinia(createPinia());
  resetBootstrapForTests();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.me.mockResolvedValue(me(permissions));
  apiMock.restoreSession.mockResolvedValue(
    session === 'none' ? null : auth(session === 'tenant' ? ids.T1 : null),
  );
  const router = createAppRouter(createMemoryHistory());
  await useAuthStore().bootstrap();
  return router;
}
const go = async (router: Awaited<ReturnType<typeof setup>>, path: string) => {
  await router.push(path);
  await router.isReady();
  return router.currentRoute.value;
};

describe('guards de navegación', () => {
  it('visitante en una ruta privada: va al login conservando el destino', async () => {
    const r = await setup('none');
    const route = await go(r, '/members');
    expect(route.name).toBe('login');
    expect(route.query['redirect']).toBe('/members');
  });

  it('visitante puede ver login, registro, recuperar contraseña y los enlaces del email', async () => {
    const r = await setup('none');
    for (const [path, name] of [
      ['/login', 'login'],
      ['/register', 'register'],
      ['/forgot-password', 'forgot-password'],
      ['/reset-password', 'reset-password'],
      ['/verify-email', 'verify-email'],
      ['/accept-invitation', 'accept-invitation'],
    ] as const) {
      expect((await go(r, path)).name, path).toBe(name);
    }
  });

  it('con sesión, login y registro redirigen al inicio', async () => {
    const r = await setup('tenant');
    expect((await go(r, '/login')).name).toBe('dashboard');
    expect((await go(r, '/register')).name).toBe('dashboard');
  });

  it('con sesión pero SIN empresa activa, todo lleva al selector de empresa', async () => {
    const r = await setup('no-tenant');
    expect((await go(r, '/')).name).toBe('select-tenant');
    expect((await go(r, '/members')).name).toBe('select-tenant');
    expect((await go(r, '/login')).name).toBe('select-tenant');
  });

  it('el enlace de una invitación funciona con o sin sesión', async () => {
    expect((await go(await setup('tenant'), '/accept-invitation')).name).toBe('accept-invitation');
    expect((await go(await setup('none'), '/accept-invitation')).name).toBe('accept-invitation');
  });

  it('sin el permiso, una pantalla protegida muestra "sin acceso"; con el permiso, entra', async () => {
    expect((await go(await setup('tenant', ['tenant:read']), '/members')).name).toBe('forbidden');
    expect((await go(await setup('tenant', ['tenant:read']), '/audit')).name).toBe('forbidden');
    expect((await go(await setup('tenant', ['members:read']), '/members')).name).toBe('members');
    expect((await go(await setup('tenant', ['audit:read']), '/audit')).name).toBe('audit');
  });

  it('con sesión se puede volver a elegir empresa', async () => {
    expect((await go(await setup('tenant'), '/select-tenant')).name).toBe('select-tenant');
  });

  it('una ruta inexistente muestra "no encontrado" también a visitantes', async () => {
    expect((await go(await setup('none'), '/nada/por/aqui')).name).toBe('not-found');
  });

  it('actualiza el título de la pestaña', async () => {
    await go(await setup('none'), '/login');
    expect(document.title).toBe('Iniciar sesión · ReservePro');
  });
});

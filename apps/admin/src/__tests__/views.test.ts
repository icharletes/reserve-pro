import { ApiError } from '@reservepro/api-client';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, auth, ids, me } from './helpers';

vi.mock('../api', () => ({ api: apiMock, setAuthLostHandler: () => undefined }));

import { createAppRouter } from '../router';
import { resetBootstrapForTests } from '../stores/auth';
import AcceptInvitationView from '../views/AcceptInvitationView.vue';
import ForgotPasswordView from '../views/ForgotPasswordView.vue';
import LoginView from '../views/LoginView.vue';
import ResetPasswordView from '../views/ResetPasswordView.vue';

async function mountView(component: object, url = '/') {
  const pinia = createPinia();
  setActivePinia(pinia);
  resetBootstrapForTests();
  apiMock.restoreSession.mockResolvedValue(null);
  const router = createAppRouter(createMemoryHistory());
  window.history.replaceState(null, '', url);
  await router.push('/login'); // arranca en una ruta de visitante
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [pinia, router] } });
  return { wrapper, router };
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('LoginView', () => {
  it('el botón está deshabilitado hasta completar email y contraseña', async () => {
    const { wrapper } = await mountView(LoginView);
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined();
    await wrapper.get('input[type=email]').setValue('ana@x.test');
    await wrapper.get('input[type=password]').setValue('x');
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeUndefined();
  });

  it('envía el email sin espacios y entra al panel', async () => {
    apiMock.login.mockResolvedValue(auth());
    apiMock.me.mockResolvedValue(me());
    const { wrapper, router } = await mountView(LoginView);
    await wrapper.get('input[type=email]').setValue('  ana@x.test  ');
    await wrapper.get('input[type=password]').setValue('clave-larga-123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.login).toHaveBeenCalledWith({ email: 'ana@x.test', password: 'clave-larga-123' });
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('dashboard'));
  });

  it('muestra el error en español y NO limpia el email escrito', async () => {
    apiMock.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'x'));
    const { wrapper } = await mountView(LoginView);
    await wrapper.get('input[type=email]').setValue('ana@x.test');
    await wrapper.get('input[type=password]').setValue('mala');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('incorrectos');
    expect((wrapper.get('input[type=email]').element as HTMLInputElement).value).toBe('ana@x.test');
  });

  it('un doble clic NO envía dos veces', async () => {
    let release!: () => void;
    apiMock.login.mockImplementation(() => new Promise((r) => (release = () => r(auth()))));
    apiMock.me.mockResolvedValue(me());
    const { wrapper } = await mountView(LoginView);
    await wrapper.get('input[type=email]').setValue('ana@x.test');
    await wrapper.get('input[type=password]').setValue('x');
    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    expect(apiMock.login).toHaveBeenCalledTimes(1);
    release();
    await flushPromises();
  });

  it('vuelve al destino pedido, pero IGNORA un redirect hacia otro sitio', async () => {
    apiMock.login.mockResolvedValue(auth());
    apiMock.me.mockResolvedValue(me(['members:read']));
    const good = await mountView(LoginView);
    await good.router.push({ name: 'login', query: { redirect: '/members' } });
    await good.wrapper.get('input[type=email]').setValue('ana@x.test');
    await good.wrapper.get('input[type=password]').setValue('x');
    await good.wrapper.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(good.router.currentRoute.value.name).toBe('members'));

    const evil = await mountView(LoginView);
    await evil.router.push({ name: 'login', query: { redirect: '//evil.com' } });
    await evil.wrapper.get('input[type=email]').setValue('ana@x.test');
    await evil.wrapper.get('input[type=password]').setValue('x');
    await evil.wrapper.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(evil.router.currentRoute.value.name).toBe('dashboard'));
    expect(evil.router.currentRoute.value.fullPath).toBe('/');
  });

  it('con varias empresas y ninguna activa, lleva al selector', async () => {
    apiMock.login.mockResolvedValue(auth(null));
    const { wrapper, router } = await mountView(LoginView);
    await wrapper.get('input[type=email]').setValue('ana@x.test');
    await wrapper.get('input[type=password]').setValue('x');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('select-tenant'));
  });
});

describe('ForgotPasswordView', () => {
  it('muestra SIEMPRE el mismo mensaje (no revela si la cuenta existe)', async () => {
    apiMock.forgotPassword.mockResolvedValue(undefined);
    const { wrapper } = await mountView(ForgotPasswordView);
    await wrapper.get('input[type=email]').setValue('quien-sea@x.test');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Si existe una cuenta con ese email');
  });
});

describe('AcceptInvitationView', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

  it('lee el token del fragmento, lo borra de la URL y muestra empresa y rol', async () => {
    apiMock.previewInvitation.mockResolvedValue({ tenantName: 'Spa Lago', roleName: 'Gerente', email: 'nuevo@x.test', accountExists: false });
    const { wrapper } = await mountView(AcceptInvitationView, `/accept-invitation#token=${TOKEN}`);
    await flushPromises();
    expect(apiMock.previewInvitation).toHaveBeenCalledWith(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(wrapper.text()).toContain('Spa Lago');
    expect(wrapper.text()).toContain('Gerente');
  });

  it('cuenta nueva: pide nombre y contraseña, crea la cuenta e inicia sesión', async () => {
    apiMock.previewInvitation.mockResolvedValue({ tenantName: 'Spa Lago', roleName: 'Gerente', email: 'nuevo@x.test', accountExists: false });
    apiMock.acceptInvitation.mockResolvedValue({ outcome: 'account_created', tenantName: 'Spa Lago', auth: auth() });
    apiMock.me.mockResolvedValue(me());
    const { wrapper, router } = await mountView(AcceptInvitationView, `/accept-invitation#token=${TOKEN}`);
    await flushPromises();
    const inputs = wrapper.findAll('input');
    expect(inputs.length).toBe(3); // email (deshabilitado) + nombre + contraseña
    await inputs[1]!.setValue('Marta Díaz');
    await inputs[2]!.setValue('clave-larga-123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.acceptInvitation).toHaveBeenCalledWith({ token: TOKEN, fullName: 'Marta Díaz', password: 'clave-larga-123' });
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('dashboard'));
  });

  it('cuenta existente: solo confirma (no pide contraseña) y pide iniciar sesión', async () => {
    apiMock.previewInvitation.mockResolvedValue({ tenantName: 'Spa Lago', roleName: 'Gerente', email: 'ana@x.test', accountExists: true });
    apiMock.acceptInvitation.mockResolvedValue({ outcome: 'joined', tenantName: 'Spa Lago' });
    const { wrapper } = await mountView(AcceptInvitationView, `/accept-invitation#token=${TOKEN}`);
    await flushPromises();
    expect(wrapper.findAll('input').length).toBe(1); // solo el email, deshabilitado
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.acceptInvitation).toHaveBeenCalledWith({ token: TOKEN });
    expect(wrapper.text()).toContain('Inicia sesión');
  });

  it('sin token o con un token inválido muestra el error y no pide datos', async () => {
    const none = await mountView(AcceptInvitationView, '/accept-invitation');
    await flushPromises();
    expect(none.wrapper.text()).toContain('no es válido');
    expect(apiMock.previewInvitation).not.toHaveBeenCalled();

    apiMock.previewInvitation.mockRejectedValue(new ApiError(400, 'INVITATION_INVALID', 'x'));
    const bad = await mountView(AcceptInvitationView, `/accept-invitation#token=${TOKEN}`);
    await flushPromises();
    expect(bad.wrapper.text()).toContain('ya fue usada o expiró');
    expect(bad.wrapper.find('form').exists()).toBe(false);
  });
});

describe('ResetPasswordView', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

  it('exige que ambas contraseñas coincidan ANTES de llamar a la API', async () => {
    const { wrapper } = await mountView(ResetPasswordView, `/reset-password#token=${TOKEN}`);
    const [a, b] = wrapper.findAll('input');
    await a!.setValue('Clave-Nueva-123');
    await b!.setValue('Clave-Distinta-1');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.resetPassword).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('no coinciden');
  });

  it('envía el token del fragmento (y lo borra de la URL)', async () => {
    apiMock.resetPassword.mockResolvedValue(undefined);
    const { wrapper } = await mountView(ResetPasswordView, `/reset-password#token=${TOKEN}`);
    expect(window.location.href).not.toContain(TOKEN);
    const [a, b] = wrapper.findAll('input');
    await a!.setValue('Clave-Nueva-123');
    await b!.setValue('Clave-Nueva-123');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.resetPassword).toHaveBeenCalledWith({ token: TOKEN, password: 'Clave-Nueva-123' });
    expect(wrapper.text()).toContain('contraseña fue actualizada');
  });

  it('sin token muestra el enlace inválido', async () => {
    const { wrapper } = await mountView(ResetPasswordView, '/reset-password');
    expect(wrapper.text()).toContain('no es válido');
    expect(wrapper.find('form').exists()).toBe(false);
  });
});

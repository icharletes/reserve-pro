import { ApiError } from '@reservepro/api-client';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, auth, me } from './helpers';

vi.mock('../api', () => ({ api: apiMock, setAuthLostHandler: () => undefined }));

import { createAppRouter } from '../router';
import { resetBootstrapForTests } from '../stores/auth';
import CommunicationsView from '../views/CommunicationsView.vue';
import SettingsView from '../views/SettingsView.vue';

async function mountAt(component: object, path: string, permissions: string[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  resetBootstrapForTests();
  apiMock.restoreSession.mockResolvedValue(auth());
  apiMock.me.mockResolvedValue(me(permissions));
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return { wrapper, router };
}

const U = (n: number) => `0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f${String(n).padStart(2, '0')}`;
const settings = {
  publicBookingEnabled: true,
  bookingMinNoticeMinutes: 60,
  bookingMaxAdvanceDays: 90,
  slotStepMinutes: 15,
  autoConfirm: true,
  pendingHoldMinutes: 30,
  selfServiceCancel: true,
  cancelWindowHours: 24,
  cancelRequiresApproval: false,
  selfServiceReschedule: true,
  rescheduleWindowHours: 24,
  maxReschedules: 2,
  maxActivePublicPerCustomer: 3,
  customerEmailsEnabled: true,
  reminderHoursBefore: 24,
  updatedAt: '2027-01-01T00:00:00.000Z',
};
const notification = (extra: object = {}) => ({
  id: U(1),
  channel: 'email',
  type: 'reservation.created_confirmed',
  recipient: 'carla@example.test',
  subject: 'Reserva confirmada en Barbería Uno',
  status: 'sent',
  attempts: 1,
  lastError: null,
  reservationId: U(2),
  reservationCode: 'RP-ABC234',
  customerName: 'Carla Pérez',
  createdAt: '2027-07-01T12:00:00.000Z',
  sentAt: '2027-07-01T12:00:05.000Z',
  ...extra,
});

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const button = (w: ReturnType<typeof mount>, text: string) =>
  w.findAll('button').find((b) => b.text().startsWith(text))!;

describe('SettingsView', () => {
  it('muestra la configuración en palabras y envía SOLO lo que cambió', async () => {
    apiMock.getTenantSettings.mockResolvedValue(settings);
    apiMock.updateTenantSettings.mockImplementation(async (body: object) => ({
      ...settings,
      ...body,
    }));
    const { wrapper } = await mountAt(SettingsView, '/settings', ['tenant:read', 'tenant:update']);
    expect(wrapper.text()).toContain('/barberia-uno'); // enlace a su portal
    expect((wrapper.find('#s-notice').element as HTMLSelectElement).selectedOptions[0]!.text).toBe(
      '1 hora',
    );
    // sin cambios, no se puede guardar
    expect(button(wrapper, 'Guardar').attributes('disabled')).toBeDefined();

    await wrapper.find('#s-cw').setValue('48');
    await wrapper.find('#s-rem').setValue('Sin recordatorio');
    const checks = wrapper.findAll('input[type=checkbox]');
    await checks
      .find((c) => c.element.parentElement!.textContent!.includes('Confirmar automáticamente'))!
      .setValue(false);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(apiMock.updateTenantSettings).toHaveBeenCalledWith({
      cancelWindowHours: 48,
      reminderHoursBefore: null,
      autoConfirm: false,
    });
    expect(wrapper.text()).toContain('Configuración guardada');
    expect(button(wrapper, 'Guardar').attributes('disabled')).toBeDefined();
  });

  it('sin tenant:update es de solo lectura', async () => {
    apiMock.getTenantSettings.mockResolvedValue(settings);
    const { wrapper } = await mountAt(SettingsView, '/settings', ['tenant:read']);
    expect(wrapper.text()).toContain('no cambiarla');
    expect(wrapper.find('fieldset').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').some((b) => b.text().startsWith('Guardar'))).toBe(false);
  });

  it('un error del servidor se muestra y no se pierde lo editado', async () => {
    apiMock.getTenantSettings.mockResolvedValue(settings);
    apiMock.updateTenantSettings.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'x'));
    const { wrapper } = await mountAt(SettingsView, '/settings', ['tenant:read', 'tenant:update']);
    await wrapper.find('#s-mr').setValue('5');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('No hay conexión');
    expect((wrapper.find('#s-mr').element as HTMLInputElement).value).toBe('5');
  });
});

describe('CommunicationsView', () => {
  it('lista los mensajes con su estado y permite reintentar SOLO los fallidos', async () => {
    apiMock.listNotifications.mockResolvedValue({
      items: [
        notification(),
        notification({
          id: U(3),
          type: 'reservation.reminder',
          status: 'failed',
          attempts: 6,
          lastError: 'Error: 550 rechazado para <email>',
          sentAt: null,
        }),
      ],
      nextCursor: null,
    });
    apiMock.retryNotification.mockResolvedValue(notification({ id: U(3), status: 'queued' }));
    const { wrapper } = await mountAt(CommunicationsView, '/communications', [
      'notifications:read',
      'notifications:resend',
    ]);
    expect(wrapper.text()).toContain('Reserva confirmada');
    expect(wrapper.text()).toContain('Recordatorio');
    expect(wrapper.text()).toContain('Enviado');
    expect(wrapper.text()).toContain('Falló');
    expect(wrapper.text()).toContain('6 intentos');
    expect(wrapper.find(`a[href="/reservations/${U(2)}"]`).text()).toBe('RP-ABC234');
    const retries = wrapper.findAll('button').filter((b) => b.text() === 'Reintentar');
    expect(retries).toHaveLength(1);
    await retries[0]!.trigger('click');
    await flushPromises();
    expect(apiMock.retryNotification).toHaveBeenCalledWith(U(3));
    expect(wrapper.text()).toContain('Reintento en cola');

    await wrapper.find('#n-status').setValue('failed');
    await flushPromises();
    expect(apiMock.listNotifications.mock.calls.at(-1)![0]).toMatchObject({ status: 'failed' });
  });

  it('sin notifications:resend no hay botón de reintentar; sin :read la ruta está prohibida', async () => {
    apiMock.listNotifications.mockResolvedValue({
      items: [notification({ status: 'failed' })],
      nextCursor: null,
    });
    const { wrapper } = await mountAt(CommunicationsView, '/communications', [
      'notifications:read',
    ]);
    expect(wrapper.findAll('button').some((b) => b.text() === 'Reintentar')).toBe(false);
    const { router } = await mountAt(CommunicationsView, '/communications', ['tenant:read']);
    expect(router.currentRoute.value.name).toBe('forbidden');
  });
});

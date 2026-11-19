import { ApiError } from '@reservepro/api-client';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, auth, me } from './helpers';

vi.mock('../api', () => ({ api: apiMock, setAuthLostHandler: () => undefined }));

import { createAppRouter } from '../router';
import { resetBootstrapForTests } from '../stores/auth';
import CalendarView from '../views/CalendarView.vue';
import CustomersView from '../views/CustomersView.vue';
import NewReservationView from '../views/NewReservationView.vue';
import ReservationDetailView from '../views/ReservationDetailView.vue';
import ReservationsView from '../views/ReservationsView.vue';

const STAFF = [
  'reservations:read',
  'reservations:create',
  'reservations:confirm',
  'reservations:cancel',
  'reservations:reschedule',
  'reservations:status',
  'customers:read',
  'customers:write',
  'locations:read',
  'resources:read',
  'services:read',
  'calendar:read',
];

async function mountAt(component: object, path: string, permissions: string[] = STAFF) {
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
const page = <T>(items: T[]) => ({ items, nextCursor: null });
const LOC = U(1);
const SVC = U(2);
const ANA = U(3);
const BETO = U(4);
const RES = U(5);
const CUS = U(6);

const location = {
  id: LOC,
  name: 'Centro',
  address: {},
  phone: null,
  email: null,
  timezone: null,
  effectiveTimezone: 'America/Santiago',
  isActive: true,
  createdAt: '2027-01-01T00:00:00.000Z',
};
const service = {
  id: SVC,
  name: 'Corte',
  description: null,
  categoryId: null,
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  price: '15000.00',
  currency: 'CLP',
  minNoticeMinutes: null,
  maxAdvanceDays: null,
  requiresConfirmation: null,
  imageUrl: null,
  isActive: true,
  locationIds: [LOC],
  resourceIds: [ANA, BETO],
  createdAt: '2027-01-01T00:00:00.000Z',
};
// 09:00 y 10:00 en Santiago (invierno, UTC-4)
const availability = {
  timezone: 'America/Santiago',
  stepMinutes: 15,
  resources: [
    {
      resourceId: ANA,
      name: 'Ana',
      slots: [{ start: '2027-07-05T13:00:00.000Z', end: '2027-07-05T14:00:00.000Z' }],
    },
    {
      resourceId: BETO,
      name: 'Beto',
      slots: [
        { start: '2027-07-05T13:00:00.000Z', end: '2027-07-05T14:00:00.000Z' },
        { start: '2027-07-05T14:00:00.000Z', end: '2027-07-05T15:00:00.000Z' },
      ],
    },
  ],
};
const reservation = (extra: object = {}) => ({
  id: RES,
  code: 'RP-ABC234',
  status: 'confirmed',
  source: 'admin',
  locationId: LOC,
  customer: {
    id: CUS,
    firstName: 'Carla',
    lastName: 'Pérez',
    phoneE164: '+56911111111',
    email: null,
  },
  startAt: '2027-07-05T13:00:00.000Z',
  endAt: '2027-07-05T14:00:00.000Z',
  timeZone: 'America/Santiago',
  totalAmount: '15000.00',
  currency: 'CLP',
  paidAmount: '0.00',
  rescheduleCount: 0,
  customerNotes: null,
  internalNotes: null,
  cancelledAt: null,
  cancellationReason: null,
  version: 1,
  items: [
    {
      serviceId: SVC,
      serviceName: 'Corte',
      durationMinutes: 60,
      unitPrice: '15000.00',
      startAt: '2027-07-05T13:00:00.000Z',
      endAt: '2027-07-05T14:00:00.000Z',
    },
  ],
  resources: [
    {
      resourceId: ANA,
      occupyStart: '2027-07-05T13:00:00.000Z',
      occupyEnd: '2027-07-05T14:00:00.000Z',
    },
  ],
  createdAt: '2027-07-01T00:00:00.000Z',
  ...extra,
});
const resourcesPage = page([
  { id: ANA, name: 'Ana' },
  { id: BETO, name: 'Beto' },
]);

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.listResources.mockResolvedValue(resourcesPage);
  apiMock.listLocations.mockResolvedValue(page([location]));
  apiMock.listServices.mockResolvedValue(page([service]));
  apiMock.getAvailability.mockResolvedValue(availability);
  apiMock.listReservationEvents.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const slotButtons = (w: ReturnType<typeof mount>) => w.findAll('.slots button');

async function fillNewCustomer(w: ReturnType<typeof mount>) {
  await w.find('input[type=radio][value=new]').setValue(true);
  const byLabel = (text: string) => {
    const label = w.findAll('label').find((l) => l.text() === text)!;
    return w.find(`#${label.attributes('for')}`);
  };
  await byLabel('Nombre').setValue('Lucía');
  await byLabel('Teléfono').setValue('9 4444 4444');
}

describe('NewReservationView', () => {
  it('con una sucursal y un servicio los preselecciona; ofrece "cualquiera" en hora local', async () => {
    const { wrapper } = await mountAt(NewReservationView, '/reservations/new?date=2027-07-05');
    expect(apiMock.listServices).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: LOC, isActive: true }),
    );
    expect(apiMock.getAvailability).toHaveBeenCalledWith({
      serviceId: SVC,
      locationId: LOC,
      from: '2027-07-05',
    });
    // "cualquiera": unión sin repetir de los horarios de todos, en hora de la sucursal
    expect(slotButtons(wrapper).map((b) => b.text())).toEqual(['09:00', '10:00']);
    await wrapper.find('#sp-res').setValue(ANA);
    expect(slotButtons(wrapper).map((b) => b.text())).toEqual(['09:00']);
  });

  it('reserva con cliente nuevo (teléfono normalizado) y abre el detalle', async () => {
    apiMock.createReservation.mockResolvedValue(reservation());
    const { wrapper, router } = await mountAt(
      NewReservationView,
      '/reservations/new?date=2027-07-05',
    );
    await slotButtons(wrapper)[1]!.trigger('click');
    await fillNewCustomer(wrapper);
    const book = wrapper.findAll('button').find((b) => b.text() === 'Reservar')!;
    expect(book.attributes('disabled')).toBeUndefined();
    await book.trigger('click');
    await flushPromises();
    const [body, key] = apiMock.createReservation.mock.calls[0]!;
    expect(body).toEqual({
      serviceId: SVC,
      locationId: LOC,
      resourceId: null, // asignación automática
      startAt: '2027-07-05T14:00:00.000Z',
      customer: { firstName: 'Lucía', phoneE164: '+56944444444' },
      customerNotes: null,
      internalNotes: null,
    });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(router.currentRoute.value.fullPath).toBe(`/reservations/${RES}`);
  });

  it('un reintento tras un fallo de red REUTILIZA la Idempotency-Key; otros datos, clave nueva', async () => {
    apiMock.createReservation.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'x'));
    apiMock.createReservation.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'x'));
    apiMock.createReservation.mockResolvedValue(reservation());
    const { wrapper } = await mountAt(NewReservationView, '/reservations/new?date=2027-07-05');
    await slotButtons(wrapper)[0]!.trigger('click');
    await fillNewCustomer(wrapper);
    const book = () => wrapper.findAll('button').find((b) => b.text() === 'Reservar')!;
    await book().trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('No hay conexión');
    await book().trigger('click');
    await flushPromises();
    const keys = apiMock.createReservation.mock.calls.map((c) => c[1]);
    expect(keys[1]).toBe(keys[0]);
    // cambia el horario: es otra operación => otra clave
    await slotButtons(wrapper)[1]!.trigger('click');
    await book().trigger('click');
    await flushPromises();
    expect(apiMock.createReservation.mock.calls[2]![1]).not.toBe(keys[0]);
  });

  it('si el horario se ocupó entre medio (409), avisa y recarga los horarios', async () => {
    apiMock.createReservation.mockRejectedValue(
      new ApiError(409, 'SLOT_UNAVAILABLE', 'Ese horario ya no está disponible.'),
    );
    const { wrapper } = await mountAt(NewReservationView, '/reservations/new?date=2027-07-05');
    await slotButtons(wrapper)[0]!.trigger('click');
    await fillNewCustomer(wrapper);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Reservar')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Ese horario acaba de ocuparse');
    expect(apiMock.getAvailability).toHaveBeenCalledTimes(2);
  });

  it('busca y elige un cliente existente', async () => {
    vi.useFakeTimers();
    apiMock.listCustomers.mockResolvedValue(
      page([
        {
          id: CUS,
          firstName: 'Carla',
          lastName: 'Pérez',
          phoneE164: '+56911111111',
          email: null,
          internalNotes: null,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ]),
    );
    apiMock.createReservation.mockResolvedValue(reservation());
    const { wrapper } = await mountAt(NewReservationView, '/reservations/new?date=2027-07-05');
    await slotButtons(wrapper)[0]!.trigger('click');
    await wrapper.find('#r-search').setValue('car');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(apiMock.listCustomers).toHaveBeenCalledWith({ q: 'car', limit: 8 });
    await wrapper.findAll('.result-list button')[0]!.trigger('click');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Reservar')!
      .trigger('click');
    await flushPromises();
    expect(apiMock.createReservation.mock.calls[0]![0].customer).toEqual({ id: CUS });
    vi.useRealTimers();
  });
});

describe('ReservationDetailView', () => {
  it('muestra la reserva en hora de la sucursal y solo las acciones válidas', async () => {
    apiMock.getReservation.mockResolvedValue(reservation());
    apiMock.listReservationEvents.mockResolvedValue([
      {
        id: U(9),
        type: 'created',
        actorType: 'user',
        actorId: null,
        payload: {},
        occurredAt: '2027-07-01T12:00:00.000Z',
      },
    ]);
    const { wrapper } = await mountAt(ReservationDetailView, `/reservations/${RES}`);
    expect(wrapper.text()).toContain('RP-ABC234');
    expect(wrapper.text()).toContain('lun 05/07/2027 09:00');
    expect(wrapper.text()).toContain('$15.000 CLP');
    expect(wrapper.text()).toContain('Ana');
    expect(wrapper.text()).toContain('Creada');
    const labels = wrapper.findAll('.card .actions button').map((b) => b.text());
    expect(labels).toEqual([
      'Reprogramar',
      'Marcar en curso',
      'Marcar completada',
      'Cancelar reserva',
    ]);
  });

  it('cancelar envía la versión y el motivo', async () => {
    apiMock.getReservation.mockResolvedValue(reservation());
    apiMock.cancelReservation.mockResolvedValue(
      reservation({ status: 'cancelled', version: 2, cancelledAt: '2027-07-02T00:00:00.000Z' }),
    );
    const { wrapper } = await mountAt(ReservationDetailView, `/reservations/${RES}`);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancelar reserva')!
      .trigger('click');
    const reasonLabel = wrapper.findAll('label').find((l) => l.text() === 'Motivo (opcional)')!;
    await wrapper.find(`#${reasonLabel.attributes('for')}`).setValue('Enfermo');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(apiMock.cancelReservation).toHaveBeenCalledWith(RES, { version: 1, reason: 'Enfermo' });
    expect(wrapper.text()).toContain('Cancelada');
    expect(wrapper.text()).toContain('El horario quedó libre');
    expect(wrapper.findAll('.card .actions button')).toHaveLength(0); // terminal
  });

  it('si otra persona la modificó (VERSION_CONFLICT), recarga y avisa', async () => {
    apiMock.getReservation
      .mockResolvedValueOnce(reservation())
      .mockResolvedValueOnce(reservation({ status: 'in_progress', version: 2 }));
    apiMock.changeReservationStatus.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'x'));
    const { wrapper } = await mountAt(ReservationDetailView, `/reservations/${RES}`);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Marcar completada')!
      .trigger('click');
    await flushPromises();
    expect(apiMock.changeReservationStatus).toHaveBeenCalledWith(RES, {
      version: 1,
      status: 'completed',
    });
    expect(apiMock.getReservation).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('Otra persona modificó esta reserva');
    expect(wrapper.text()).toContain('En curso');
  });

  it('reprogramar elige un horario y envía versión, inicio y recurso', async () => {
    apiMock.getReservation.mockResolvedValue(reservation());
    apiMock.rescheduleReservation.mockResolvedValue(
      reservation({ startAt: '2027-07-05T14:00:00.000Z', version: 2, rescheduleCount: 1 }),
    );
    const { wrapper } = await mountAt(ReservationDetailView, `/reservations/${RES}`);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Reprogramar')!
      .trigger('click');
    await flushPromises();
    expect(apiMock.getAvailability).toHaveBeenCalledWith({
      serviceId: SVC,
      locationId: LOC,
      from: '2027-07-05',
    });
    await wrapper.find('#sp-res').setValue(BETO);
    await slotButtons(wrapper)[1]!.trigger('click');
    await wrapper
      .findAll('button')
      .find((b) => b.text().startsWith('Mover a'))!
      .trigger('click');
    await flushPromises();
    expect(apiMock.rescheduleReservation).toHaveBeenCalledWith(RES, {
      version: 1,
      startAt: '2027-07-05T14:00:00.000Z',
      resourceId: BETO,
    });
    expect(wrapper.text()).toContain('Reserva reprogramada');
  });

  it('un profesional solo ve las acciones de estado', async () => {
    apiMock.getReservation.mockResolvedValue(reservation());
    const { wrapper } = await mountAt(ReservationDetailView, `/reservations/${RES}`, [
      'reservations:read:own',
      'reservations:status',
      'resources:read',
    ]);
    const labels = wrapper.findAll('.card .actions button').map((b) => b.text());
    expect(labels).toEqual(['Marcar en curso', 'Marcar completada']);
  });
});

describe('ReservationsView', () => {
  it('lista las reservas del período (días de la empresa) con su estado', async () => {
    apiMock.listReservations.mockResolvedValue(page([reservation()]));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-07-05T15:00:00Z'));
    const { wrapper } = await mountAt(ReservationsView, '/reservations');
    const q = apiMock.listReservations.mock.calls[0]![0];
    // de medianoche a medianoche de la EMPRESA (Santiago, UTC-4 en julio), 7 días
    expect(q).toMatchObject({
      limit: 50,
      from: '2027-07-05T04:00:00.000Z',
      to: '2027-07-12T04:00:00.000Z',
    });
    expect(wrapper.text()).toContain('Carla Pérez');
    expect(wrapper.text()).toContain('Confirmada');
    expect(wrapper.text()).toContain('RP-ABC234');
    expect(wrapper.find('a[href="/reservations/new"]').exists()).toBe(true);
    await wrapper.find('#f-status').setValue('pending');
    await flushPromises();
    expect(apiMock.listReservations.mock.calls.at(-1)![0].status).toBe('pending');
  });

  it('sin permiso de crear no ofrece "Nueva reserva"; con solo :own lo indica', async () => {
    apiMock.listReservations.mockResolvedValue(page([]));
    const { wrapper } = await mountAt(ReservationsView, '/reservations', ['reservations:read:own']);
    expect(wrapper.find('a[href="/reservations/new"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Ves solo las reservas de tu agenda');
    expect(wrapper.text()).toContain('No hay reservas en este período');
  });

  it('la ruta de crear exige reservations:create', async () => {
    apiMock.listReservations.mockResolvedValue(page([]));
    const { router } = await mountAt(ReservationsView, '/reservations/new', [
      'reservations:read:own',
    ]);
    expect(router.currentRoute.value.name).toBe('forbidden');
  });
});

describe('CalendarView con reservas', () => {
  it('muestra cada reserva en su día local con enlace al detalle', async () => {
    apiMock.getCalendar.mockResolvedValue({
      from: '2027-07-05',
      to: '2027-07-11',
      resources: [
        {
          resourceId: ANA,
          name: 'Ana',
          kind: 'staff',
          locationId: LOC,
          timezone: 'America/Santiago',
          working: [],
          blocks: [],
          reservations: [
            {
              id: RES,
              code: 'RP-ABC234',
              status: 'pending',
              // martes 06/07 en UTC, pero lunes 05/07 21:30 en Santiago: va en la columna del LUNES
              start: '2027-07-06T01:30:00.000Z',
              end: '2027-07-06T02:30:00.000Z',
              customerName: 'Carla Pérez',
              serviceName: 'Corte',
            },
          ],
        },
      ],
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-07-07T15:00:00Z'));
    const { wrapper } = await mountAt(CalendarView, '/calendar');
    await flushPromises();
    const columns = wrapper.findAll('tbody tr')[0]!.findAll('td');
    expect(columns[1]!.text()).toContain('Carla Pérez'); // lunes
    expect(columns[2]!.text()).not.toContain('Carla Pérez'); // martes
    const chip = wrapper.find(`a[href="/reservations/${RES}"]`);
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('21:30–22:30');
    expect(chip.text()).toContain('Carla Pérez · Corte');
    expect(chip.classes()).toContain('pending');
  });
});

describe('CustomersView', () => {
  it('crea un cliente normalizando el teléfono', async () => {
    apiMock.listCustomers.mockResolvedValue(page([]));
    apiMock.createCustomer.mockResolvedValue({});
    const { wrapper } = await mountAt(CustomersView, '/customers');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '+ Nuevo cliente')!
      .trigger('click');
    const byLabel = (text: string) => {
      const label = wrapper.findAll('label').find((l) => l.text() === text)!;
      return wrapper.find(`#${label.attributes('for')}`);
    };
    await byLabel('Nombre').setValue('Mario');
    await byLabel('Teléfono').setValue('+56 9 5555 5555');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(apiMock.createCustomer).toHaveBeenCalledWith({
      firstName: 'Mario',
      lastName: null,
      phoneE164: '+56955555555',
      email: null,
      internalNotes: null,
    });
  });

  it('un teléfono inválido bloquea el guardado y se avisa', async () => {
    apiMock.listCustomers.mockResolvedValue(page([]));
    const { wrapper } = await mountAt(CustomersView, '/customers');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '+ Nuevo cliente')!
      .trigger('click');
    const label = wrapper.findAll('label').find((l) => l.text() === 'Nombre')!;
    await wrapper.find(`#${label.attributes('for')}`).setValue('Mario');
    const tel = wrapper.findAll('label').find((l) => l.text() === 'Teléfono')!;
    await wrapper.find(`#${tel.attributes('for')}`).setValue('12');
    expect(wrapper.text()).toContain('Teléfono no válido');
    expect(
      wrapper
        .findAll('button')
        .find((b) => b.text() === 'Guardar')!
        .attributes('disabled'),
    ).toBeDefined();
  });
});

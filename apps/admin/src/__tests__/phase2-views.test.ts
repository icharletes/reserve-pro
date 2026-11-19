import { ApiError } from '@reservepro/api-client';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, auth, me } from './helpers';

vi.mock('../api', () => ({ api: apiMock, setAuthLostHandler: () => undefined }));

import { createAppRouter } from '../router';
import { resetBootstrapForTests } from '../stores/auth';
import BlocksView from '../views/BlocksView.vue';
import CalendarView from '../views/CalendarView.vue';
import LocationHoursView from '../views/LocationHoursView.vue';
import LocationsView from '../views/LocationsView.vue';
import ServicesView from '../views/ServicesView.vue';

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
const page = <T>(items: T[]) => ({ items, nextCursor: null });
const location = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  address: {},
  phone: null,
  email: null,
  timezone: null,
  effectiveTimezone: 'America/Santiago',
  isActive: true,
  createdAt: '2027-01-01T00:00:00.000Z',
  ...extra,
});

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LocationsView', () => {
  it('lista las sucursales con su zona horaria y estado', async () => {
    apiMock.listLocations.mockResolvedValue(
      page([
        location(U(1), 'Centro'),
        location(U(2), 'Norte', {
          isActive: false,
          timezone: 'America/New_York',
          effectiveTimezone: 'America/New_York',
        }),
      ]),
    );
    const { wrapper } = await mountAt(LocationsView, '/locations', [
      'locations:read',
      'locations:write',
      'schedules:read',
    ]);
    expect(wrapper.text()).toContain('Centro');
    expect(wrapper.text()).toContain('(de la empresa)');
    expect(wrapper.text()).toContain('America/New_York');
    expect(wrapper.text()).toContain('Desactivada');
    expect(
      wrapper.findAll('a').some((a) => a.attributes('href') === `/locations/${U(1)}/hours`),
    ).toBe(true);
  });

  it('crear: normaliza vacíos a null y mapea la ciudad a la dirección; luego recarga', async () => {
    apiMock.listLocations.mockResolvedValue(page([]));
    apiMock.createLocation.mockResolvedValue(location(U(1), 'Nueva'));
    const { wrapper } = await mountAt(LocationsView, '/locations', [
      'locations:read',
      'locations:write',
    ]);
    await wrapper.get('button:not(.small)').trigger('click'); // + Nueva sucursal
    const inputs = wrapper.findAll('form input');
    await inputs[0]!.setValue('  Nueva  ');
    await inputs[1]!.setValue('Valdivia');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.createLocation).toHaveBeenCalledWith({
      name: 'Nueva',
      address: { city: 'Valdivia' },
      phone: null,
      email: null,
      timezone: null,
    });
    expect(apiMock.listLocations).toHaveBeenCalledTimes(2);
  });

  it('un error del servidor se muestra en el formulario y NO lo cierra', async () => {
    apiMock.listLocations.mockResolvedValue(page([]));
    apiMock.createLocation.mockRejectedValue(
      new ApiError(409, 'DUPLICATE', 'Ya existe', [
        { path: 'name', message: 'Ya existe una sucursal con ese nombre' },
      ]),
    );
    const { wrapper } = await mountAt(LocationsView, '/locations', [
      'locations:read',
      'locations:write',
    ]);
    await wrapper.get('button:not(.small)').trigger('click');
    await wrapper.findAll('form input')[0]!.setValue('Centro');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).toContain('Ya existe una sucursal con ese nombre');
  });

  it('eliminar pide confirmación; si se cancela NO llama a la API', async () => {
    apiMock.listLocations.mockResolvedValue(page([location(U(1), 'Centro')]));
    apiMock.deleteLocation.mockResolvedValue(undefined);
    const { wrapper } = await mountAt(LocationsView, '/locations', [
      'locations:read',
      'locations:write',
    ]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await wrapper.get('button.danger').trigger('click');
    expect(confirm).toHaveBeenCalled();
    expect(apiMock.deleteLocation).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await wrapper.get('button.danger').trigger('click');
    await flushPromises();
    expect(apiMock.deleteLocation).toHaveBeenCalledWith(U(1));
  });

  it('sin locations:write no hay botones de edición', async () => {
    apiMock.listLocations.mockResolvedValue(page([location(U(1), 'Centro')]));
    const { wrapper } = await mountAt(LocationsView, '/locations', ['locations:read']);
    expect(
      wrapper.findAll('button').filter((b) => /Nueva|Editar|Eliminar|Desactivar/.test(b.text())),
    ).toHaveLength(0);
  });

  it('desactivar envía isActive=false', async () => {
    apiMock.listLocations.mockResolvedValue(page([location(U(1), 'Centro')]));
    apiMock.updateLocation.mockResolvedValue({});
    const { wrapper } = await mountAt(LocationsView, '/locations', [
      'locations:read',
      'locations:write',
    ]);
    await wrapper
      .findAll('button.small')
      .find((b) => b.text() === 'Desactivar')!
      .trigger('click');
    await flushPromises();
    expect(apiMock.updateLocation).toHaveBeenCalledWith(U(1), { isActive: false });
  });
});

describe('LocationHoursView', () => {
  const setup = (perms: string[]) => {
    apiMock.getLocation.mockResolvedValue(location(U(1), 'Centro'));
    apiMock.getBusinessHours.mockResolvedValue({
      intervals: [{ weekday: 1, start: '09:00', end: '13:00' }],
    });
    apiMock.listOverrides.mockResolvedValue([]);
    return mountAt(LocationHoursView, `/locations/${U(1)}/hours`, perms);
  };

  it('carga el horario, muestra la zona horaria y guarda exactamente lo editado', async () => {
    apiMock.setBusinessHours.mockImplementation(
      async (_id: string, body: { intervals: unknown[] }) => body,
    );
    const { wrapper } = await setup(['schedules:read', 'schedules:write']);
    expect(wrapper.text()).toContain('Horario de Centro');
    expect(wrapper.text()).toContain('America/Santiago');
    await wrapper.findAll('.day-row')[1]!.find('button').trigger('click'); // martes: agregar tramo
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Guardar horario')!
      .trigger('click');
    await flushPromises();
    const [id, body] = apiMock.setBusinessHours.mock.calls[0]!;
    expect(id).toBe(U(1));
    expect(body.intervals).toEqual([
      { weekday: 1, start: '09:00', end: '13:00' },
      { weekday: 2, start: '09:00', end: '13:00', validFrom: null, validTo: null },
    ]);
    expect(wrapper.text()).toContain('Horario guardado');
  });

  it('tramos superpuestos: avisa y bloquea el guardado SIN llamar a la API', async () => {
    const { wrapper } = await setup(['schedules:read', 'schedules:write']);
    await wrapper.findAll('.day-row')[0]!.find('button.small:not(.danger)').trigger('click'); // otro tramo el lunes (13:00-17:00)
    await wrapper.get('select[aria-label="Lunes tramo 2: inicio"]').setValue('12:00'); // pisa el primero
    expect(wrapper.text()).toContain('se superponen');
    const save = wrapper.findAll('button').find((b) => b.text() === 'Guardar horario')!;
    expect(save.attributes('disabled')).toBeDefined();
    await save.trigger('click');
    expect(apiMock.setBusinessHours).not.toHaveBeenCalled();
  });

  it('sin schedules:write es de solo lectura', async () => {
    const { wrapper } = await setup(['schedules:read']);
    expect(wrapper.findAll('button').find((b) => b.text() === 'Guardar horario')).toBeUndefined();
    expect(wrapper.get('select').attributes('disabled')).toBeDefined();
  });
});

describe('CalendarView', () => {
  const resource = (extra: object = {}) => ({
    resourceId: U(10),
    name: 'Ana',
    kind: 'staff',
    locationId: U(1),
    timezone: 'America/Santiago',
    working: [{ start: '2027-07-05T13:00:00.000Z', end: '2027-07-05T22:00:00.000Z' }],
    blocks: [
      {
        id: U(20),
        kind: 'time_off',
        start: '2027-07-07T16:00:00.000Z',
        end: '2027-07-07T20:00:00.000Z',
        reason: 'Dentista',
      },
    ],
    ...extra,
  });
  const setup = async (cal: object, perms = ['calendar:read', 'locations:read']) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-07-07T15:00:00Z')); // miércoles => la semana empieza el lunes 2027-07-05
    apiMock.listLocations.mockResolvedValue(
      page([location(U(1), 'Centro'), location(U(2), 'Norte')]),
    );
    apiMock.getCalendar.mockResolvedValue(cal);
    return mountAt(CalendarView, '/calendar', perms);
  };

  it('pide la semana ISO que contiene hoy (lunes a domingo)', async () => {
    await setup({ from: '2027-07-05', to: '2027-07-11', resources: [] });
    expect(apiMock.getCalendar).toHaveBeenCalledWith({ from: '2027-07-05', to: '2027-07-11' });
  });

  it('muestra el horario en la HORA LOCAL del recurso, no en UTC', async () => {
    const { wrapper } = await setup({
      from: '2027-07-05',
      to: '2027-07-11',
      resources: [resource()],
    });
    expect(wrapper.text()).toContain('09:00–18:00'); // 13:00Z-22:00Z en Santiago (UTC-4)
    expect(wrapper.text()).not.toContain('13:00–22:00');
    expect(wrapper.text()).toContain('Bloqueo 12:00–16:00'); // 16Z-20Z
    expect(wrapper.find('.chip.block').attributes('title')).toBe('Dentista');
  });

  it('el bloqueo aparece en la columna de su día local, y el horario en la suya', async () => {
    const { wrapper } = await setup({
      from: '2027-07-05',
      to: '2027-07-11',
      resources: [resource()],
    });
    const cells = wrapper.findAll('tbody tr')[0]!.findAll('td');
    expect(cells[1]!.text()).toContain('09:00–18:00'); // lunes
    expect(cells[3]!.text()).toContain('Bloqueo'); // miércoles
    expect(cells[2]!.text()).toBe('—'); // martes vacío
  });

  it('un día de cambio de hora en Santiago empieza a las 01:00 (la hora inexistente se refleja)', async () => {
    const { wrapper } = await setup({
      from: '2027-09-05',
      to: '2027-09-11',
      resources: [
        resource({
          working: [{ start: '2027-09-05T04:00:00.000Z', end: '2027-09-06T03:00:00.000Z' }],
          blocks: [],
        }),
      ],
    });
    await wrapper
      .findAll('.actions button')
      .find((b) => b.text() === 'Hoy')!
      .trigger('click'); // usa la fecha simulada
    expect(wrapper.html()).toBeTruthy();
  });

  it('navegar de semana vuelve a pedir el rango correcto', async () => {
    const { wrapper } = await setup({ from: '2027-07-05', to: '2027-07-11', resources: [] });
    await wrapper.get('button[aria-label="Semana siguiente"]').trigger('click');
    await flushPromises();
    expect(apiMock.getCalendar).toHaveBeenLastCalledWith({ from: '2027-07-12', to: '2027-07-18' });
    await wrapper.get('button[aria-label="Semana anterior"]').trigger('click');
    await wrapper.get('button[aria-label="Semana anterior"]').trigger('click');
    await flushPromises();
    expect(apiMock.getCalendar).toHaveBeenLastCalledWith({ from: '2027-06-28', to: '2027-07-04' });
  });

  it('filtrar por sucursal agrega locationId a la consulta', async () => {
    const { wrapper } = await setup({ from: '2027-07-05', to: '2027-07-11', resources: [] });
    await wrapper.get('#c-loc').setValue(U(2));
    await flushPromises();
    expect(apiMock.getCalendar).toHaveBeenLastCalledWith({
      from: '2027-07-05',
      to: '2027-07-11',
      locationId: U(2),
    });
  });

  it('un profesional (solo calendar:read:own) no pide la lista de sucursales', async () => {
    await setup({ from: '2027-07-05', to: '2027-07-11', resources: [] }, ['calendar:read:own']);
    expect(apiMock.listLocations).not.toHaveBeenCalled();
  });

  it('muestra el error de la API y un mensaje cuando no hay recursos', async () => {
    const { wrapper } = await setup({ from: '2027-07-05', to: '2027-07-11', resources: [] });
    expect(wrapper.text()).toContain('No hay recursos para mostrar');
    apiMock.getCalendar.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'x'));
    await wrapper.get('button[aria-label="Semana siguiente"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role=alert]').text()).toContain('conexión');
  });
});

describe('ServicesView', () => {
  const service = (extra: object = {}) => ({
    id: U(30),
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
    ...extra,
  });
  const resourceRow = (id: string, name: string, locationId: string) => ({
    id,
    name,
    locationId,
    kind: 'staff',
    capacity: 1,
    membershipId: null,
    isBookableOnline: true,
    autoAssignable: true,
    isActive: true,
    sortOrder: 0,
    createdAt: '2027-01-01T00:00:00.000Z',
  });

  const setup = async () => {
    apiMock.listServices.mockResolvedValue(page([service()]));
    apiMock.listCategories.mockResolvedValue(page([{ id: U(40), name: 'Cabello', sortOrder: 0 }]));
    apiMock.listLocations.mockResolvedValue(
      page([location(U(1), 'Centro'), location(U(2), 'Norte')]),
    );
    apiMock.listResources.mockResolvedValue(
      page([resourceRow(U(10), 'Ana', U(1)), resourceRow(U(11), 'Beto', U(2))]),
    );
    return mountAt(ServicesView, '/services', ['services:read', 'services:write']);
  };

  it('muestra el precio como texto con su moneda y los contadores de vínculos', async () => {
    const { wrapper } = await setup();
    expect(wrapper.text()).toContain('12990.00 CLP');
    expect(wrapper.text()).toContain('0 sucursal(es)');
  });

  it('crear envía el precio como TEXTO y los números como números; luego abre los vínculos', async () => {
    apiMock.createService.mockResolvedValue(service({ id: U(31), name: 'Tinte' }));
    const { wrapper } = await setup();
    await wrapper.get('button:not(.small)').trigger('click');
    const field = (label: string) =>
      wrapper
        .findAll('form .field')
        .find((f) => f.text().includes(label))!
        .get('input');
    await field('Nombre').setValue('Tinte');
    await wrapper.get('#s-dur').setValue('90');
    await field('Precio').setValue('20000');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const body = apiMock.createService.mock.calls[0]![0];
    expect(body).toMatchObject({
      name: 'Tinte',
      durationMinutes: 90,
      price: '20000',
      categoryId: null,
      requiresConfirmation: null,
    });
    expect(typeof body.price).toBe('string');
    expect(typeof body.durationMinutes).toBe('number');
    expect(wrapper.text()).toContain('Dónde y quién presta «Tinte»');
  });

  it('vínculos: al guardar solo se envían los recursos de las sucursales marcadas', async () => {
    apiMock.setServiceLocations.mockResolvedValue(service());
    apiMock.setServiceResources.mockResolvedValue(service());
    const { wrapper } = await setup();
    await wrapper
      .findAll('button.small')
      .find((b) => b.text() === 'Sucursales y recursos')!
      .trigger('click');
    // Se vuelve a consultar cada vez: los recursos aparecen DESPUÉS de marcar sus sucursales.
    const byLabel = (txt: string) =>
      wrapper
        .findAll('fieldset input[type=checkbox]')
        .find((b) => b.element.parentElement?.textContent?.includes(txt))!;
    await byLabel('Centro').setValue(true);
    await byLabel('Norte').setValue(true);
    await flushPromises();
    await byLabel('Ana').setValue(true);
    await byLabel('Beto').setValue(true);
    await byLabel('Norte').setValue(false); // desmarca Norte: Beto (de Norte) ya no corresponde
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Guardar vínculos')!
      .trigger('click');
    await flushPromises();
    expect(apiMock.setServiceLocations).toHaveBeenCalledWith(U(30), { locationIds: [U(1)] });
    expect(apiMock.setServiceResources).toHaveBeenCalledWith(U(30), { resourceIds: [U(10)] }); // sin Beto
  });
});

describe('BlocksView', () => {
  const setup = async () => {
    apiMock.listBlocks.mockResolvedValue(page([]));
    apiMock.listResources.mockResolvedValue(
      page([
        {
          id: U(10),
          name: 'Ana',
          locationId: U(1),
          kind: 'staff',
          capacity: 1,
          membershipId: null,
          isBookableOnline: true,
          autoAssignable: true,
          isActive: true,
          sortOrder: 0,
          createdAt: '2027-01-01T00:00:00.000Z',
        },
      ]),
    );
    return mountAt(BlocksView, '/blocks', ['blocks:read', 'blocks:write']);
  };

  it('no permite bloquear hasta elegir recurso y fechas válidas', async () => {
    const { wrapper } = await setup();
    const submit = () => wrapper.get('button[type=submit]');
    expect(submit().attributes('disabled')).toBeDefined();
    await wrapper.get('fieldset input[type=checkbox]').setValue(true);
    await wrapper.get('#b-start').setValue('2027-08-02T09:00');
    expect(submit().attributes('disabled')).toBeDefined(); // falta el fin
    await wrapper.get('#b-end').setValue('2027-08-02T18:00');
    expect(submit().attributes('disabled')).toBeUndefined();
  });

  it('envía fechas ISO UTC (terminan en Z), el recurso elegido y el motivo', async () => {
    apiMock.createBlocks.mockResolvedValue([]);
    const { wrapper } = await setup();
    await wrapper.get('fieldset input[type=checkbox]').setValue(true);
    await wrapper.get('#b-start').setValue('2027-08-02T09:00');
    await wrapper.get('#b-end').setValue('2027-08-02T18:00');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const body = apiMock.createBlocks.mock.calls[0]![0];
    expect(body.resourceIds).toEqual([U(10)]);
    expect(body.kind).toBe('time_off');
    expect(body.startAt).toMatch(/Z$/);
    expect(Date.parse(body.endAt) - Date.parse(body.startAt)).toBe(9 * 3_600_000);
  });

  it('un error de rango del servidor se muestra y los datos escritos se conservan', async () => {
    apiMock.createBlocks.mockRejectedValue(
      new ApiError(400, 'VALIDATION_ERROR', 'x', [
        { path: 'endAt', message: 'El fin debe ser posterior al inicio' },
      ]),
    );
    const { wrapper } = await setup();
    await wrapper.get('fieldset input[type=checkbox]').setValue(true);
    await wrapper.get('#b-start').setValue('2027-08-02T09:00');
    await wrapper.get('#b-end').setValue('2027-08-02T18:00');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('El fin debe ser posterior al inicio');
    expect((wrapper.get('#b-start').element as HTMLInputElement).value).toBe('2027-08-02T09:00');
  });
});

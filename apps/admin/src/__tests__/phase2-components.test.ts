import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, auth, me } from './helpers';

vi.mock('../api', () => ({ api: apiMock, setAuthLostHandler: () => undefined }));

import OverridesPanel from '../components/OverridesPanel.vue';
import WeeklyEditor from '../components/WeeklyEditor.vue';
import { createAppRouter } from '../router';
import { resetBootstrapForTests } from '../stores/auth';

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
});

const iv = (
  weekday: number,
  start: string,
  end: string,
  validFrom: string | null = null,
  validTo: string | null = null,
) => ({ weekday, start, end, validFrom, validTo });

describe('WeeklyEditor', () => {
  it('muestra los 7 días y "Cerrado" donde no hay tramos', () => {
    const w = mount(WeeklyEditor, { props: { modelValue: [iv(1, '09:00', '18:00')] } });
    expect(w.findAll('.day-row')).toHaveLength(7);
    expect(w.findAll('.day-row').filter((r) => r.text().includes('Cerrado'))).toHaveLength(6);
    expect(
      (w.get('select[aria-label="Lunes tramo 1: inicio"]').element as HTMLSelectElement).value,
    ).toBe('09:00');
    expect(
      (w.get('select[aria-label="Lunes tramo 1: fin"]').element as HTMLSelectElement).value,
    ).toBe('18:00');
  });

  it('agregar un tramo emite uno nuevo que parte donde termina el anterior (no nace solapado)', async () => {
    const w = mount(WeeklyEditor, { props: { modelValue: [iv(1, '09:00', '13:00')] } });
    await w.findAll('.day-row')[0]!.find('button.small:not(.danger)').trigger('click');
    const next = (w.emitted('update:modelValue')![0] as unknown[][])[0] as ReturnType<typeof iv>[];
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ weekday: 1, start: '13:00', end: '17:00' });
  });

  it('en un día vacío el primer tramo es 09:00–13:00', async () => {
    const w = mount(WeeklyEditor, { props: { modelValue: [] } });
    await w.findAll('.day-row')[2]!.find('button').trigger('click'); // miércoles
    const next = (w.emitted('update:modelValue')![0] as unknown[][])[0] as ReturnType<typeof iv>[];
    expect(next[0]).toMatchObject({ weekday: 3, start: '09:00', end: '13:00' });
  });

  it('editar la hora y quitar un tramo emiten el arreglo actualizado sin mutar el original', async () => {
    const original = [iv(1, '09:00', '13:00'), iv(1, '14:00', '18:00')];
    const w = mount(WeeklyEditor, { props: { modelValue: original } });
    const sel = w.get('select[aria-label="Lunes tramo 1: fin"]');
    await sel.setValue('12:30');
    expect(
      ((w.emitted('update:modelValue')![0] as unknown[][])[0] as ReturnType<typeof iv>[])[0]!.end,
    ).toBe('12:30');
    await w.get('button[aria-label="Quitar Lunes tramo 2"]').trigger('click');
    expect(
      (w.emitted('update:modelValue')!.at(-1) as unknown[][])[0] as ReturnType<typeof iv>[],
    ).toHaveLength(1);
    expect(original).toHaveLength(2);
    expect(original[0]!.end).toBe('13:00');
  });

  it('solo lectura: sin botones ni selects editables', () => {
    const w = mount(WeeklyEditor, {
      props: { modelValue: [iv(1, '09:00', '18:00')], readonly: true },
    });
    expect(w.findAll('button')).toHaveLength(0);
    expect(w.get('select').attributes('disabled')).toBeDefined();
  });

  it('con vigencia muestra las fechas y las emite como null cuando se vacían', async () => {
    const w = mount(WeeklyEditor, {
      props: { modelValue: [iv(1, '09:00', '18:00', '2027-01-01', null)], withValidity: true },
    });
    const from = w.get('input[aria-label="Lunes tramo 1: vigente desde"]');
    expect((from.element as HTMLInputElement).value).toBe('2027-01-01');
    await from.setValue('');
    expect(
      ((w.emitted('update:modelValue')![0] as unknown[][])[0] as ReturnType<typeof iv>[])[0]!
        .validFrom,
    ).toBeNull();
  });
  it('sin vigencia no muestra campos de fecha', () => {
    expect(
      mount(WeeklyEditor, { props: { modelValue: [iv(1, '09:00', '18:00')] } }).findAll(
        'input[type=date]',
      ),
    ).toHaveLength(0);
  });
});

describe('OverridesPanel', () => {
  const mountPanel = (canWrite = true) =>
    mount(OverridesPanel, {
      props: { scope: 'locations', id: 'loc-1', canWrite, timezone: 'America/Santiago' },
    });

  it('lista las excepciones próximas (cerradas y con horario especial)', async () => {
    apiMock.listOverrides.mockResolvedValue([
      {
        date: '2027-12-24',
        closed: false,
        intervals: [
          { start: '09:00', end: '13:00' },
          { start: '15:00', end: '18:00' },
        ],
        reason: 'Nochebuena',
      },
      { date: '2027-12-25', closed: true, intervals: [], reason: null },
    ]);
    const w = mountPanel();
    await flushPromises();
    expect(w.text()).toContain('09:00–13:00 y 15:00–18:00');
    expect(w.text()).toContain('Nochebuena');
    expect(w.text()).toContain('Cerrado');
    const [scope, id, range] = apiMock.listOverrides.mock.calls[0]!;
    expect([scope, id]).toEqual(['locations', 'loc-1']);
    expect(range.to > range.from).toBe(true);
  });

  it('cerrar un día llama a la API con la fecha y recarga', async () => {
    apiMock.listOverrides.mockResolvedValue([]);
    apiMock.putOverride.mockResolvedValue({});
    const w = mountPanel();
    await flushPromises();
    await w.get('#ov-date').setValue('2027-12-25');
    await w.get('#ov-mode').setValue('closed');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.putOverride).toHaveBeenCalledWith('locations', 'loc-1', '2027-12-25', {
      closed: true,
      intervals: [],
      reason: null,
    });
    expect(apiMock.listOverrides).toHaveBeenCalledTimes(2);
  });

  it('horario especial envía el tramo; un fin anterior al inicio o una fecha vacía deshabilita guardar', async () => {
    apiMock.listOverrides.mockResolvedValue([]);
    apiMock.putOverride.mockResolvedValue({});
    const w = mountPanel();
    await flushPromises();
    const save = () => w.get('button[type=submit]');
    expect(save().attributes('disabled')).toBeDefined(); // sin fecha
    await w.get('#ov-date').setValue('2027-12-24');
    await w.get('#ov-mode').setValue('special');
    await w.get('#ov-start').setValue('15:00');
    await w.get('#ov-end').setValue('10:00');
    expect(save().attributes('disabled')).toBeDefined(); // fin antes del inicio
    await w.get('#ov-end').setValue('18:00');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(apiMock.putOverride).toHaveBeenCalledWith('locations', 'loc-1', '2027-12-24', {
      closed: false,
      intervals: [{ start: '15:00', end: '18:00' }],
      reason: null,
    });
  });

  it('sin permiso de escritura no hay formulario ni botones de quitar', async () => {
    apiMock.listOverrides.mockResolvedValue([
      { date: '2027-12-25', closed: true, intervals: [], reason: null },
    ]);
    const w = mountPanel(false);
    await flushPromises();
    expect(w.find('form').exists()).toBe(false);
    expect(w.findAll('button')).toHaveLength(0);
  });

  it('quitar una excepción la elimina y recarga; un error de la API se muestra', async () => {
    apiMock.listOverrides.mockResolvedValue([
      { date: '2027-12-25', closed: true, intervals: [], reason: null },
    ]);
    apiMock.deleteOverride.mockResolvedValue(undefined);
    const w = mountPanel();
    await flushPromises();
    await w.get('button.danger').trigger('click');
    await flushPromises();
    expect(apiMock.deleteOverride).toHaveBeenCalledWith('locations', 'loc-1', '2027-12-25');
    apiMock.deleteOverride.mockRejectedValueOnce(Object.assign(new Error('x'), {}));
    await w.get('button.danger').trigger('click');
    await flushPromises();
    expect(w.find('[role=alert]').exists()).toBe(true);
  });
});

describe('guards de las rutas nuevas', () => {
  async function go(path: string, permissions: string[]) {
    setActivePinia(createPinia());
    resetBootstrapForTests();
    apiMock.restoreSession.mockResolvedValue(auth());
    apiMock.me.mockResolvedValue(me(permissions));
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    return router.currentRoute.value.name;
  }
  afterEach(() => vi.restoreAllMocks());

  it('cada pantalla exige su permiso', async () => {
    const cases: [string, string, string][] = [
      ['/locations', 'locations:read', 'locations'],
      ['/services', 'services:read', 'services'],
      ['/resources', 'resources:read', 'resources'],
      ['/blocks', 'blocks:read', 'blocks'],
      ['/holidays', 'schedules:read', 'holidays'],
      ['/locations/abc/hours', 'schedules:read', 'location-hours'],
      ['/resources/abc/schedule', 'schedules:read', 'resource-schedule'],
    ];
    for (const [path, perm, name] of cases) {
      expect(await go(path, [perm]), `${path} con permiso`).toBe(name);
      expect(await go(path, ['tenant:read']), `${path} sin permiso`).toBe('forbidden');
    }
  });

  it('el calendario se abre con calendar:read O calendar:read:own, y con ninguno no', async () => {
    expect(await go('/calendar', ['calendar:read'])).toBe('calendar');
    expect(await go('/calendar', ['calendar:read:own'])).toBe('calendar');
    expect(await go('/calendar', ['tenant:read'])).toBe('forbidden');
  });
});

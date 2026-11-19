<script setup lang="ts">
import type { OverrideView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { useAsyncAction } from '../composables/use-async-action';
import { addDays, clockOptions, isValidDate, toMinutes, todayIn } from '../lib/schedule-format';
import AlertBox from './AlertBox.vue';
import FormField from './FormField.vue';

const props = defineProps<{
  scope: 'locations' | 'resources';
  id: string;
  canWrite: boolean;
  /** Zona horaria con la que se calcula "hoy" (la de la sucursal). */
  timezone?: string;
}>();

const items = ref<OverrideView[]>([]);
const loadError = ref<string | null>(null);
const date = ref('');
const mode = ref<'closed' | 'special'>('closed');
const start = ref('10:00');
const end = ref('14:00');
const reason = ref('');
const { loading, error, fieldErrors, run } = useAsyncAction();
const times = clockOptions(30);

const today = () => todayIn(props.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

async function load() {
  try {
    const from = today();
    items.value = await api.listOverrides(props.scope, props.id, { from, to: addDays(from, 365) });
  } catch {
    loadError.value = 'No se pudieron cargar las excepciones.';
  }
}
onMounted(load);

const invalid = () =>
  !isValidDate(date.value) ||
  (mode.value === 'special' && toMinutes(end.value) <= toMinutes(start.value));

async function save() {
  if (invalid()) return;
  const body =
    mode.value === 'closed'
      ? { closed: true, intervals: [], reason: reason.value.trim() || null }
      : {
          closed: false,
          intervals: [{ start: start.value, end: end.value }],
          reason: reason.value.trim() || null,
        };
  const res = await run(() => api.putOverride(props.scope, props.id, date.value, body));
  if (res) {
    date.value = '';
    reason.value = '';
    await load();
  }
}

async function remove(d: string) {
  await run(() => api.deleteOverride(props.scope, props.id, d));
  await load();
}
</script>

<template>
  <section aria-labelledby="excepciones">
    <h2 id="excepciones">Excepciones por fecha</h2>
    <p class="muted">
      Días en que el horario normal no aplica: cerrar un día, o abrir con un horario especial.
    </p>
    <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
    <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>

    <form v-if="canWrite" class="card" novalidate @submit.prevent="save">
      <div class="row">
        <div class="field">
          <label for="ov-date">Fecha</label>
          <input
            id="ov-date"
            v-model="date"
            type="date"
            :aria-invalid="fieldErrors['date'] ? 'true' : undefined"
          />
        </div>
        <div class="field">
          <label for="ov-mode">Qué pasa ese día</label>
          <select id="ov-mode" v-model="mode">
            <option value="closed">Cerrado</option>
            <option value="special">Horario especial</option>
          </select>
        </div>
        <template v-if="mode === 'special'">
          <div class="field">
            <label for="ov-start">Desde</label>
            <select id="ov-start" v-model="start">
              <option v-for="t in times.slice(0, -1)" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="field">
            <label for="ov-end">Hasta</label>
            <select id="ov-end" v-model="end">
              <option v-for="t in times.slice(1)" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
        </template>
        <div style="flex: 1; min-width: 180px">
          <FormField v-model="reason" label="Motivo (opcional)" />
        </div>
        <div class="field">
          <button class="primary" type="submit" :disabled="loading || invalid()">Guardar</button>
        </div>
      </div>
    </form>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Horario</th>
            <th>Motivo</th>
            <th v-if="canWrite"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in items" :key="o.date">
            <td>{{ o.date }}</td>
            <td>
              {{ o.closed ? 'Cerrado' : o.intervals.map((i) => `${i.start}–${i.end}`).join(' y ') }}
            </td>
            <td>{{ o.reason ?? '—' }}</td>
            <td v-if="canWrite">
              <button
                type="button"
                class="small danger"
                :disabled="loading"
                @click="remove(o.date)"
              >
                Quitar
              </button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td colspan="4" class="muted">Sin excepciones próximas.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

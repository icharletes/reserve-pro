<script setup lang="ts">
import type { HolidayView } from '@reservepro/contracts';
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { isValidDate } from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const year = ref(new Date().getFullYear());
const items = ref<HolidayView[]>([]);
const date = ref('');
const name = ref('');
const loadError = ref<string | null>(null);
const { loading, error, run } = useAsyncAction();

async function load() {
  loadError.value = null;
  try {
    items.value = await api.listHolidays(year.value);
  } catch {
    loadError.value = 'No se pudieron cargar los feriados.';
  }
}
onMounted(load);
watch(year, load);

async function add() {
  if (!isValidDate(date.value) || !name.value.trim()) return;
  const ok = await run(async () => {
    await api.putHoliday(date.value, { name: name.value.trim() });
    return true;
  });
  if (ok) {
    if (Number(date.value.slice(0, 4)) !== year.value) year.value = Number(date.value.slice(0, 4));
    else await load();
    date.value = '';
    name.value = '';
  }
}

async function remove(h: HolidayView) {
  await run(() => api.deleteHoliday(h.date));
  await load();
}
</script>

<template>
  <h1>Feriados</h1>
  <p class="muted">
    Un feriado cierra todas las sucursales ese día, salvo que una sucursal tenga una excepción
    propia para esa fecha.
  </p>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>

  <div class="field" style="max-width: 160px">
    <label for="anio">Año</label>
    <select id="anio" v-model.number="year">
      <option v-for="y in [year - 1, year, year + 1, year + 2]" :key="y" :value="y">{{ y }}</option>
    </select>
  </div>

  <form v-if="auth.can('schedules:write')" class="card" novalidate @submit.prevent="add">
    <div class="row">
      <div class="field">
        <label for="h-fecha">Fecha</label><input id="h-fecha" v-model="date" type="date" />
      </div>
      <div style="flex: 1; min-width: 200px"><FormField v-model="name" label="Nombre" /></div>
      <div class="field">
        <button
          class="primary"
          type="submit"
          :disabled="loading || !isValidDate(date) || !name.trim()"
        >
          Agregar
        </button>
      </div>
    </div>
  </form>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Nombre</th>
          <th v-if="auth.can('schedules:write')"><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="h in items" :key="h.date">
          <td>{{ h.date }}</td>
          <td>{{ h.name }}</td>
          <td v-if="auth.can('schedules:write')">
            <button type="button" class="small danger" :disabled="loading" @click="remove(h)">
              Quitar
            </button>
          </td>
        </tr>
        <tr v-if="items.length === 0">
          <td colspan="3" class="muted">Sin feriados en {{ year }}.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

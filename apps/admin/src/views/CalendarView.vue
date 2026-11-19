<script setup lang="ts">
import type { CalendarResponse, LocationView } from '@reservepro/contracts';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import { describeError } from '../lib/errors';
import { formatLocalTime, statusLabel } from '../lib/reservations';
import {
  addDays,
  localParts,
  mondayOf,
  todayIn,
  utcRangeToLocalSegments,
  weekDates,
} from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const monday = ref(
  mondayOf(todayIn(auth.me?.tenant?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)),
);
const locationId = ref('');
const locations = ref<LocationView[]>([]);
const data = ref<CalendarResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

const days = computed(() => weekDates(monday.value));
const WD = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const dayLabel = (date: string, i: number) => `${WD[i]} ${date.slice(8)}/${date.slice(5, 7)}`;

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await api.getCalendar({
      from: monday.value,
      to: addDays(monday.value, 6),
      ...(locationId.value ? { locationId: locationId.value } : {}),
    });
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
  }
}

type Booking = { id: string; time: string; label: string; status: string };
type Cell = {
  working: string[];
  blocks: { text: string; reason: string | null }[];
  reservations: Booking[];
};
const emptyCell = (): Cell => ({ working: [], blocks: [], reservations: [] });
const canOpen = auth.canAny('reservations:read', 'reservations:read:own');
/** Celdas por recurso y fecha LOCAL (la del recurso), no UTC. */
const grid = computed(() => {
  const out = new Map<string, Map<string, Cell>>();
  for (const r of data.value?.resources ?? []) {
    const byDate = new Map<string, Cell>(days.value.map((d) => [d, emptyCell()]));
    for (const w of r.working)
      for (const s of utcRangeToLocalSegments(w, r.timezone))
        byDate.get(s.date)?.working.push(`${s.start}–${s.end}`);
    for (const b of r.blocks)
      for (const s of utcRangeToLocalSegments(b, r.timezone))
        byDate.get(s.date)?.blocks.push({ text: `${s.start}–${s.end}`, reason: b.reason });
    // Cada reserva va en el día LOCAL en que empieza (hora del recurso).
    for (const x of r.reservations)
      byDate.get(localParts(x.start, r.timezone).date)?.reservations.push({
        id: x.id,
        time: `${formatLocalTime(x.start, r.timezone)}–${formatLocalTime(x.end, r.timezone)}`,
        label: `${x.customerName} · ${x.serviceName}`,
        status: x.status,
      });
    out.set(r.resourceId, byDate);
  }
  return out;
});
const cell = (rid: string, date: string): Cell => grid.value.get(rid)?.get(date) ?? emptyCell();

const shift = (weeks: number) => (monday.value = addDays(monday.value, weeks * 7));
const today = () =>
  (monday.value = mondayOf(todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone)));

watch([monday, locationId], load);
onMounted(async () => {
  if (auth.can('locations:read')) locations.value = (await api.listLocations({ limit: 100 })).items;
  await load();
});
</script>

<template>
  <h1>Calendario</h1>
  <p class="muted">
    Horario de trabajo, bloqueos y reservas de cada recurso, en la hora local del recurso.
  </p>
  <p v-if="auth.can('reservations:create')">
    <RouterLink class="btn btn-primary" to="/reservations/new">Nueva reserva</RouterLink>
  </p>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>

  <div class="row" style="margin-bottom: 1rem">
    <div class="actions">
      <button type="button" aria-label="Semana anterior" @click="shift(-1)">←</button>
      <button type="button" @click="today">Hoy</button>
      <button type="button" aria-label="Semana siguiente" @click="shift(1)">→</button>
    </div>
    <strong aria-live="polite">{{ days[0] }} a {{ days[6] }}</strong>
    <div v-if="locations.length > 1" class="field" style="margin: 0">
      <label for="c-loc" class="sr-only">Sucursal</label>
      <select id="c-loc" v-model="locationId">
        <option value="">Todas las sucursales</option>
        <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
      </select>
    </div>
  </div>

  <p v-if="loading" role="status">Cargando…</p>
  <div class="table-wrap">
    <table class="grid-cal">
      <thead>
        <tr>
          <th>Recurso</th>
          <th v-for="(d, i) in days" :key="d">{{ dayLabel(d, i) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in data?.resources ?? []" :key="r.resourceId">
          <td>
            {{ r.name }}<br /><span class="muted">{{ r.timezone }}</span>
          </td>
          <td v-for="d in days" :key="d">
            <span v-for="w in cell(r.resourceId, d).working" :key="w" class="chip">{{ w }}</span>
            <span
              v-for="(b, k) in cell(r.resourceId, d).blocks"
              :key="k"
              class="chip block"
              :title="b.reason ?? 'Bloqueo'"
              >Bloqueo {{ b.text }}</span
            >
            <template v-for="b in cell(r.resourceId, d).reservations" :key="b.id">
              <RouterLink
                v-if="canOpen"
                :to="`/reservations/${b.id}`"
                class="chip reservation"
                :class="b.status"
                :title="statusLabel(b.status)"
                ><strong>{{ b.time }}</strong> {{ b.label }}</RouterLink
              >
              <span v-else class="chip reservation" :class="b.status"
                ><strong>{{ b.time }}</strong> {{ b.label }}</span
              >
            </template>
            <span
              v-if="
                cell(r.resourceId, d).working.length === 0 &&
                cell(r.resourceId, d).blocks.length === 0 &&
                cell(r.resourceId, d).reservations.length === 0
              "
              class="muted"
              >—</span
            >
          </td>
        </tr>
        <tr v-if="!loading && (data?.resources.length ?? 0) === 0">
          <td colspan="8" class="muted">No hay recursos para mostrar.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

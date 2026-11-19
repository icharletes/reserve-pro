<script setup lang="ts">
import type { LocationView, ReservationStatusValue } from '@reservepro/contracts';
import { RESERVATION_STATUSES } from '@reservepro/contracts';
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import { usePagedList } from '../composables/use-paged-list';
import { customerName, formatLocalDateTime, statusLabel, zonedMidnight } from '../lib/reservations';
import { addDays, isValidDate, todayIn } from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const tenantTz = auth.me?.tenant?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

// Filtros. Las fechas son días de la EMPRESA (no del navegador).
const from = ref(todayIn(tenantTz));
const days = ref(7);
const status = ref<ReservationStatusValue | ''>('');
const locationId = ref('');
const resourceId = ref('');
const locations = ref<LocationView[]>([]);
const resourceNames = ref(new Map<string, string>());
const resources = ref<{ id: string; name: string }[]>([]);

const list = usePagedList((cursor) =>
  api.listReservations({
    limit: 50,
    ...(isValidDate(from.value)
      ? {
          from: zonedMidnight(from.value, tenantTz).toISOString(),
          to: zonedMidnight(addDays(from.value, days.value), tenantTz).toISOString(),
        }
      : {}),
    ...(status.value ? { status: status.value } : {}),
    ...(locationId.value ? { locationId: locationId.value } : {}),
    ...(resourceId.value ? { resourceId: resourceId.value } : {}),
    ...(cursor ? { cursor } : {}),
  }),
);
const resName = (id: string) => resourceNames.value.get(id) ?? '—';

watch([from, days, status, locationId, resourceId], () => list.reload());

onMounted(async () => {
  await list.reload();
  if (auth.can('locations:read'))
    locations.value = (await api.listLocations({ limit: 100 }).catch(() => ({ items: [] }))).items;
  if (auth.can('resources:read')) {
    const res = await api.listResources({ limit: 100 }).catch(() => ({ items: [] }));
    resources.value = res.items.map((r) => ({ id: r.id, name: r.name }));
    resourceNames.value = new Map(resources.value.map((r) => [r.id, r.name]));
  }
});
</script>

<template>
  <div class="row" style="justify-content: space-between; align-items: center">
    <h1>Reservas</h1>
    <RouterLink
      v-if="auth.can('reservations:create')"
      class="btn btn-primary"
      to="/reservations/new"
      >Nueva reserva</RouterLink
    >
  </div>
  <p v-if="!auth.can('reservations:read')" class="muted">Ves solo las reservas de tu agenda.</p>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>

  <div class="row" role="search">
    <div class="field">
      <label for="f-from">Desde</label>
      <input id="f-from" v-model="from" type="date" />
    </div>
    <div class="field">
      <label for="f-days">Período</label>
      <select id="f-days" v-model.number="days">
        <option :value="1">1 día</option>
        <option :value="7">7 días</option>
        <option :value="31">31 días</option>
      </select>
    </div>
    <div class="field">
      <label for="f-status">Estado</label>
      <select id="f-status" v-model="status">
        <option value="">Todos</option>
        <option v-for="s in RESERVATION_STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
      </select>
    </div>
    <div v-if="locations.length > 1" class="field">
      <label for="f-loc">Sucursal</label>
      <select id="f-loc" v-model="locationId">
        <option value="">Todas</option>
        <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
      </select>
    </div>
    <div v-if="resources.length > 1 && auth.can('reservations:read')" class="field">
      <label for="f-res">Profesional / recurso</label>
      <select id="f-res" v-model="resourceId">
        <option value="">Todos</option>
        <option v-for="r in resources" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Fecha y hora</th>
          <th>Cliente</th>
          <th>Servicio</th>
          <th>Atiende</th>
          <th>Estado</th>
          <th>Código</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in list.items.value" :key="r.id">
          <td>
            <RouterLink :to="`/reservations/${r.id}`">{{
              formatLocalDateTime(r.startAt, r.timeZone)
            }}</RouterLink>
          </td>
          <td>{{ customerName(r.customer) }}</td>
          <td>{{ r.items.map((i) => i.serviceName).join(', ') }}</td>
          <td>{{ r.resources.map((x) => resName(x.resourceId)).join(', ') }}</td>
          <td>
            <span class="status" :class="r.status">{{ statusLabel(r.status) }}</span>
          </td>
          <td>
            <code>{{ r.code }}</code>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="6" class="muted">No hay reservas en este período.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.loading.value" role="status">Cargando…</p>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>
</template>

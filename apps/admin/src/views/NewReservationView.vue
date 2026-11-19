<script setup lang="ts">
import { ApiError } from '@reservepro/api-client';
import type {
  CreateReservationRequest,
  CustomerView,
  LocationView,
  ServiceView,
} from '@reservepro/contracts';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import SlotPicker from '../components/SlotPicker.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { describeError } from '../lib/errors';
import {
  customerName,
  formatLocalDateTime,
  formatMoney,
  newIdempotencyKey,
  normalizePhone,
} from '../lib/reservations';
import { isValidDate, todayIn } from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const tenantTz = auth.me?.tenant?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const initialDate =
  typeof route.query['date'] === 'string' && isValidDate(route.query['date'])
    ? route.query['date']
    : todayIn(tenantTz);

const locations = ref<LocationView[]>([]);
const services = ref<ServiceView[]>([]);
const locationId = ref('');
const serviceId = ref('');
const slot = ref<{ startAt: string; resourceId: string | null } | null>(null);
const picker = ref<InstanceType<typeof SlotPicker> | null>(null);
const loadError = ref<string | null>(null);

// --- cliente: existente (búsqueda) o nuevo ---------------------------------------------------------
const canSearch = auth.can('customers:read');
const customerMode = ref<'existing' | 'new'>(canSearch ? 'existing' : 'new');
const search = ref('');
const results = ref<CustomerView[]>([]);
const selectedCustomer = ref<CustomerView | null>(null);
const searching = ref(false);
const newCustomer = ref({ firstName: '', lastName: '', phone: '', email: '' });
const phoneE164 = computed(() => normalizePhone(newCustomer.value.phone));
const phoneInvalid = computed(() => newCustomer.value.phone.trim() !== '' && !phoneE164.value);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (q) => {
  clearTimeout(searchTimer);
  if (q.trim().length < 2) {
    results.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    searching.value = true;
    try {
      results.value = (await api.listCustomers({ q: q.trim(), limit: 8 })).items;
    } catch (e) {
      loadError.value = describeError(e);
    } finally {
      searching.value = false;
    }
  }, 250);
});

const customerNotes = ref('');
const internalNotes = ref('');

const location = computed(() => locations.value.find((l) => l.id === locationId.value));
const service = computed(() => services.value.find((s) => s.id === serviceId.value));
const tz = computed(() => location.value?.effectiveTimezone ?? tenantTz);

const customerRef = computed<CreateReservationRequest['customer'] | null>(() => {
  if (customerMode.value === 'existing')
    return selectedCustomer.value ? { id: selectedCustomer.value.id } : null;
  const c = newCustomer.value;
  const email = c.email.trim();
  if (!c.firstName.trim() || phoneInvalid.value || (!phoneE164.value && !email)) return null;
  return {
    firstName: c.firstName.trim(),
    ...(c.lastName.trim() ? { lastName: c.lastName.trim() } : {}),
    ...(phoneE164.value ? { phoneE164: phoneE164.value } : {}),
    ...(email ? { email } : {}),
  };
});

const body = computed<CreateReservationRequest | null>(() => {
  if (!serviceId.value || !locationId.value || !slot.value || !customerRef.value) return null;
  return {
    serviceId: serviceId.value,
    locationId: locationId.value,
    resourceId: slot.value.resourceId,
    startAt: slot.value.startAt,
    customer: customerRef.value,
    customerNotes: customerNotes.value.trim() || null,
    internalNotes: internalNotes.value.trim() || null,
  };
});

/**
 * Idempotencia: UNA clave por intención. Reenviar exactamente lo mismo (reintento tras un error de red, doble
 * clic) reutiliza la clave y el servidor devuelve la misma reserva; si cambia cualquier dato, clave nueva.
 */
let key = newIdempotencyKey();
let keyFor = '';
const submit = useAsyncAction();
const slotTaken = ref(false);

async function book() {
  const b = body.value;
  if (!b) return;
  const fingerprint = JSON.stringify(b);
  if (fingerprint !== keyFor) {
    key = newIdempotencyKey();
    keyFor = fingerprint;
  }
  slotTaken.value = false;
  const created = await submit.run(async () => {
    try {
      return await api.createReservation(b, key);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SLOT_UNAVAILABLE') {
        slotTaken.value = true;
        slot.value = null;
        await picker.value?.reload();
      }
      throw e;
    }
  });
  if (created) await router.push({ name: 'reservation', params: { id: created.id } });
}

async function loadServices() {
  serviceId.value = '';
  services.value = [];
  if (!locationId.value) return;
  services.value = (
    await api.listServices({ locationId: locationId.value, isActive: true, limit: 100 })
  ).items.filter((s) => s.resourceIds.length > 0);
  if (services.value.length === 1) serviceId.value = services.value[0]!.id;
}
watch(locationId, () => loadServices().catch((e) => (loadError.value = describeError(e))));
watch([locationId, serviceId], () => (slot.value = null));

onMounted(async () => {
  try {
    locations.value = (await api.listLocations({ isActive: true, limit: 100 })).items;
    const wanted = route.query['locationId'];
    if (typeof wanted === 'string' && locations.value.some((l) => l.id === wanted))
      locationId.value = wanted;
    else if (locations.value.length === 1) locationId.value = locations.value[0]!.id;
  } catch (e) {
    loadError.value = describeError(e);
  }
});
</script>

<template>
  <h1>Nueva reserva</h1>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>

  <div class="steps">
    <section class="card" aria-labelledby="paso-servicio">
      <h2 id="paso-servicio" style="margin-top: 0">1. Servicio</h2>
      <div class="row">
        <div class="field">
          <label for="r-loc">Sucursal</label>
          <select id="r-loc" v-model="locationId">
            <option value="" disabled>Elige una sucursal</option>
            <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </div>
        <div class="field">
          <label for="r-svc">Servicio</label>
          <select id="r-svc" v-model="serviceId" :disabled="!locationId">
            <option value="" disabled>Elige un servicio</option>
            <option v-for="s in services" :key="s.id" :value="s.id">
              {{ s.name }} · {{ s.durationMinutes }} min · {{ formatMoney(s.price, s.currency) }}
            </option>
          </select>
        </div>
      </div>
      <p v-if="locationId && services.length === 0" class="muted">
        Esta sucursal no tiene servicios con profesionales asignados.
      </p>
    </section>

    <section v-if="serviceId" class="card" aria-labelledby="paso-horario">
      <h2 id="paso-horario" style="margin-top: 0">2. Horario</h2>
      <AlertBox v-if="slotTaken" kind="error">
        Ese horario acaba de ocuparse. Elige otro de la lista actualizada.
      </AlertBox>
      <SlotPicker
        ref="picker"
        :service-id="serviceId"
        :location-id="locationId"
        :initial-date="initialDate"
        allow-any
        @select="(v) => (slot = v)"
      />
    </section>

    <section v-if="slot" class="card" aria-labelledby="paso-cliente">
      <h2 id="paso-cliente" style="margin-top: 0">3. Cliente</h2>
      <div v-if="canSearch" class="actions" role="radiogroup" aria-label="Tipo de cliente">
        <label
          ><input v-model="customerMode" type="radio" value="existing" /> Cliente existente</label
        >
        <label><input v-model="customerMode" type="radio" value="new" /> Cliente nuevo</label>
      </div>

      <template v-if="customerMode === 'existing'">
        <div v-if="selectedCustomer" class="row" style="align-items: center">
          <strong>{{ customerName(selectedCustomer) }}</strong>
          <span class="muted">{{
            selectedCustomer.phoneE164 ?? selectedCustomer.email ?? ''
          }}</span>
          <button type="button" class="small" @click="selectedCustomer = null">Cambiar</button>
        </div>
        <template v-else>
          <div class="field">
            <label for="r-search">Buscar por nombre, teléfono o email</label>
            <input id="r-search" v-model="search" type="search" autocomplete="off" />
          </div>
          <p v-if="searching" role="status">Buscando…</p>
          <ul v-else-if="results.length" class="result-list">
            <li v-for="c in results" :key="c.id">
              <button type="button" @click="selectedCustomer = c">
                {{ customerName(c) }}
                <span class="muted">· {{ c.phoneE164 ?? c.email }}</span>
              </button>
            </li>
          </ul>
          <p v-else-if="search.trim().length >= 2" class="muted">
            Sin resultados.
            <button type="button" class="small" @click="customerMode = 'new'">
              Crear cliente nuevo
            </button>
          </p>
        </template>
      </template>

      <template v-else>
        <div class="row">
          <FormField v-model="newCustomer.firstName" label="Nombre" autocomplete="off" />
          <FormField
            v-model="newCustomer.lastName"
            label="Apellido (opcional)"
            autocomplete="off"
          />
        </div>
        <div class="row">
          <FormField
            v-model="newCustomer.phone"
            label="Teléfono"
            type="tel"
            autocomplete="off"
            :error="phoneInvalid ? 'Teléfono no válido (ej.: +56 9 1234 5678)' : undefined"
          />
          <FormField v-model="newCustomer.email" label="Email" type="email" autocomplete="off" />
        </div>
        <p class="muted" style="font-size: 0.85rem">
          Indica al menos teléfono o email. Si el teléfono ya existe, se usará ese cliente.
        </p>
      </template>
    </section>

    <section v-if="slot" class="card" aria-labelledby="paso-confirmar">
      <h2 id="paso-confirmar" style="margin-top: 0">4. Confirmar</h2>
      <FormField v-model="customerNotes" label="Nota del cliente (opcional)" />
      <FormField v-model="internalNotes" label="Nota interna (opcional, no la ve el cliente)" />
      <p v-if="service">
        <strong>{{ service.name }}</strong> · {{ formatLocalDateTime(slot.startAt, tz) }} ·
        {{ service.durationMinutes }} min · {{ formatMoney(service.price, service.currency) }}
      </p>
      <AlertBox v-if="submit.error.value && !slotTaken" kind="error">{{
        submit.error.value
      }}</AlertBox>
      <button
        class="primary"
        type="button"
        style="width: auto"
        :disabled="!body || submit.loading.value"
        @click="book"
      >
        {{ submit.loading.value ? 'Reservando…' : 'Reservar' }}
      </button>
    </section>
  </div>
</template>

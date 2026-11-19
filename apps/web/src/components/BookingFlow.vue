<script setup lang="ts">
import {
  type CreatePublicReservationRequest,
  type PublicServiceView,
  type PublicTenantView,
  normalizePhone,
} from '@reservepro/contracts';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { PortalError, type PortalApi, portalApi } from '../lib/api';
import {
  formatAddress,
  formatDuration,
  formatLongDate,
  formatMoney,
  formatTime,
  localDate,
} from '../lib/format';
import SlotPicker from './SlotPicker.vue';

const props = withDefaults(
  defineProps<{
    tenant: PublicTenantView;
    /** Servicios ya cargados en el servidor (una sola sucursal); si faltan, se piden desde el navegador. */
    initialServices?: PublicServiceView[] | null;
    api?: PortalApi;
    /** A dónde ir tras reservar (inyectable en pruebas). */
    navigate?: (url: string) => void;
    newKey?: () => string;
  }>(),
  {
    initialServices: null,
    api: () => portalApi,
    navigate: (url: string) => window.location.assign(url),
    newKey: () => crypto.randomUUID(),
  },
);

type Step = 'location' | 'service' | 'resource' | 'time' | 'details';
const step = ref<Step>(props.tenant.locations.length === 1 ? 'service' : 'location');
const heading = ref<HTMLElement | null>(null);

const locationId = ref(props.tenant.locations.length === 1 ? props.tenant.locations[0]!.id : '');
const location = computed(() => props.tenant.locations.find((l) => l.id === locationId.value));
const services = ref<PublicServiceView[]>(props.initialServices ?? []);
const servicesError = ref<string | null>(null);
const loadingServices = ref(!props.initialServices && !!locationId.value);
const service = ref<PublicServiceView | null>(null);
/** null = cualquiera disponible. */
const resourceId = ref<string | null>(null);
const slot = ref<{ startAt: string; resourceId: string | null } | null>(null);
const picker = ref<InstanceType<typeof SlotPicker> | null>(null);
const notice = ref<string | null>(null);

const form = ref({ firstName: '', lastName: '', phone: '', email: '', notes: '' });
const phoneE164 = computed(() => normalizePhone(form.value.phone));
const touched = ref(false);
const emailOk = computed(
  () =>
    form.value.email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.value.email.trim()),
);
const formOk = computed(
  () => form.value.firstName.trim() !== '' && !!phoneE164.value && emailOk.value,
);
const submitting = ref(false);
const submitError = ref<string | null>(null);

const tz = computed(() => location.value?.timezone ?? props.tenant.timezone);
const today = computed(() => localDate(new Date(), tz.value));
const resourceName = (id: string | null) =>
  id ? (service.value?.resources.find((r) => r.id === id)?.name ?? '') : 'Cualquiera disponible';

async function go(next: Step) {
  step.value = next;
  notice.value = null;
  await nextTick();
  heading.value?.focus(); // lectores de pantalla y teclado: el foco acompaña al paso
}

async function loadServices() {
  if (!locationId.value) return;
  loadingServices.value = true;
  servicesError.value = null;
  try {
    services.value = await props.api.services(props.tenant.slug, locationId.value);
  } catch (e) {
    servicesError.value = e instanceof PortalError ? e.message : 'No pudimos cargar los servicios.';
  } finally {
    loadingServices.value = false;
  }
}
watch(locationId, loadServices);
onMounted(() => {
  if (!props.initialServices) void loadServices();
});

function chooseLocation(id: string) {
  locationId.value = id;
  service.value = null;
  void go('service');
}
function chooseService(s: PublicServiceView) {
  service.value = s;
  resourceId.value = s.resources.length === 1 ? s.resources[0]!.id : null;
  slot.value = null;
  void go(s.resources.length > 1 ? 'resource' : 'time');
}
function chooseResource(id: string | null) {
  resourceId.value = id;
  slot.value = null;
  void go('time');
}
function chooseSlot(v: { startAt: string; resourceId: string | null }) {
  slot.value = v;
  void go('details');
}

const loadSlots = (date: string) =>
  props.api.availability(props.tenant.slug, {
    serviceId: service.value!.id,
    locationId: locationId.value,
    from: date,
    ...(resourceId.value ? { resourceId: resourceId.value } : {}),
  });

const body = computed<CreatePublicReservationRequest | null>(() => {
  if (!service.value || !slot.value || !formOk.value) return null;
  const f = form.value;
  return {
    serviceId: service.value.id,
    locationId: locationId.value,
    resourceId: slot.value.resourceId,
    startAt: slot.value.startAt,
    customer: {
      firstName: f.firstName.trim(),
      ...(f.lastName.trim() ? { lastName: f.lastName.trim() } : {}),
      phoneE164: phoneE164.value!,
      ...(f.email.trim() ? { email: f.email.trim() } : {}),
    },
    ...(f.notes.trim() ? { customerNotes: f.notes.trim() } : {}),
  };
});

// Idempotencia: una clave por intención; reenviar lo MISMO (doble clic, red caída) reutiliza la clave.
let key = '';
let keyFor = '';

async function submit() {
  touched.value = true;
  const b = body.value;
  if (!b || submitting.value) return;
  const fingerprint = JSON.stringify(b);
  if (fingerprint !== keyFor) {
    key = props.newKey();
    keyFor = fingerprint;
  }
  submitting.value = true;
  submitError.value = null;
  try {
    const res = await props.api.book(props.tenant.slug, b, key);
    // El secreto va SOLO en el fragmento: nunca llega a ningún servidor ni a la cabecera Referer.
    props.navigate(`/mi-reserva#token=${res.manageToken}&nueva=1`);
  } catch (e) {
    if (e instanceof PortalError && e.code === 'SLOT_UNAVAILABLE') {
      slot.value = null;
      await go('time');
      notice.value = 'Ese horario se acaba de ocupar. Elige otro, por favor.';
      await picker.value?.reload();
    } else {
      submitError.value = e instanceof PortalError ? e.message : 'No pudimos completar la reserva.';
    }
  } finally {
    submitting.value = false;
  }
}

const stepTitle: Record<Step, string> = {
  location: '¿En qué sucursal?',
  service: '¿Qué servicio quieres?',
  resource: '¿Con quién?',
  time: '¿Qué día y a qué hora?',
  details: 'Tus datos',
};
</script>

<template>
  <section class="booking" aria-labelledby="paso">
    <h2 id="paso" ref="heading" tabindex="-1">{{ stepTitle[step] }}</h2>

    <!-- Resumen de lo elegido hasta ahora, con opción de volver -->
    <ul v-if="step !== 'location' && step !== 'service'" class="summary">
      <li v-if="tenant.locations.length > 1 && location">
        {{ location.name }}
        <button type="button" class="link" @click="go('location')">Cambiar</button>
      </li>
      <li v-if="service">
        {{ service.name }} · {{ formatDuration(service.durationMinutes) }} ·
        {{ formatMoney(service.price, service.currency) }}
        <button type="button" class="link" @click="go('service')">Cambiar</button>
      </li>
      <li v-if="service && service.resources.length > 1 && step !== 'resource'">
        {{ resourceName(resourceId) }}
        <button type="button" class="link" @click="go('resource')">Cambiar</button>
      </li>
      <li v-if="slot && step === 'details'">
        {{ formatLongDate(slot.startAt, tz) }}, {{ formatTime(slot.startAt, tz) }} h
        <button type="button" class="link" @click="go('time')">Cambiar</button>
      </li>
    </ul>

    <div v-if="step === 'location'" class="cards">
      <button
        v-for="l in tenant.locations"
        :key="l.id"
        type="button"
        class="card"
        @click="chooseLocation(l.id)"
      >
        <strong>{{ l.name }}</strong>
        <span class="muted">{{ formatAddress(l.address) }}</span>
      </button>
    </div>

    <template v-else-if="step === 'service'">
      <p v-if="tenant.locations.length > 1" class="muted">
        {{ location?.name }} ·
        <button type="button" class="link" @click="go('location')">Cambiar sucursal</button>
      </p>
      <p v-if="servicesError" role="alert" class="error">{{ servicesError }}</p>
      <p v-else-if="loadingServices" role="status" class="muted">Cargando servicios…</p>
      <p v-else-if="services.length === 0" class="muted">
        Por ahora no hay servicios para reservar en línea aquí.
      </p>
      <div class="cards">
        <button
          v-for="s in services"
          :key="s.id"
          type="button"
          class="card"
          @click="chooseService(s)"
        >
          <span class="row">
            <strong>{{ s.name }}</strong>
            <span>{{ formatMoney(s.price, s.currency) }}</span>
          </span>
          <span class="muted"
            >{{ formatDuration(s.durationMinutes)
            }}<template v-if="s.categoryName"> · {{ s.categoryName }}</template></span
          >
          <span v-if="s.description" class="desc">{{ s.description }}</span>
          <span v-if="s.requiresConfirmation" class="tag">El negocio confirma tu reserva</span>
        </button>
      </div>
    </template>

    <div v-else-if="step === 'resource' && service" class="cards">
      <button type="button" class="card" @click="chooseResource(null)">
        <strong>Cualquiera disponible</strong>
        <span class="muted">Te mostramos todos los horarios</span>
      </button>
      <button
        v-for="r in service.resources"
        :key="r.id"
        type="button"
        class="card"
        @click="chooseResource(r.id)"
      >
        <strong>{{ r.name }}</strong>
      </button>
    </div>

    <template v-else-if="step === 'time' && service">
      <p v-if="notice" role="alert" class="error">{{ notice }}</p>
      <SlotPicker
        ref="picker"
        :load="loadSlots"
        :first-date="today"
        :resource-id="resourceId"
        @select="chooseSlot"
      />
      <p class="muted small">Horas de {{ location?.name ?? tenant.name }} ({{ tz }}).</p>
    </template>

    <form v-else-if="step === 'details'" novalidate @submit.prevent="submit">
      <div class="grid2">
        <label
          >Nombre<input
            v-model="form.firstName"
            autocomplete="given-name"
            required
            :aria-invalid="touched && !form.firstName.trim()"
        /></label>
        <label
          >Apellido <span class="muted">(opcional)</span
          ><input v-model="form.lastName" autocomplete="family-name"
        /></label>
      </div>
      <label
        >Teléfono móvil
        <input
          v-model="form.phone"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          placeholder="+56 9 1234 5678"
          required
          :aria-invalid="touched && !phoneE164"
          aria-describedby="tel-ayuda"
        />
      </label>
      <p id="tel-ayuda" class="muted small" :class="{ error: touched && !phoneE164 }">
        {{
          touched && !phoneE164
            ? 'Revisa el teléfono (ej.: +56 9 1234 5678).'
            : 'Para avisarte de cambios en tu reserva.'
        }}
      </p>
      <label
        >Email <span class="muted">(opcional, para recibir la confirmación y el enlace)</span>
        <input
          v-model="form.email"
          type="email"
          autocomplete="email"
          :aria-invalid="touched && !emailOk"
        />
      </label>
      <p v-if="touched && !emailOk" class="error small">Revisa el email.</p>
      <label
        >¿Algo que debamos saber? <span class="muted">(opcional)</span
        ><textarea v-model="form.notes" rows="2" maxlength="1000" />
      </label>
      <!-- Texto de consentimiento VERSIONADO: si cambia, cambiar CONSENT_TEXT_VERSION (api, public.service.ts). -->
      <p class="muted small">
        Usaremos tus datos solo para gestionar esta reserva con {{ tenant.name }}: confirmación,
        cambios y un recordatorio por los medios que nos diste.
      </p>
      <p v-if="submitError" role="alert" class="error">{{ submitError }}</p>
      <button type="submit" class="primary" :disabled="submitting">
        {{ submitting ? 'Reservando…' : 'Confirmar reserva' }}
      </button>
    </form>
  </section>
</template>

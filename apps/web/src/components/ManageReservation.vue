<script setup lang="ts">
import type { PublicReservationView } from '@reservepro/contracts';
import { computed, onMounted, ref } from 'vue';
import { PortalError, type PortalApi, portalApi } from '../lib/api';
import {
  formatAddress,
  formatDuration,
  formatLongDate,
  formatMoney,
  formatTime,
  localDate,
  tokenFromHash,
} from '../lib/format';
import SlotPicker from './SlotPicker.vue';

const props = withDefaults(
  defineProps<{
    api?: PortalApi;
    /** Fuente del fragmento (inyectable en pruebas). */
    readHash?: () => string;
    replaceHash?: (hash: string) => void;
  }>(),
  {
    api: () => portalApi,
    readHash: () => window.location.hash,
    replaceHash: (hash: string) => history.replaceState(null, '', hash),
  },
);

const STATUS: Record<string, string> = {
  pending: 'Pendiente de confirmación',
  confirmed: 'Confirmada',
  in_progress: 'En curso',
  completed: 'Completada',
  cancelled: 'Cancelada',
  no_show: 'No asististe',
};

const token = ref<string | null>(null);
const isNew = ref(false);
const r = ref<PublicReservationView | null>(null);
const loadError = ref<string | null>(null);
const mode = ref<'view' | 'cancel' | 'reschedule'>('view');
const reason = ref('');
const newSlot = ref<string | null>(null);
const busy = ref(false);
const actionError = ref<string | null>(null);
const done = ref<string | null>(null);
const copied = ref(false);

const tz = computed(() => r.value?.timeZone ?? 'UTC');
const link = computed(() =>
  token.value ? `${location.origin}/mi-reserva#token=${token.value}` : '',
);

async function load() {
  if (!token.value) return;
  try {
    r.value = await props.api.lookup(token.value);
    loadError.value = null;
  } catch (e) {
    loadError.value =
      e instanceof PortalError && e.code === 'LINK_INVALID'
        ? 'Este enlace no es válido o ya venció. Si necesitas ayuda, contacta directamente al negocio.'
        : e instanceof PortalError
          ? e.message
          : 'No pudimos cargar tu reserva.';
  }
}

/** Ejecuta una acción; si la reserva cambió entre medio (otra pestaña, el negocio), recarga y lo explica. */
async function act(
  fn: (current: PublicReservationView) => Promise<PublicReservationView>,
  ok: string,
) {
  if (!r.value || !token.value || busy.value) return;
  busy.value = true;
  actionError.value = null;
  try {
    r.value = await fn(r.value);
    mode.value = 'view';
    done.value = ok;
    newSlot.value = null;
  } catch (e) {
    if (e instanceof PortalError && e.code === 'VERSION_CONFLICT') {
      await load();
      actionError.value = 'Tu reserva cambió hace un momento. Revisa los datos actualizados.';
    } else if (e instanceof PortalError && e.code === 'SLOT_UNAVAILABLE') {
      newSlot.value = null;
      actionError.value = 'Ese horario se acaba de ocupar. Elige otro, por favor.';
    } else {
      actionError.value = e instanceof PortalError ? e.message : 'No se pudo completar la acción.';
    }
  } finally {
    busy.value = false;
  }
}

const cancel = () =>
  act(
    (c) => props.api.cancel(token.value!, c.version, reason.value.trim() || null),
    'Tu reserva quedó cancelada.',
  );
const reschedule = () => {
  const start = newSlot.value;
  if (!start) return;
  return act(
    (c) => props.api.reschedule(token.value!, c.version, start),
    'Listo, cambiamos el horario de tu reserva.',
  );
};
const loadSlots = (date: string) => props.api.manageAvailability(token.value!, date);

async function copy() {
  try {
    await navigator.clipboard.writeText(link.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

onMounted(async () => {
  const hash = props.readHash();
  token.value = tokenFromHash(hash);
  isNew.value = /(?:^#|&)nueva=1(?:&|$)/.test(hash);
  if (!token.value) {
    loadError.value = 'Falta el enlace de tu reserva. Ábrelo desde el mensaje que recibiste.';
    return;
  }
  // Quita "nueva=1" para que al recargar no vuelva a mostrarse el aviso; el token sigue en el fragmento.
  if (isNew.value) props.replaceHash(`#token=${token.value}`);
  await load();
});
</script>

<template>
  <section aria-labelledby="titulo">
    <p v-if="loadError" role="alert" class="error">{{ loadError }}</p>

    <template v-if="r">
      <div v-if="isNew" class="banner" role="status">
        <strong>{{ r.status === 'pending' ? '¡Solicitud enviada!' : '¡Reserva lista!' }}</strong>
        <p v-if="r.status === 'pending' && r.holdExpiresAt">
          {{ r.tenantName }} debe confirmarla. Te guardamos el horario hasta las
          {{ formatTime(r.holdExpiresAt, tz) }} h.
        </p>
        <p>
          <strong>Guarda este enlace</strong>: con él puedes ver, cambiar o cancelar tu reserva. Es
          personal, no lo compartas.
        </p>
        <div class="copy">
          <input
            :value="link"
            readonly
            aria-label="Enlace de tu reserva"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button type="button" @click="copy">{{ copied ? 'Copiado' : 'Copiar' }}</button>
        </div>
      </div>

      <h1 id="titulo">Tu reserva en {{ r.tenantName }}</h1>
      <p>
        <span class="status" :class="r.status">{{ STATUS[r.status] ?? r.status }}</span>
        <span class="muted"> · Código {{ r.code }}</span>
      </p>
      <p v-if="done" role="status" class="ok">{{ done }}</p>

      <dl class="details">
        <dt>Servicio</dt>
        <dd>{{ r.serviceName }} · {{ formatDuration(r.durationMinutes) }}</dd>
        <dt>Cuándo</dt>
        <dd>
          {{ formatLongDate(r.startAt, tz) }}, {{ formatTime(r.startAt, tz) }} a
          {{ formatTime(r.endAt, tz) }} h
        </dd>
        <dt>Con</dt>
        <dd>{{ r.resourceName }}</dd>
        <dt>Dónde</dt>
        <dd>
          {{ r.locationName
          }}<template v-if="formatAddress(r.locationAddress)"
            >, {{ formatAddress(r.locationAddress) }}</template
          >
        </dd>
        <dt>Valor</dt>
        <dd>{{ formatMoney(r.totalAmount, r.currency) }}</dd>
      </dl>

      <p v-if="actionError" role="alert" class="error">{{ actionError }}</p>

      <div v-if="mode === 'view'" class="actions">
        <button v-if="r.canReschedule" type="button" @click="mode = 'reschedule'">
          Cambiar horario
        </button>
        <button v-if="r.canCancel" type="button" class="danger" @click="mode = 'cancel'">
          Cancelar reserva
        </button>
      </div>
      <p v-if="r.policyNote" class="muted">{{ r.policyNote }}</p>

      <form v-if="mode === 'cancel'" class="panel" @submit.prevent="cancel">
        <h2>¿Cancelar tu reserva?</h2>
        <label
          >Motivo <span class="muted">(opcional)</span><input v-model="reason" maxlength="300"
        /></label>
        <div class="actions">
          <button type="submit" class="danger" :disabled="busy">Sí, cancelar</button>
          <button type="button" @click="mode = 'view'">No, volver</button>
        </div>
      </form>

      <div v-if="mode === 'reschedule'" class="panel">
        <h2>Elige el nuevo horario</h2>
        <p class="muted small">
          Mismo servicio y con {{ r.resourceName }}. Horas de {{ r.locationName }}.
        </p>
        <SlotPicker
          :load="loadSlots"
          :first-date="localDate(new Date(), tz)"
          :resource-id="null"
          @select="(v) => (newSlot = v.startAt)"
        />
        <div class="actions">
          <button type="button" class="primary" :disabled="!newSlot || busy" @click="reschedule">
            {{
              newSlot
                ? `Cambiar al ${formatLongDate(newSlot, tz)}, ${formatTime(newSlot, tz)} h`
                : 'Elige un horario'
            }}
          </button>
          <button type="button" @click="mode = 'view'">Volver</button>
        </div>
      </div>

      <p class="muted small">
        <a :href="`/${r.tenantSlug}`">Hacer otra reserva en {{ r.tenantName }}</a>
      </p>
    </template>
  </section>
</template>

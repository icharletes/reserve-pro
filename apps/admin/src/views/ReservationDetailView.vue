<script setup lang="ts">
import { ApiError } from '@reservepro/api-client';
import type { ReservationEventView, ReservationView } from '@reservepro/contracts';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import SlotPicker from '../components/SlotPicker.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { describeError } from '../lib/errors';
import {
  type ReservationAction,
  availableActions,
  customerName,
  formatLocalDateTime,
  formatMoney,
  statusLabel,
} from '../lib/reservations';
import { localParts } from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const id = String(route.params['id']);

const r = ref<ReservationView | null>(null);
const events = ref<ReservationEventView[]>([]);
const resourceNames = ref(new Map<string, string>());
const loadError = ref<string | null>(null);
const notice = ref<string | null>(null);
const action = useAsyncAction();
const mode = ref<'idle' | 'cancel' | 'reschedule'>('idle');
const reason = ref('');
const newSlot = ref<{ startAt: string; resourceId: string | null } | null>(null);

const actions = computed(() => (r.value ? availableActions(r.value, (p) => auth.can(p)) : []));
const tz = computed(() => r.value?.timeZone ?? 'UTC');
const fmt = (iso: string) => formatLocalDateTime(iso, tz.value);
const resName = (rid: string) => resourceNames.value.get(rid) ?? 'Recurso';

const LABELS: Record<ReservationAction, string> = {
  confirm: 'Confirmar',
  in_progress: 'Marcar en curso',
  completed: 'Marcar completada',
  no_show: 'No asistió',
  reschedule: 'Reprogramar',
  cancel: 'Cancelar reserva',
};
const EVENT_LABELS: Record<string, string> = {
  created: 'Creada',
  cancelled: 'Cancelada',
  rescheduled: 'Reprogramada',
  status_changed: 'Cambio de estado',
};
function eventDetail(e: ReservationEventView): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === 'status_changed')
    return `${statusLabel(String(p['from']))} → ${statusLabel(String(p['to']))}`;
  if (e.type === 'rescheduled') {
    const to = p['to'] as { startAt?: string } | undefined;
    return to?.startAt ? `a ${fmt(to.startAt)}` : '';
  }
  if (e.type === 'cancelled' && p['reason']) return `Motivo: ${String(p['reason'])}`;
  return '';
}

async function load() {
  loadError.value = null;
  try {
    r.value = await api.getReservation(id);
    events.value = await api.listReservationEvents(id);
  } catch (e) {
    loadError.value = describeError(e);
  }
}

/** Ejecuta una acción; si otra persona cambió la reserva entre medio (409 VERSION_CONFLICT), recarga y avisa. */
async function perform(fn: (current: ReservationView) => Promise<ReservationView>, done: string) {
  const current = r.value;
  if (!current) return;
  notice.value = null;
  const updated = await action.run(async () => {
    try {
      return await fn(current);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') await load();
      throw e;
    }
  });
  if (updated) {
    r.value = updated;
    events.value = await api.listReservationEvents(id).catch(() => events.value);
    mode.value = 'idle';
    newSlot.value = null;
    reason.value = '';
    notice.value = done;
  }
}

function run(a: ReservationAction) {
  if (a === 'cancel' || a === 'reschedule') {
    mode.value = a;
    return;
  }
  if (a === 'confirm')
    return perform((c) => api.confirmReservation(c.id, c.version), 'Reserva confirmada.');
  return perform(
    (c) => api.changeReservationStatus(c.id, { version: c.version, status: a }),
    `Estado actualizado: ${statusLabel(a)}.`,
  );
}
const cancel = () =>
  perform(
    (c) => api.cancelReservation(c.id, { version: c.version, reason: reason.value.trim() || null }),
    'Reserva cancelada. El horario quedó libre.',
  );
const reschedule = () => {
  const s = newSlot.value;
  if (!s) return;
  return perform(
    (c) =>
      api.rescheduleReservation(c.id, {
        version: c.version,
        startAt: s.startAt,
        ...(s.resourceId ? { resourceId: s.resourceId } : {}),
      }),
    'Reserva reprogramada.',
  );
};

onMounted(async () => {
  await load();
  if (auth.can('resources:read')) {
    const res = await api.listResources({ limit: 100 }).catch(() => null);
    if (res) resourceNames.value = new Map(res.items.map((x) => [x.id, x.name]));
  }
});
</script>

<template>
  <p><RouterLink to="/reservations">← Reservas</RouterLink></p>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
  <template v-if="r">
    <h1>
      Reserva {{ r.code }} <span class="status" :class="r.status">{{ statusLabel(r.status) }}</span>
    </h1>
    <AlertBox v-if="notice" kind="info">{{ notice }}</AlertBox>
    <AlertBox v-if="action.error.value" kind="error">{{ action.error.value }}</AlertBox>

    <section class="card">
      <dl class="details">
        <dt>Cuándo</dt>
        <dd>
          {{ fmt(r.startAt) }} – {{ fmt(r.endAt).slice(-5) }} <span class="muted">({{ tz }})</span>
        </dd>
        <dt>Servicio</dt>
        <dd>
          <span v-for="i in r.items" :key="i.serviceId"
            >{{ i.serviceName }} · {{ i.durationMinutes }} min</span
          >
        </dd>
        <dt>Atiende</dt>
        <dd>{{ r.resources.map((x) => resName(x.resourceId)).join(', ') }}</dd>
        <dt>Cliente</dt>
        <dd>
          {{ customerName(r.customer) }}
          <span class="muted">{{
            [r.customer.phoneE164, r.customer.email].filter(Boolean).join(' · ')
          }}</span>
        </dd>
        <dt>Total</dt>
        <dd>{{ formatMoney(r.totalAmount, r.currency) }}</dd>
        <template v-if="r.customerNotes">
          <dt>Nota del cliente</dt>
          <dd>{{ r.customerNotes }}</dd>
        </template>
        <template v-if="r.internalNotes">
          <dt>Nota interna</dt>
          <dd>{{ r.internalNotes }}</dd>
        </template>
        <template v-if="r.status === 'cancelled'">
          <dt>Cancelada</dt>
          <dd>
            {{ fmt(r.cancelledAt!) }}{{ r.cancellationReason ? ` · ${r.cancellationReason}` : '' }}
          </dd>
        </template>
        <template v-if="r.rescheduleCount > 0">
          <dt>Reprogramaciones</dt>
          <dd>{{ r.rescheduleCount }}</dd>
        </template>
      </dl>

      <div v-if="actions.length && mode === 'idle'" class="actions">
        <button
          v-for="a in actions"
          :key="a"
          type="button"
          :class="{ primary: a === 'confirm', danger: a === 'cancel' }"
          :disabled="action.loading.value"
          @click="run(a)"
        >
          {{ LABELS[a] }}
        </button>
      </div>
    </section>

    <form v-if="mode === 'cancel'" class="card" @submit.prevent="cancel">
      <h2 style="margin-top: 0">Cancelar reserva</h2>
      <FormField v-model="reason" label="Motivo (opcional)" />
      <div class="actions">
        <button type="submit" class="danger" :disabled="action.loading.value">
          Confirmar cancelación
        </button>
        <button type="button" @click="mode = 'idle'">Volver</button>
      </div>
    </form>

    <section v-if="mode === 'reschedule'" class="card">
      <h2 style="margin-top: 0">Reprogramar</h2>
      <p class="muted">Se conservan la duración y el precio reservados.</p>
      <SlotPicker
        :service-id="r.items[0]!.serviceId"
        :location-id="r.locationId"
        :initial-date="localParts(r.startAt, tz).date"
        @select="(v) => (newSlot = v)"
      />
      <div class="actions">
        <button
          type="button"
          class="primary"
          :disabled="!newSlot || action.loading.value"
          @click="reschedule"
        >
          Mover a {{ newSlot ? fmt(newSlot.startAt) : '…' }}
        </button>
        <button type="button" @click="mode = 'idle'">Volver</button>
      </div>
    </section>

    <section class="card" aria-labelledby="historial">
      <h2 id="historial" style="margin-top: 0">Historial</h2>
      <ol class="timeline">
        <li v-for="e in events" :key="e.id">
          <strong>{{ EVENT_LABELS[e.type] ?? e.type }}</strong>
          <span class="muted"> · {{ fmt(e.occurredAt) }}</span>
          <span v-if="eventDetail(e)"> · {{ eventDetail(e) }}</span>
        </li>
      </ol>
    </section>
  </template>
</template>

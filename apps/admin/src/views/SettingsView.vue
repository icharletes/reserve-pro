<script setup lang="ts">
import type { TenantSettingsView, UpdateTenantSettingsRequest } from '@reservepro/contracts';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { describeError } from '../lib/errors';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const canEdit = auth.can('tenant:update');
const saved = ref<TenantSettingsView | null>(null);
const form = ref<TenantSettingsView | null>(null);
const loadError = ref<string | null>(null);
const save = useAsyncAction();
const notice = ref<string | null>(null);

const portalBase =
  (import.meta.env['VITE_PORTAL_URL'] as string | undefined) ?? 'http://localhost:4321';
const portalUrl = computed(() => `${portalBase.replace(/\/$/, '')}/${auth.me?.tenant?.slug ?? ''}`);

// Opciones con texto claro en vez de números sueltos.
const NOTICE = [
  [0, 'Hasta el último momento'],
  [30, '30 minutos'],
  [60, '1 hora'],
  [120, '2 horas'],
  [240, '4 horas'],
  [720, '12 horas'],
  [1440, '1 día'],
  [2880, '2 días'],
] as const;
const ADVANCE = [7, 14, 30, 60, 90, 180, 365];
const STEPS = [5, 10, 15, 20, 30, 60] as const;
const HOLD = [
  [15, '15 minutos'],
  [30, '30 minutos'],
  [60, '1 hora'],
  [120, '2 horas'],
  [720, '12 horas'],
  [1440, '1 día'],
] as const;
const WINDOW = [0, 2, 6, 12, 24, 48, 72];
const REMINDER = [
  [null, 'Sin recordatorio'],
  [2, '2 horas antes'],
  [12, '12 horas antes'],
  [24, '24 horas antes'],
  [48, '48 horas antes'],
] as const;
const hoursLabel = (h: number) => (h === 0 ? 'Hasta la hora de la reserva' : `Hasta ${h} h antes`);

/** Solo se envía lo que cambió (el servidor aplica edición parcial). */
const changes = computed<UpdateTenantSettingsRequest>(() => {
  if (!form.value || !saved.value) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form.value)) {
    if (k !== 'updatedAt' && v !== (saved.value as Record<string, unknown>)[k]) out[k] = v;
  }
  return out as UpdateTenantSettingsRequest;
});
const dirty = computed(() => Object.keys(changes.value).length > 0);

async function submit() {
  if (!dirty.value) return;
  notice.value = null;
  const res = await save.run(() => api.updateTenantSettings(changes.value));
  if (res) {
    saved.value = res;
    form.value = { ...res };
    notice.value = 'Configuración guardada. Aplica desde la próxima reserva.';
  }
}
const discard = () => saved.value && (form.value = { ...saved.value });

onMounted(async () => {
  try {
    saved.value = await api.getTenantSettings();
    form.value = { ...saved.value };
  } catch (e) {
    loadError.value = describeError(e);
  }
});
</script>

<template>
  <h1>Configuración</h1>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
  <AlertBox v-if="!canEdit" kind="info">Puedes ver la configuración, pero no cambiarla.</AlertBox>

  <form v-if="form" novalidate @submit.prevent="submit">
    <fieldset :disabled="!canEdit || save.loading.value" class="plain">
      <section class="card" aria-labelledby="s-portal">
        <h2 id="s-portal" style="margin-top: 0">Reservas en línea</h2>
        <label class="check"
          ><input v-model="form.publicBookingEnabled" type="checkbox" /> Portal de reservas
          activado</label
        >
        <p class="muted small">
          Tu página pública:
          <a :href="portalUrl" target="_blank" rel="noopener">{{ portalUrl }}</a>
          <template v-if="!form.publicBookingEnabled"> (desactivada: nadie puede verla)</template>
        </p>
        <div class="row">
          <div class="field">
            <label for="s-notice">Antelación mínima</label>
            <select id="s-notice" v-model.number="form.bookingMinNoticeMinutes">
              <option v-for="[v, l] in NOTICE" :key="v" :value="v">{{ l }}</option>
              <option
                v-if="!NOTICE.some(([v]) => v === form!.bookingMinNoticeMinutes)"
                :value="form.bookingMinNoticeMinutes"
              >
                {{ form.bookingMinNoticeMinutes }} minutos
              </option>
            </select>
          </div>
          <div class="field">
            <label for="s-advance">Se puede reservar hasta</label>
            <select id="s-advance" v-model.number="form.bookingMaxAdvanceDays">
              <option v-for="d in ADVANCE" :key="d" :value="d">{{ d }} días adelante</option>
              <option
                v-if="!ADVANCE.includes(form.bookingMaxAdvanceDays)"
                :value="form.bookingMaxAdvanceDays"
              >
                {{ form.bookingMaxAdvanceDays }} días adelante
              </option>
            </select>
          </div>
          <div class="field">
            <label for="s-step">Horarios cada</label>
            <select id="s-step" v-model.number="form.slotStepMinutes">
              <option v-for="s in STEPS" :key="s" :value="s">{{ s }} minutos</option>
            </select>
          </div>
        </div>
        <div class="field" style="max-width: 20rem">
          <label for="s-max">Reservas activas por cliente (antiabuso)</label>
          <input
            id="s-max"
            v-model.number="form.maxActivePublicPerCustomer"
            type="number"
            min="1"
            max="50"
          />
        </div>
      </section>

      <section class="card" aria-labelledby="s-confirm">
        <h2 id="s-confirm" style="margin-top: 0">Confirmación</h2>
        <label class="check"
          ><input v-model="form.autoConfirm" type="checkbox" /> Confirmar automáticamente las
          reservas del portal</label
        >
        <p class="muted small">
          Si lo desactivas, quedan <strong>pendientes</strong> hasta que las confirmes en Reservas.
          Cada servicio puede exigir confirmación por su cuenta.
        </p>
        <div class="field" style="max-width: 20rem">
          <label for="s-hold">Guardar el horario de una pendiente durante</label>
          <select id="s-hold" v-model.number="form.pendingHoldMinutes">
            <option v-for="[v, l] in HOLD" :key="v" :value="v">{{ l }}</option>
            <option
              v-if="!HOLD.some(([v]) => v === form!.pendingHoldMinutes)"
              :value="form.pendingHoldMinutes"
            >
              {{ form.pendingHoldMinutes }} minutos
            </option>
          </select>
          <p class="muted small">
            Si no la confirmas a tiempo, el horario se libera y se avisa al cliente.
          </p>
        </div>
      </section>

      <section class="card" aria-labelledby="s-self">
        <h2 id="s-self" style="margin-top: 0">Lo que el cliente puede hacer desde su enlace</h2>
        <div class="row">
          <div>
            <label class="check"
              ><input v-model="form.selfServiceCancel" type="checkbox" /> Cancelar</label
            >
            <label class="check"
              ><input
                v-model="form.cancelRequiresApproval"
                type="checkbox"
                :disabled="!form.selfServiceCancel"
              />
              Solo contactando al negocio</label
            >
            <div class="field">
              <label for="s-cw">Plazo para cancelar</label>
              <select
                id="s-cw"
                v-model.number="form.cancelWindowHours"
                :disabled="!form.selfServiceCancel || form.cancelRequiresApproval"
              >
                <option v-for="h in WINDOW" :key="h" :value="h">{{ hoursLabel(h) }}</option>
                <option
                  v-if="!WINDOW.includes(form.cancelWindowHours)"
                  :value="form.cancelWindowHours"
                >
                  {{ hoursLabel(form.cancelWindowHours) }}
                </option>
              </select>
            </div>
          </div>
          <div>
            <label class="check"
              ><input v-model="form.selfServiceReschedule" type="checkbox" /> Cambiar el
              horario</label
            >
            <div class="field">
              <label for="s-rw">Plazo para cambiar</label>
              <select
                id="s-rw"
                v-model.number="form.rescheduleWindowHours"
                :disabled="!form.selfServiceReschedule"
              >
                <option v-for="h in WINDOW" :key="h" :value="h">{{ hoursLabel(h) }}</option>
                <option
                  v-if="!WINDOW.includes(form.rescheduleWindowHours)"
                  :value="form.rescheduleWindowHours"
                >
                  {{ hoursLabel(form.rescheduleWindowHours) }}
                </option>
              </select>
            </div>
            <div class="field">
              <label for="s-mr">Cambios permitidos por reserva</label>
              <input
                id="s-mr"
                v-model.number="form.maxReschedules"
                type="number"
                min="0"
                max="20"
                :disabled="!form.selfServiceReschedule"
              />
            </div>
          </div>
        </div>
        <p class="muted small">El personal puede cancelar y reprogramar siempre desde el panel.</p>
      </section>

      <section class="card" aria-labelledby="s-mail">
        <h2 id="s-mail" style="margin-top: 0">Comunicaciones</h2>
        <label class="check"
          ><input v-model="form.customerEmailsEnabled" type="checkbox" /> Enviar emails a los
          clientes (confirmación, cambios, cancelación)</label
        >
        <div class="field" style="max-width: 20rem">
          <label for="s-rem">Recordatorio</label>
          <select
            id="s-rem"
            v-model="form.reminderHoursBefore"
            :disabled="!form.customerEmailsEnabled"
          >
            <option v-for="[v, l] in REMINDER" :key="String(v)" :value="v">{{ l }}</option>
            <option
              v-if="!REMINDER.some(([v]) => v === form!.reminderHoursBefore)"
              :value="form.reminderHoursBefore"
            >
              {{ form.reminderHoursBefore }} horas antes
            </option>
          </select>
        </div>
      </section>
    </fieldset>

    <AlertBox v-if="save.error.value" kind="error">{{ save.error.value }}</AlertBox>
    <AlertBox v-if="notice" kind="info">{{ notice }}</AlertBox>
    <div v-if="canEdit" class="actions sticky-actions">
      <button
        class="primary"
        type="submit"
        style="width: auto"
        :disabled="!dirty || save.loading.value"
      >
        {{ save.loading.value ? 'Guardando…' : 'Guardar cambios' }}
      </button>
      <button type="button" :disabled="!dirty" @click="discard">Descartar</button>
    </div>
  </form>
</template>

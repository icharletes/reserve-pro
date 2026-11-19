<script setup lang="ts">
import type { AvailabilityResponse } from '@reservepro/contracts';
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { describeError } from '../lib/errors';
import { formatLocalTime } from '../lib/reservations';
import { addDays, isValidDate } from '../lib/schedule-format';
import AlertBox from './AlertBox.vue';

/**
 * Elige un horario libre de un servicio en una sucursal. Lo ofrecido es informativo: al reservar, el servidor lo
 * vuelve a validar (si alguien lo tomó entre medio, responde 409 y se recarga).
 *  - `fixedResourceId`: solo ese recurso (p. ej. reprogramar sin cambiar de profesional).
 *  - `allowAny`: muestra "Cualquiera disponible" (asignación automática del servidor: `resourceId` = null).
 */
const props = defineProps<{
  serviceId: string;
  locationId: string;
  initialDate: string;
  fixedResourceId?: string | undefined;
  allowAny?: boolean;
}>();
const emit = defineEmits<{ select: [value: { startAt: string; resourceId: string | null }] }>();

const date = ref(props.initialDate);
const mode = ref<string>(props.fixedResourceId ?? (props.allowAny ? 'any' : ''));
const data = ref<AvailabilityResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const chosen = ref<{ startAt: string; resourceId: string | null } | null>(null);

async function load() {
  chosen.value = null;
  data.value = null;
  if (!props.serviceId || !props.locationId || !isValidDate(date.value)) return;
  loading.value = true;
  error.value = null;
  try {
    data.value = await api.getAvailability({
      serviceId: props.serviceId,
      locationId: props.locationId,
      from: date.value,
      ...(props.fixedResourceId ? { resourceId: props.fixedResourceId } : {}),
    });
    if (!props.allowAny && !props.fixedResourceId && data.value.resources.length > 0)
      mode.value ||= data.value.resources[0]!.resourceId;
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
  }
}
/** Recarga conservando la fecha (tras un 409 "ese horario ya no está disponible"). */
defineExpose({ reload: load });

/** Horarios a mostrar: los del recurso elegido, o la unión de todos en "cualquiera". */
const slots = computed<{ start: string; resourceId: string | null }[]>(() => {
  const resources = data.value?.resources ?? [];
  if (mode.value === 'any') {
    const starts = new Set(resources.flatMap((r) => r.slots.map((s) => s.start)));
    return [...starts].sort().map((start) => ({ start, resourceId: null }));
  }
  const r = resources.find((x) => x.resourceId === mode.value);
  return (r?.slots ?? []).map((s) => ({ start: s.start, resourceId: r!.resourceId }));
});
const tz = computed(() => data.value?.timezone ?? 'UTC');

function pick(s: { start: string; resourceId: string | null }) {
  chosen.value = { startAt: s.start, resourceId: s.resourceId };
  emit('select', chosen.value);
}
const shift = (days: number) => (date.value = addDays(date.value, days));

watch(() => [props.serviceId, props.locationId, props.fixedResourceId, date.value], load, {
  immediate: true,
});
watch(mode, () => (chosen.value = null));
</script>

<template>
  <div class="slot-picker">
    <div class="row" style="align-items: flex-end">
      <div class="field" style="margin: 0">
        <label for="sp-date">Fecha</label>
        <input id="sp-date" v-model="date" type="date" />
      </div>
      <div class="actions">
        <button type="button" aria-label="Día anterior" @click="shift(-1)">←</button>
        <button type="button" aria-label="Día siguiente" @click="shift(1)">→</button>
      </div>
      <div v-if="!fixedResourceId && data" class="field" style="margin: 0">
        <label for="sp-res">Profesional / recurso</label>
        <select id="sp-res" v-model="mode">
          <option v-if="allowAny" value="any">Cualquiera disponible</option>
          <option v-for="r in data.resources" :key="r.resourceId" :value="r.resourceId">
            {{ r.name }}
          </option>
        </select>
      </div>
    </div>
    <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
    <p v-if="loading" role="status">Buscando horarios…</p>
    <p v-else-if="data && slots.length === 0" class="muted">
      No hay horarios disponibles ese día. Prueba otra fecha.
    </p>
    <div v-else-if="data" class="slots" role="group" aria-label="Horarios disponibles">
      <button
        v-for="s in slots"
        :key="`${s.start}-${s.resourceId}`"
        type="button"
        class="slot"
        :class="{ selected: chosen?.startAt === s.start && chosen?.resourceId === s.resourceId }"
        :aria-pressed="chosen?.startAt === s.start && chosen?.resourceId === s.resourceId"
        @click="pick(s)"
      >
        {{ formatLocalTime(s.start, tz) }}
      </button>
    </div>
    <p v-if="data" class="muted" style="font-size: 0.85rem">Horas de la sucursal ({{ tz }}).</p>
  </div>
</template>

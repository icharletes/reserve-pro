<script setup lang="ts">
import type { AvailabilityResponse } from '@reservepro/contracts';
import { computed, ref, watch } from 'vue';
import { PortalError } from '../lib/api';
import { addDays, formatShortDay, formatTime } from '../lib/format';

/**
 * Elige día y hora. Lo ofrecido es informativo: al confirmar, el servidor lo vuelve a validar.
 *  - `resourceId` null = "cualquiera disponible": se muestra la unión de horarios de todos.
 */
const props = withDefaults(
  defineProps<{
    load: (date: string) => Promise<AvailabilityResponse>;
    firstDate: string;
    resourceId?: string | null;
    days?: number;
  }>(),
  { resourceId: null, days: 14 },
);
const emit = defineEmits<{ select: [value: { startAt: string; resourceId: string | null }] }>();

const dates = computed(() =>
  Array.from({ length: props.days }, (_, i) => addDays(props.firstDate, i)),
);
const date = ref(props.firstDate);
const data = ref<AvailabilityResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const chosen = ref<string | null>(null);

async function reload() {
  loading.value = true;
  error.value = null;
  chosen.value = null;
  const asked = date.value;
  try {
    const res = await props.load(asked);
    if (asked === date.value) data.value = res; // descarta respuestas de un día ya abandonado
  } catch (e) {
    error.value = e instanceof PortalError ? e.message : 'No pudimos cargar los horarios.';
  } finally {
    loading.value = false;
  }
}
defineExpose({ reload });

const slots = computed<{ start: string; resourceId: string | null }[]>(() => {
  const resources = data.value?.resources ?? [];
  if (props.resourceId === null) {
    const starts = new Set(resources.flatMap((r) => r.slots.map((s) => s.start)));
    return [...starts].sort().map((start) => ({ start, resourceId: null }));
  }
  const r = resources.find((x) => x.resourceId === props.resourceId);
  return (r?.slots ?? []).map((s) => ({ start: s.start, resourceId: r!.resourceId }));
});
const tz = computed(() => data.value?.timezone ?? 'UTC');

function pick(s: { start: string; resourceId: string | null }) {
  chosen.value = s.start;
  emit('select', { startAt: s.start, resourceId: s.resourceId });
}

watch([date, () => props.resourceId], reload, { immediate: true });
</script>

<template>
  <div>
    <div class="days" role="radiogroup" aria-label="Día">
      <button
        v-for="d in dates"
        :key="d"
        type="button"
        class="day"
        role="radio"
        :aria-checked="d === date"
        :class="{ on: d === date }"
        @click="date = d"
      >
        {{ formatShortDay(d) }}
      </button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-else-if="loading" role="status" class="muted">Buscando horarios…</p>
    <p v-else-if="data && slots.length === 0" class="muted">
      No quedan horarios este día. Prueba con otro.
    </p>
    <div v-else-if="data" class="slots" role="group" aria-label="Horarios disponibles">
      <button
        v-for="s in slots"
        :key="s.start"
        type="button"
        class="slot"
        :class="{ on: chosen === s.start }"
        :aria-pressed="chosen === s.start"
        @click="pick(s)"
      >
        {{ formatTime(s.start, tz) }}
      </button>
    </div>
  </div>
</template>

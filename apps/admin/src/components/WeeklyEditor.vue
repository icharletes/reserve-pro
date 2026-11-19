<script setup lang="ts">
import { computed } from 'vue';
import { type EditableInterval, WEEKDAYS, clockOptions, toMinutes } from '../lib/schedule-format';

const props = defineProps<{
  modelValue: EditableInterval[];
  /** Muestra vigencia (desde/hasta) por tramo: solo en el horario de un recurso. */
  withValidity?: boolean;
  readonly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: EditableInterval[]] }>();

const starts = clockOptions().slice(0, -1); // el inicio no puede ser 24:00
const ends = clockOptions().slice(1); // el fin no puede ser 00:00

const indexed = computed(() => props.modelValue.map((r, i) => ({ r, i })));
const forDay = (n: number) =>
  indexed.value
    .filter((x) => x.r.weekday === n)
    .sort((a, b) => toMinutes(a.r.start) - toMinutes(b.r.start));

function patch(i: number, change: Partial<EditableInterval>) {
  emit(
    'update:modelValue',
    props.modelValue.map((r, idx) => (idx === i ? { ...r, ...change } : r)),
  );
}
function remove(i: number) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, idx) => idx !== i),
  );
}
function add(weekday: number) {
  const last = forDay(weekday).at(-1)?.r;
  // El tramo nuevo parte donde termina el anterior (o a las 09:00) para no nacer superpuesto.
  const startMin = last ? Math.min(toMinutes(last.end), 1380) : 540;
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  emit('update:modelValue', [
    ...props.modelValue,
    {
      weekday,
      start: fmt(startMin),
      end: fmt(Math.min(startMin + 240, 1440)),
      validFrom: null,
      validTo: null,
    },
  ]);
}
</script>

<template>
  <div>
    <div v-for="d in WEEKDAYS" :key="d.n" class="day-row">
      <strong>{{ d.label }}</strong>
      <div>
        <p v-if="forDay(d.n).length === 0" class="muted" style="margin: 0 0 0.3rem">Cerrado</p>
        <div v-for="({ r, i }, k) in forDay(d.n)" :key="i" class="interval">
          <select
            :aria-label="`${d.label} tramo ${k + 1}: inicio`"
            :value="r.start"
            :disabled="readonly"
            @change="patch(i, { start: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="o in starts" :key="o" :value="o">{{ o }}</option>
          </select>
          <span aria-hidden="true">a</span>
          <select
            :aria-label="`${d.label} tramo ${k + 1}: fin`"
            :value="r.end"
            :disabled="readonly"
            @change="patch(i, { end: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="o in ends" :key="o" :value="o">{{ o }}</option>
          </select>
          <template v-if="withValidity">
            <input
              type="date"
              :aria-label="`${d.label} tramo ${k + 1}: vigente desde`"
              :value="r.validFrom ?? ''"
              :disabled="readonly"
              @change="patch(i, { validFrom: ($event.target as HTMLInputElement).value || null })"
            />
            <input
              type="date"
              :aria-label="`${d.label} tramo ${k + 1}: vigente hasta`"
              :value="r.validTo ?? ''"
              :disabled="readonly"
              @change="patch(i, { validTo: ($event.target as HTMLInputElement).value || null })"
            />
          </template>
          <button
            v-if="!readonly"
            type="button"
            class="small danger"
            :aria-label="`Quitar ${d.label} tramo ${k + 1}`"
            @click="remove(i)"
          >
            Quitar
          </button>
        </div>
        <button v-if="!readonly" type="button" class="small" @click="add(d.n)">
          + Agregar tramo
        </button>
      </div>
    </div>
    <p v-if="withValidity" class="muted" style="margin-top: 0.5rem">
      La vigencia es opcional: sin fechas el tramo rige siempre. Las fechas son inclusivas.
    </p>
  </div>
</template>

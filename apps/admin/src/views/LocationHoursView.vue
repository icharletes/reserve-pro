<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import OverridesPanel from '../components/OverridesPanel.vue';
import WeeklyEditor from '../components/WeeklyEditor.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { type EditableInterval, validateWeekly } from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const id = String(route.params['id']);
const rows = ref<EditableInterval[]>([]);
const locationName = ref('');
const timezone = ref<string | undefined>(undefined);
const loadError = ref<string | null>(null);
const saved = ref(false);
const { loading, error, run } = useAsyncAction();
const canWrite = computed(() => auth.can('schedules:write'));
const problem = computed(() => validateWeekly(rows.value));

onMounted(async () => {
  try {
    const [loc, hours] = await Promise.all([api.getLocation(id), api.getBusinessHours(id)]);
    locationName.value = loc.name;
    timezone.value = loc.effectiveTimezone;
    rows.value = hours.intervals;
  } catch {
    loadError.value = 'No se pudo cargar el horario.';
  }
});

async function save() {
  if (problem.value) return;
  saved.value = false;
  const res = await run(() => api.setBusinessHours(id, { intervals: rows.value }));
  if (res) {
    rows.value = res.intervals;
    saved.value = true;
  }
}
</script>

<template>
  <p><RouterLink to="/locations">← Sucursales</RouterLink></p>
  <h1>Horario de {{ locationName || 'la sucursal' }}</h1>
  <p v-if="timezone" class="muted">
    Horas en la zona horaria <strong>{{ timezone }}</strong>. Un día sin tramos está cerrado.
  </p>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
  <AlertBox v-if="saved" kind="success">Horario guardado.</AlertBox>

  <section class="card" aria-labelledby="semanal">
    <h2 id="semanal" style="margin-top: 0">Horario semanal</h2>
    <WeeklyEditor v-model="rows" :readonly="!canWrite" />
    <p v-if="problem" role="alert" class="field-error">{{ problem }}</p>
    <button
      v-if="canWrite"
      class="primary"
      type="button"
      style="width: auto; margin-top: 0.75rem"
      :disabled="loading || !!problem"
      @click="save"
    >
      {{ loading ? 'Guardando…' : 'Guardar horario' }}
    </button>
  </section>

  <OverridesPanel scope="locations" :id="id" :can-write="canWrite" :timezone="timezone" />
  <p><RouterLink to="/holidays">Administrar feriados de la empresa</RouterLink></p>
</template>

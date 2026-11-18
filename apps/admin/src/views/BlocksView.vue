<script setup lang="ts">
import type { BlockKind, BlockView, ResourceView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { usePagedList } from '../composables/use-paged-list';
import { datetimeLocalToIso } from '../lib/schedule-format';
import { useAuthStore } from '../stores/auth';

const KINDS: { value: BlockKind; label: string }[] = [
  { value: 'time_off', label: 'Ausencia / vacaciones' },
  { value: 'maintenance', label: 'Mantenimiento' },
  { value: 'break', label: 'Descanso' },
  { value: 'manual', label: 'Bloqueo manual' },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

const auth = useAuthStore();
const list = usePagedList((cursor) => api.listBlocks({ limit: 50, ...(cursor ? { cursor } : {}) }));
const resources = ref<ResourceView[]>([]);
const form = useAsyncAction();
const action = useAsyncAction();
const selected = ref<string[]>([]);
const kind = ref<BlockKind>('time_off');
const startAt = ref('');
const endAt = ref('');
const reason = ref('');
const resName = (id: string) => resources.value.find((r) => r.id === id)?.name ?? '—';
const fmt = (iso: string) => new Date(iso).toLocaleString();

async function create() {
  const s = datetimeLocalToIso(startAt.value);
  const e = datetimeLocalToIso(endAt.value);
  if (!s || !e || selected.value.length === 0) return;
  const res = await form.run(() =>
    api.createBlocks({
      resourceIds: selected.value,
      kind: kind.value,
      startAt: s,
      endAt: e,
      reason: reason.value.trim() || null,
    }),
  );
  if (res) {
    selected.value = [];
    startAt.value = '';
    endAt.value = '';
    reason.value = '';
    await list.reload();
  }
}
async function remove(b: BlockView) {
  await action.run(() => api.deleteBlock(b.id));
  await list.reload();
}

onMounted(async () => {
  await Promise.all([
    list.reload(),
    api.listResources({ limit: 100 }).then((p) => (resources.value = p.items)),
  ]);
});
</script>

<template>
  <h1>Bloqueos</h1>
  <p class="muted">
    Ausencias, mantenimiento o descansos puntuales. Las horas se ingresan en la hora de tu
    navegador.
  </p>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>
  <AlertBox v-if="action.error.value" kind="error">{{ action.error.value }}</AlertBox>

  <form v-if="auth.can('blocks:write')" class="card" novalidate @submit.prevent="create">
    <h2 style="margin-top: 0">Nuevo bloqueo</h2>
    <AlertBox v-if="form.error.value" kind="error">{{ form.error.value }}</AlertBox>
    <fieldset class="checklist" style="border: 0; padding: 0; margin-bottom: 0.75rem">
      <legend><strong>Recursos a bloquear</strong></legend>
      <label v-for="r in resources.filter((x) => x.isActive)" :key="r.id"
        ><input v-model="selected" type="checkbox" :value="r.id" /> {{ r.name }}</label
      >
    </fieldset>
    <div class="row">
      <div class="field">
        <label for="b-kind">Tipo</label
        ><select id="b-kind" v-model="kind">
          <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </div>
      <div class="field">
        <label for="b-start">Desde</label
        ><input id="b-start" v-model="startAt" type="datetime-local" />
      </div>
      <div class="field">
        <label for="b-end">Hasta</label><input id="b-end" v-model="endAt" type="datetime-local" />
      </div>
    </div>
    <FormField
      v-model="reason"
      label="Motivo (opcional)"
      :error="form.fieldErrors.value['reason']"
    />
    <p v-if="form.fieldErrors.value['endAt']" role="alert" class="field-error">
      {{ form.fieldErrors.value['endAt'] }}
    </p>
    <button
      class="primary"
      type="submit"
      style="width: auto"
      :disabled="
        form.loading.value ||
        selected.length === 0 ||
        !datetimeLocalToIso(startAt) ||
        !datetimeLocalToIso(endAt)
      "
    >
      Bloquear
    </button>
  </form>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Recurso</th>
          <th>Tipo</th>
          <th>Desde</th>
          <th>Hasta</th>
          <th>Motivo</th>
          <th v-if="auth.can('blocks:write')"><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in list.items.value" :key="b.id">
          <td>{{ resName(b.resourceId) }}</td>
          <td>{{ kindLabel(b.kind) }}</td>
          <td>{{ fmt(b.startAt) }}</td>
          <td>{{ fmt(b.endAt) }}</td>
          <td>{{ b.reason ?? '—' }}</td>
          <td v-if="auth.can('blocks:write')">
            <button
              type="button"
              class="small danger"
              :disabled="action.loading.value"
              @click="remove(b)"
            >
              Quitar
            </button>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="6" class="muted">Sin bloqueos.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>
</template>

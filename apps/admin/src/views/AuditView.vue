<script setup lang="ts">
import type { AuditLogView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';

const items = ref<AuditLogView[]>([]);
const nextCursor = ref<string | null>(null);
const action = ref('');
const { loading, error, run } = useAsyncAction();

async function load(reset: boolean) {
  await run(async () => {
    const page = await api.listAuditLogs({
      limit: 25,
      ...(action.value.trim() ? { action: action.value.trim() } : {}),
      ...(!reset && nextCursor.value ? { cursor: nextCursor.value } : {}),
    });
    items.value = reset ? page.items : [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  });
}
onMounted(() => load(true));
</script>

<template>
  <h1>Auditoría</h1>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
  <form class="row" novalidate @submit.prevent="load(true)">
    <div style="flex: 1; min-width: 220px"><FormField v-model="action" label="Filtrar por acción" hint="Ej.: tenant.updated, member.updated" /></div>
    <div class="field"><button type="submit" :disabled="loading">Filtrar</button></div>
  </form>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Fecha</th><th>Acción</th><th>Quién</th><th>Entidad</th></tr></thead>
      <tbody>
        <tr v-for="i in items" :key="i.id">
          <td>{{ new Date(i.createdAt).toLocaleString() }}</td>
          <td><code>{{ i.action }}</code></td>
          <td>{{ i.actorName ?? '—' }}</td>
          <td>{{ i.entityType }}</td>
        </tr>
        <tr v-if="!loading && items.length === 0"><td colspan="4" class="muted">Sin registros.</td></tr>
      </tbody>
    </table>
  </div>
  <p v-if="nextCursor"><button type="button" :disabled="loading" @click="load(false)">Cargar más</button></p>
</template>

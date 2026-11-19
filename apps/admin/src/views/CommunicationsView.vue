<script setup lang="ts">
import type { NotificationView } from '@reservepro/contracts';
import { onMounted, ref, watch } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { usePagedList } from '../composables/use-paged-list';
import { NOTIFICATION_STATUS_LABELS, notificationTypeLabel } from '../lib/notifications';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const status = ref<NotificationView['status'] | ''>('');
const list = usePagedList((cursor) =>
  api.listNotifications({
    limit: 50,
    ...(status.value ? { status: status.value } : {}),
    ...(cursor ? { cursor } : {}),
  }),
);
const retry = useAsyncAction();
const notice = ref<string | null>(null);
const fmt = (iso: string) => new Date(iso).toLocaleString();

async function resend(n: NotificationView) {
  notice.value = null;
  const res = await retry.run(() => api.retryNotification(n.id));
  if (res) {
    notice.value = `Reintento en cola: se enviará en unos segundos a ${n.recipient}.`;
    await list.reload();
  }
}

watch(status, () => list.reload());
onMounted(() => list.reload());
</script>

<template>
  <h1>Comunicaciones</h1>
  <p class="muted">
    Emails enviados a tus clientes: confirmaciones, cambios, cancelaciones y recordatorios. Los
    envíos fallidos se reintentan solos durante unos 30 minutos; después puedes reintentarlos aquí.
  </p>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>
  <AlertBox v-if="retry.error.value" kind="error">{{ retry.error.value }}</AlertBox>
  <AlertBox v-if="notice" kind="info">{{ notice }}</AlertBox>

  <div class="field" style="max-width: 16rem">
    <label for="n-status">Estado</label>
    <select id="n-status" v-model="status">
      <option value="">Todos</option>
      <option v-for="(label, key) in NOTIFICATION_STATUS_LABELS" :key="key" :value="key">
        {{ label }}
      </option>
    </select>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Mensaje</th>
          <th>Cliente</th>
          <th>Reserva</th>
          <th>Estado</th>
          <th v-if="auth.can('notifications:resend')"><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="n in list.items.value" :key="n.id">
          <td>{{ fmt(n.sentAt ?? n.createdAt) }}</td>
          <td>
            {{ notificationTypeLabel(n.type) }}
            <br /><span class="muted small">{{ n.subject ?? '' }}</span>
          </td>
          <td>
            {{ n.customerName ?? '—' }}<br /><span class="muted small">{{ n.recipient }}</span>
          </td>
          <td>
            <RouterLink v-if="n.reservationId" :to="`/reservations/${n.reservationId}`">{{
              n.reservationCode
            }}</RouterLink>
          </td>
          <td>
            <span class="status" :class="`n-${n.status}`">{{
              NOTIFICATION_STATUS_LABELS[n.status]
            }}</span>
            <span v-if="n.attempts > 1" class="muted small"> · {{ n.attempts }} intentos</span>
            <br v-if="n.lastError" /><span v-if="n.lastError" class="muted small">{{
              n.lastError
            }}</span>
          </td>
          <td v-if="auth.can('notifications:resend')">
            <button
              v-if="n.status === 'failed'"
              type="button"
              class="small"
              :disabled="retry.loading.value"
              @click="resend(n)"
            >
              Reintentar
            </button>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="6" class="muted">Sin comunicaciones.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>
</template>

<script setup lang="ts">
import type { ReservationView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { describeError } from '../lib/errors';
import { customerName, formatLocalTime, statusLabel, zonedMidnight } from '../lib/reservations';
import { addDays, todayIn } from '../lib/schedule-format';

const auth = useAuthStore();
const resent = ref(false);
const { loading, error, run } = useAsyncAction();

const today = ref<ReservationView[]>([]);
const todayError = ref<string | null>(null);
onMounted(async () => {
  if (!auth.canAny('reservations:read', 'reservations:read:own')) return;
  const tz = auth.me?.tenant?.timezone ?? 'UTC';
  const day = todayIn(tz);
  try {
    today.value = (
      await api.listReservations({
        from: zonedMidnight(day, tz).toISOString(),
        to: zonedMidnight(addDays(day, 1), tz).toISOString(),
        limit: 50,
      })
    ).items.filter((r) => r.status !== 'cancelled');
  } catch (e) {
    todayError.value = describeError(e);
  }
});

async function resend() {
  const ok = await run(async () => {
    await api.resendVerification();
    return true;
  });
  if (ok) resent.value = true;
}
</script>

<template>
  <h1>Hola, {{ auth.user?.fullName }}</h1>

  <AlertBox v-if="auth.user && !auth.user.emailVerified" kind="info">
    <strong>Verifica tu email.</strong> Hasta entonces no podrás invitar a otras personas.
    <template v-if="resent"> Te enviamos un correo nuevo.</template>
    <button v-else type="button" class="small" :disabled="loading" @click="resend">
      Reenviar correo
    </button>
    <span v-if="error" role="alert"> {{ error }}</span>
  </AlertBox>

  <section class="card" aria-labelledby="empresa">
    <h2 id="empresa" style="margin-top: 0">{{ auth.me?.tenant?.name }}</h2>
    <p class="muted">
      <span>Tu rol: {{ auth.me?.roles.join(', ') }}</span> ·
      <span>Zona horaria: {{ auth.me?.tenant?.timezone }}</span> ·
      <span>Moneda: {{ auth.me?.tenant?.currency }}</span>
    </p>
  </section>

  <section v-if="auth.canAny('reservations:read', 'reservations:read:own')" class="card">
    <h2 style="margin-top: 0">Reservas de hoy</h2>
    <p v-if="todayError" role="alert" class="field-error">{{ todayError }}</p>
    <ul v-else-if="today.length" class="timeline">
      <li v-for="r in today" :key="r.id">
        <RouterLink :to="`/reservations/${r.id}`">{{
          formatLocalTime(r.startAt, r.timeZone)
        }}</RouterLink>
        · {{ customerName(r.customer) }} · {{ r.items.map((i) => i.serviceName).join(', ') }}
        <span class="status" :class="r.status">{{ statusLabel(r.status) }}</span>
      </li>
    </ul>
    <p v-else class="muted">No hay reservas para hoy.</p>
    <p class="actions">
      <RouterLink
        v-if="auth.can('reservations:create')"
        class="btn btn-primary"
        to="/reservations/new"
        >Nueva reserva</RouterLink
      >
      <RouterLink to="/reservations">Ver todas</RouterLink>
    </p>
  </section>
</template>

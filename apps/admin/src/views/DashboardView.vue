<script setup lang="ts">
import { ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const resent = ref(false);
const { loading, error, run } = useAsyncAction();

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
    <button v-else type="button" class="small" :disabled="loading" @click="resend">Reenviar correo</button>
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

  <section class="card">
    <h2 style="margin-top: 0">Próximamente</h2>
    <p class="muted">Servicios, profesionales, agenda y reservas llegan en las siguientes fases.</p>
  </section>
</template>

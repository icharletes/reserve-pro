<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import { api } from '../api';
import { describeError } from '../lib/errors';
import { takeFragmentToken } from '../lib/fragment-token';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const token = takeFragmentToken();
const state = ref<'loading' | 'ok' | 'error'>(token ? 'loading' : 'error');
const message = ref(token ? '' : 'El enlace no es válido. Pide que te lo reenviemos desde el panel.');

onMounted(async () => {
  if (!token) return;
  try {
    await api.verifyEmail(token);
    state.value = 'ok';
    if (auth.isAuthenticated) await auth.refreshMe(); // el banner de "verifica tu email" desaparece
  } catch (e) {
    state.value = 'error';
    message.value = describeError(e);
  }
});
</script>

<template>
  <h1>Verificación de email</h1>
  <p v-if="state === 'loading'" role="status">Verificando…</p>
  <AlertBox v-else-if="state === 'ok'" kind="success">Tu email quedó verificado. ¡Gracias!</AlertBox>
  <AlertBox v-else kind="error">{{ message }}</AlertBox>
  <p><RouterLink :to="auth.isAuthenticated ? '/' : '/login'">{{ auth.isAuthenticated ? 'Ir al panel' : 'Iniciar sesión' }}</RouterLink></p>
</template>

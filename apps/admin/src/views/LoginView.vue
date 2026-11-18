<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { safeRedirect } from '../lib/safe-redirect';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const { loading, error, fieldErrors, run } = useAsyncAction();

async function submit() {
  const ok = await run(async () => {
    await auth.login(email.value.trim(), password.value);
    return true;
  });
  if (!ok) return;
  // Con varias empresas y ninguna activa, primero se elige; si no, se vuelve al destino pedido (solo rutas internas).
  await router.push(
    auth.hasTenant ? safeRedirect(route.query['redirect']) : { name: 'select-tenant' },
  );
}
</script>

<template>
  <h1>Iniciar sesión</h1>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
  <form class="card" novalidate @submit.prevent="submit">
    <FormField
      v-model="email"
      label="Email"
      type="email"
      autocomplete="username"
      required
      :error="fieldErrors['email']"
    />
    <FormField
      v-model="password"
      label="Contraseña"
      type="password"
      autocomplete="current-password"
      required
      :error="fieldErrors['password']"
    />
    <button class="primary" type="submit" :disabled="loading || !email || !password">
      {{ loading ? 'Ingresando…' : 'Ingresar' }}
    </button>
  </form>
  <p><RouterLink to="/forgot-password">¿Olvidaste tu contraseña?</RouterLink></p>
  <p>¿No tienes cuenta? <RouterLink to="/register">Crea tu empresa</RouterLink></p>
</template>

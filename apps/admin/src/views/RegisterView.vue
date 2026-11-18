<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const fullName = ref('');
const email = ref('');
const password = ref('');
const businessName = ref('');
const { loading, error, fieldErrors, run } = useAsyncAction();

async function submit() {
  const ok = await run(async () => {
    await auth.register({
      fullName: fullName.value.trim(),
      email: email.value.trim(),
      password: password.value,
      businessName: businessName.value.trim(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Santiago',
      currency: 'CLP',
    });
    return true;
  });
  if (ok) await router.push({ name: 'dashboard' });
}
</script>

<template>
  <h1>Crea tu empresa</h1>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
  <form class="card" novalidate @submit.prevent="submit">
    <FormField
      v-model="businessName"
      label="Nombre del negocio"
      autocomplete="organization"
      required
      :error="fieldErrors['businessName'] ?? fieldErrors['slug']"
    />
    <FormField
      v-model="fullName"
      label="Tu nombre"
      autocomplete="name"
      required
      :error="fieldErrors['fullName']"
    />
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
      autocomplete="new-password"
      required
      hint="Mínimo 10 caracteres."
      :error="fieldErrors['password']"
    />
    <button
      class="primary"
      type="submit"
      :disabled="loading || !email || !password || !fullName || !businessName"
    >
      {{ loading ? 'Creando…' : 'Crear cuenta' }}
    </button>
  </form>
  <p>¿Ya tienes cuenta? <RouterLink to="/login">Inicia sesión</RouterLink></p>
</template>

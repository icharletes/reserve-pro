<script setup lang="ts">
import { ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';
import { takeFragmentToken } from '../lib/fragment-token';

// Se lee UNA vez y se borra de la URL (no queda en la barra ni en el historial).
const token = takeFragmentToken();
const password = ref('');
const confirm = ref('');
const done = ref(false);
const { loading, error, fieldErrors, run } = useAsyncAction();
const mismatch = ref(false);

async function submit() {
  mismatch.value = password.value !== confirm.value;
  if (mismatch.value || !token) return;
  const ok = await run(async () => {
    await api.resetPassword({ token, password: password.value });
    return true;
  });
  if (ok) done.value = true;
}
</script>

<template>
  <h1>Elige una contraseña nueva</h1>
  <AlertBox v-if="!token" kind="error">
    El enlace no es válido. Solicita uno nuevo desde <RouterLink to="/forgot-password">recuperar contraseña</RouterLink>.
  </AlertBox>
  <AlertBox v-else-if="done" kind="success">
    Listo: tu contraseña fue actualizada y cerramos tus otras sesiones. <RouterLink to="/login">Inicia sesión</RouterLink>.
  </AlertBox>
  <template v-else>
    <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
    <form class="card" novalidate @submit.prevent="submit">
      <FormField v-model="password" label="Contraseña nueva" type="password" autocomplete="new-password" required hint="Mínimo 10 caracteres." :error="fieldErrors['password']" />
      <FormField v-model="confirm" label="Repite la contraseña" type="password" autocomplete="new-password" required :error="mismatch ? 'Las contraseñas no coinciden.' : undefined" />
      <button class="primary" type="submit" :disabled="loading || !password || !confirm">{{ loading ? 'Guardando…' : 'Guardar contraseña' }}</button>
    </form>
  </template>
</template>

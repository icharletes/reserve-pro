<script setup lang="ts">
import { ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';

const email = ref('');
const sent = ref(false);
const { loading, error, fieldErrors, run } = useAsyncAction();

async function submit() {
  const ok = await run(async () => {
    await api.forgotPassword({ email: email.value.trim() });
    return true;
  });
  if (ok) sent.value = true;
}
</script>

<template>
  <h1>Recuperar contraseña</h1>
  <!-- El mensaje es el MISMO exista o no la cuenta: no revela qué emails están registrados. -->
  <AlertBox v-if="sent" kind="success">
    Si existe una cuenta con ese email, te enviamos un enlace para elegir una contraseña nueva.
    Revisa tu correo.
  </AlertBox>
  <template v-else>
    <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
    <form class="card" novalidate @submit.prevent="submit">
      <FormField
        v-model="email"
        label="Email de tu cuenta"
        type="email"
        autocomplete="username"
        required
        :error="fieldErrors['email']"
      />
      <button class="primary" type="submit" :disabled="loading || !email">
        {{ loading ? 'Enviando…' : 'Enviar enlace' }}
      </button>
    </form>
  </template>
  <p><RouterLink to="/login">Volver a iniciar sesión</RouterLink></p>
</template>

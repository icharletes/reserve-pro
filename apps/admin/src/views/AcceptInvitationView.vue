<script setup lang="ts">
import type { InvitationPreview } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';
import { describeError } from '../lib/errors';
import { takeFragmentToken } from '../lib/fragment-token';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const token = takeFragmentToken();
const preview = ref<InvitationPreview | null>(null);
const loadError = ref<string | null>(token ? null : 'El enlace no es válido.');
const joined = ref(false);
const fullName = ref('');
const password = ref('');
const { loading, error, fieldErrors, run } = useAsyncAction();

onMounted(async () => {
  if (!token) return;
  try {
    preview.value = await api.previewInvitation(token);
  } catch (e) {
    loadError.value = describeError(e);
  }
});

async function accept() {
  if (!token || !preview.value) return;
  const result = await run(() =>
    api.acceptInvitation({
      token,
      ...(preview.value!.accountExists ? {} : { fullName: fullName.value.trim(), password: password.value }),
    }),
  );
  if (!result) return;
  if (result.outcome === 'account_created' && result.auth) {
    await auth.apply(result.auth); // la sesión ya quedó iniciada
    await router.push({ name: 'dashboard' });
  } else {
    joined.value = true; // la cuenta existía: debe iniciar sesión con su contraseña
  }
}
</script>

<template>
  <h1>Invitación</h1>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
  <p v-else-if="!preview" role="status">Cargando invitación…</p>
  <AlertBox v-else-if="joined" kind="success">
    Te uniste a <strong>{{ preview.tenantName }}</strong
    >. <RouterLink to="/login">Inicia sesión</RouterLink> con tu contraseña de siempre.
  </AlertBox>
  <template v-else>
    <p>
      Te invitaron a unirte a <strong>{{ preview.tenantName }}</strong> como <strong>{{ preview.roleName }}</strong
      >.
    </p>
    <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
    <form class="card" novalidate @submit.prevent="accept">
      <FormField :model-value="preview.email" label="Email" type="email" disabled />
      <template v-if="!preview.accountExists">
        <FormField v-model="fullName" label="Tu nombre" autocomplete="name" required :error="fieldErrors['fullName']" />
        <FormField v-model="password" label="Crea una contraseña" type="password" autocomplete="new-password" required hint="Mínimo 10 caracteres." :error="fieldErrors['password']" />
      </template>
      <p v-else class="muted">Ya tienes una cuenta con este email: solo confirma para unirte.</p>
      <button class="primary" type="submit" :disabled="loading || (!preview.accountExists && (!fullName || !password))">
        {{ loading ? 'Procesando…' : preview.accountExists ? 'Unirme a la empresa' : 'Crear cuenta y unirme' }}
      </button>
    </form>
  </template>
</template>

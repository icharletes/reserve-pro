<script setup lang="ts">
import { useRouter } from 'vue-router';
import AlertBox from '../components/AlertBox.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const { loading, error, run } = useAsyncAction();

async function choose(tenantId: string) {
  const ok = await run(async () => {
    await auth.switchTenant(tenantId);
    return true;
  });
  if (ok) await router.push({ name: 'dashboard' });
}
</script>

<template>
  <h1>Elige una empresa</h1>
  <AlertBox v-if="error" kind="error">{{ error }}</AlertBox>
  <p v-if="auth.memberships.length === 0" class="muted">Tu cuenta no pertenece a ninguna empresa activa.</p>
  <ul class="card" style="list-style: none; padding: 0.5rem 1.25rem">
    <li v-for="m in auth.memberships" :key="m.tenantId" style="padding: 0.4rem 0">
      <button type="button" :disabled="loading" :aria-current="m.tenantId === auth.activeTenantId ? 'true' : undefined" @click="choose(m.tenantId)">
        {{ m.tenantName }}
      </button>
      <span class="muted"> · {{ m.tenantSlug }}</span>
    </li>
  </ul>
  <button v-if="auth.hasTenant" type="button" class="link" @click="router.push({ name: 'dashboard' })">Volver al panel</button>
</template>

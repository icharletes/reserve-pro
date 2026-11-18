<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';
import { useAuthStore } from './stores/auth';

const route = useRoute();
const auth = useAuthStore();
// Las pantallas de visitante (login, enlaces del email) van sin la barra superior.
const withShell = computed(
  () => auth.isAuthenticated && auth.hasTenant && !route.meta.public && !route.meta.guestOnly && !route.meta.noTenant,
);
</script>

<template>
  <div v-if="!auth.ready" class="splash" role="status" aria-live="polite">Cargando…</div>
  <AppShell v-else-if="withShell"><RouterView /></AppShell>
  <main v-else class="container narrow"><RouterView /></main>
</template>

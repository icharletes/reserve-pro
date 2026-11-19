<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

async function logout() {
  await auth.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <header class="topbar">
    <strong class="brand">ReservePro</strong>
    <nav aria-label="Principal">
      <RouterLink to="/">Inicio</RouterLink>
      <RouterLink v-if="auth.canAny('calendar:read', 'calendar:read:own')" to="/calendar"
        >Calendario</RouterLink
      >
      <RouterLink
        v-if="auth.canAny('reservations:read', 'reservations:read:own')"
        to="/reservations"
        >Reservas</RouterLink
      >
      <RouterLink v-if="auth.can('customers:read')" to="/customers">Clientes</RouterLink>
      <RouterLink v-if="auth.can('locations:read')" to="/locations">Sucursales</RouterLink>
      <RouterLink v-if="auth.can('services:read')" to="/services">Servicios</RouterLink>
      <RouterLink v-if="auth.can('resources:read')" to="/resources">Recursos</RouterLink>
      <RouterLink v-if="auth.can('blocks:read')" to="/blocks">Bloqueos</RouterLink>
      <RouterLink v-if="auth.can('schedules:read')" to="/holidays">Feriados</RouterLink>
      <RouterLink v-if="auth.can('members:read')" to="/members">Equipo</RouterLink>
      <RouterLink v-if="auth.can('audit:read')" to="/audit">Auditoría</RouterLink>
    </nav>
    <div class="topbar-right">
      <span class="tenant" :title="auth.user?.email">{{ auth.activeMembership?.tenantName }}</span>
      <RouterLink v-if="auth.memberships.length > 1" to="/select-tenant"
        >Cambiar empresa</RouterLink
      >
      <button type="button" class="link" @click="logout">Cerrar sesión</button>
    </div>
  </header>
  <main class="container"><slot /></main>
</template>

<script setup lang="ts">
defineProps<{ kind?: 'error' | 'success' | 'info' }>();
</script>

<template>
  <!-- role=alert anuncia el mensaje a lectores de pantalla en cuanto aparece -->
  <div :class="['alert', `alert-${kind ?? 'info'}`]" :role="kind === 'error' ? 'alert' : 'status'">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ name: string }>();
// Isla de ejemplo: demuestra que Vue se hidrata en el portal. El flujo de reserva real llega en la Fase 4.
const notified = ref(false);
</script>

<template>
  <section aria-labelledby="reserva">
    <h2 id="reserva">Reserva online</h2>
    <p>La reserva online de <strong>{{ name }}</strong> estará disponible muy pronto.</p>
    <button type="button" :aria-pressed="notified" @click="notified = !notified">
      {{ notified ? 'Te avisaremos' : 'Avísame cuando esté listo' }}
    </button>
  </section>
</template>

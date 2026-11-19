<script setup lang="ts">
import type { LocationView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { usePagedList } from '../composables/use-paged-list';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const list = usePagedList((cursor) =>
  api.listLocations({ limit: 50, ...(cursor ? { cursor } : {}) }),
);
const form = useAsyncAction();
const action = useAsyncAction();

const editing = ref<LocationView | 'new' | null>(null);
const name = ref('');
const city = ref('');
const phone = ref('');
const email = ref('');
const timezone = ref('');

function startEdit(l: LocationView | 'new') {
  editing.value = l;
  const v = l === 'new' ? null : l;
  name.value = v?.name ?? '';
  city.value = v?.address.city ?? '';
  phone.value = v?.phone ?? '';
  email.value = v?.email ?? '';
  timezone.value = v?.timezone ?? '';
}

async function save() {
  const payload = {
    name: name.value.trim(),
    address: city.value.trim() ? { city: city.value.trim() } : {},
    phone: phone.value.trim() || null,
    email: email.value.trim() || null,
    timezone: timezone.value.trim() || null,
  };
  const target = editing.value;
  const ok = await form.run(async () => {
    if (target === 'new') await api.createLocation(payload);
    else if (target) await api.updateLocation(target.id, payload);
    return true;
  });
  if (ok) {
    editing.value = null;
    await list.reload();
  }
}

async function toggle(l: LocationView) {
  await action.run(() => api.updateLocation(l.id, { isActive: !l.isActive }));
  await list.reload();
}

async function remove(l: LocationView) {
  if (!window.confirm(`¿Eliminar la sucursal "${l.name}"? Esta acción no se puede deshacer.`))
    return;
  await action.run(() => api.deleteLocation(l.id));
  await list.reload();
}

onMounted(list.reload);
</script>

<template>
  <h1>Sucursales</h1>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>
  <AlertBox v-if="action.error.value" kind="error">{{ action.error.value }}</AlertBox>

  <p v-if="auth.can('locations:write') && !editing">
    <button type="button" @click="startEdit('new')">+ Nueva sucursal</button>
  </p>

  <form v-if="editing" class="card" novalidate @submit.prevent="save">
    <h2 style="margin-top: 0">{{ editing === 'new' ? 'Nueva sucursal' : 'Editar sucursal' }}</h2>
    <AlertBox v-if="form.error.value" kind="error">{{ form.error.value }}</AlertBox>
    <FormField v-model="name" label="Nombre" required :error="form.fieldErrors.value['name']" />
    <FormField v-model="city" label="Ciudad" :error="form.fieldErrors.value['address']" />
    <FormField
      v-model="phone"
      label="Teléfono"
      type="tel"
      :error="form.fieldErrors.value['phone']"
    />
    <FormField
      v-model="email"
      label="Email"
      type="email"
      :error="form.fieldErrors.value['email']"
    />
    <FormField
      v-model="timezone"
      label="Zona horaria (opcional)"
      hint="Ej.: America/Santiago. Vacío = usa la de la empresa."
      :error="form.fieldErrors.value['timezone']"
    />
    <div class="actions">
      <button
        class="primary"
        type="submit"
        :disabled="form.loading.value || !name"
        style="width: auto"
      >
        Guardar
      </button>
      <button type="button" @click="editing = null">Cancelar</button>
    </div>
  </form>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Nombre</th>
          <th>Zona horaria</th>
          <th>Estado</th>
          <th><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="l in list.items.value" :key="l.id">
          <td>
            {{ l.name }}<br /><span class="muted">{{ l.address.city }}</span>
          </td>
          <td>
            {{ l.effectiveTimezone }}<span v-if="!l.timezone" class="muted"> (de la empresa)</span>
          </td>
          <td>
            <span :class="['badge', !l.isActive && 'off']">{{
              l.isActive ? 'Activa' : 'Desactivada'
            }}</span>
          </td>
          <td class="actions">
            <RouterLink v-if="auth.can('schedules:read')" :to="`/locations/${l.id}/hours`"
              >Horario</RouterLink
            >
            <template v-if="auth.can('locations:write')">
              <button type="button" class="small" @click="startEdit(l)">Editar</button>
              <button
                type="button"
                class="small"
                :disabled="action.loading.value"
                @click="toggle(l)"
              >
                {{ l.isActive ? 'Desactivar' : 'Reactivar' }}
              </button>
              <button
                type="button"
                class="small danger"
                :disabled="action.loading.value"
                @click="remove(l)"
              >
                Eliminar
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="4" class="muted">Aún no hay sucursales.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>
</template>

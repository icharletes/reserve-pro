<script setup lang="ts">
import type { CustomerView } from '@reservepro/contracts';
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { usePagedList } from '../composables/use-paged-list';
import { customerName, normalizePhone } from '../lib/reservations';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const q = ref('');
const list = usePagedList((cursor) =>
  api.listCustomers({
    limit: 50,
    ...(q.value.trim() ? { q: q.value.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  }),
);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(() => list.reload(), 250);
});

const editing = ref<CustomerView | 'new' | null>(null);
const form = ref({ firstName: '', lastName: '', phone: '', email: '', internalNotes: '' });
const save = useAsyncAction();
const phoneE164 = computed(() => normalizePhone(form.value.phone));
const phoneInvalid = computed(() => form.value.phone.trim() !== '' && !phoneE164.value);
const canSave = computed(
  () =>
    form.value.firstName.trim() !== '' &&
    !phoneInvalid.value &&
    (!!phoneE164.value || form.value.email.trim() !== ''),
);

function startEdit(c: CustomerView | 'new') {
  editing.value = c;
  form.value =
    c === 'new'
      ? { firstName: '', lastName: '', phone: '', email: '', internalNotes: '' }
      : {
          firstName: c.firstName,
          lastName: c.lastName ?? '',
          phone: c.phoneE164 ?? '',
          email: c.email ?? '',
          internalNotes: c.internalNotes ?? '',
        };
}

async function submit() {
  if (!canSave.value || !editing.value) return;
  const f = form.value;
  const data = {
    firstName: f.firstName.trim(),
    lastName: f.lastName.trim() || null,
    phoneE164: phoneE164.value,
    email: f.email.trim() || null,
    internalNotes: f.internalNotes.trim() || null,
  };
  const target = editing.value;
  const ok = await save.run(() =>
    target === 'new' ? api.createCustomer(data) : api.updateCustomer(target.id, data),
  );
  if (ok) {
    editing.value = null;
    await list.reload();
  }
}

onMounted(() => list.reload());
</script>

<template>
  <h1>Clientes</h1>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>

  <div class="row" style="align-items: flex-end">
    <div class="field" style="flex: 1">
      <label for="c-q">Buscar por nombre, teléfono o email</label>
      <input id="c-q" v-model="q" type="search" autocomplete="off" />
    </div>
    <button v-if="auth.can('customers:write') && !editing" type="button" @click="startEdit('new')">
      + Nuevo cliente
    </button>
  </div>

  <form v-if="editing" class="card" novalidate @submit.prevent="submit">
    <h2 style="margin-top: 0">{{ editing === 'new' ? 'Nuevo cliente' : 'Editar cliente' }}</h2>
    <AlertBox v-if="save.error.value" kind="error">{{ save.error.value }}</AlertBox>
    <div class="row">
      <FormField
        v-model="form.firstName"
        label="Nombre"
        :error="save.fieldErrors.value['firstName']"
      />
      <FormField v-model="form.lastName" label="Apellido (opcional)" />
    </div>
    <div class="row">
      <FormField
        v-model="form.phone"
        label="Teléfono"
        type="tel"
        :error="
          phoneInvalid
            ? 'Teléfono no válido (ej.: +56 9 1234 5678)'
            : save.fieldErrors.value['phoneE164']
        "
      />
      <FormField
        v-model="form.email"
        label="Email"
        type="email"
        :error="save.fieldErrors.value['email']"
      />
    </div>
    <FormField v-model="form.internalNotes" label="Notas internas (opcional)" />
    <p class="muted" style="font-size: 0.85rem">Indica al menos teléfono o email.</p>
    <div class="actions">
      <button
        class="primary"
        type="submit"
        style="width: auto"
        :disabled="!canSave || save.loading.value"
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
          <th>Teléfono</th>
          <th>Email</th>
          <th v-if="auth.can('customers:write')"><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in list.items.value" :key="c.id">
          <td>{{ customerName(c) }}</td>
          <td>{{ c.phoneE164 ?? '—' }}</td>
          <td>{{ c.email ?? '—' }}</td>
          <td v-if="auth.can('customers:write')">
            <button type="button" class="small" @click="startEdit(c)">Editar</button>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="4" class="muted">{{ q ? 'Sin resultados.' : 'Aún no hay clientes.' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>
</template>

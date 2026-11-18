<script setup lang="ts">
import type { LocationView, MemberView, ResourceKind, ResourceView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { usePagedList } from '../composables/use-paged-list';
import { useAuthStore } from '../stores/auth';

const KINDS: { value: ResourceKind; label: string }[] = [
  { value: 'staff', label: 'Profesional' },
  { value: 'room', label: 'Sala / box' },
  { value: 'equipment', label: 'Equipo' },
  { value: 'vehicle', label: 'Vehículo' },
  { value: 'space', label: 'Espacio' },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

const auth = useAuthStore();
const list = usePagedList((cursor) =>
  api.listResources({ limit: 50, ...(cursor ? { cursor } : {}) }),
);
const locations = ref<LocationView[]>([]);
const members = ref<MemberView[]>([]);
const form = useAsyncAction();
const action = useAsyncAction();

const editing = ref<ResourceView | 'new' | null>(null);
const f = ref({
  locationId: '',
  kind: 'staff' as ResourceKind,
  name: '',
  membershipId: '',
  bookable: true,
  auto: true,
  sortOrder: 0,
});
const locName = (id: string) => locations.value.find((l) => l.id === id)?.name ?? '—';

function startEdit(r: ResourceView | 'new') {
  editing.value = r;
  const v = r === 'new' ? null : r;
  f.value = {
    locationId: v?.locationId ?? locations.value.find((l) => l.isActive)?.id ?? '',
    kind: v?.kind ?? 'staff',
    name: v?.name ?? '',
    membershipId: v?.membershipId ?? '',
    bookable: v?.isBookableOnline ?? true,
    auto: v?.autoAssignable ?? true,
    sortOrder: v?.sortOrder ?? 0,
  };
}

async function save() {
  const x = f.value;
  const target = editing.value;
  const ok = await form.run(async () => {
    if (target === 'new') {
      await api.createResource({
        locationId: x.locationId,
        kind: x.kind,
        name: x.name.trim(),
        capacity: 1,
        ...(x.kind === 'staff' && x.membershipId ? { membershipId: x.membershipId } : {}),
        isBookableOnline: x.bookable,
        autoAssignable: x.auto,
        sortOrder: Number(x.sortOrder),
      });
    } else if (target) {
      await api.updateResource(target.id, {
        name: x.name.trim(),
        ...(target.kind === 'staff' ? { membershipId: x.membershipId || null } : {}),
        isBookableOnline: x.bookable,
        autoAssignable: x.auto,
        sortOrder: Number(x.sortOrder),
      });
    }
    return true;
  });
  if (ok) {
    editing.value = null;
    await list.reload();
  }
}

async function toggle(r: ResourceView) {
  await action.run(() => api.updateResource(r.id, { isActive: !r.isActive }));
  await list.reload();
}
async function remove(r: ResourceView) {
  if (!window.confirm(`¿Eliminar "${r.name}" y toda su configuración (horarios, bloqueos)?`))
    return;
  await action.run(() => api.deleteResource(r.id));
  await list.reload();
}

onMounted(async () => {
  await Promise.all([
    list.reload(),
    api.listLocations({ limit: 100 }).then((p) => (locations.value = p.items)),
  ]);
  // Vincular un profesional con su usuario requiere poder ver el equipo; sin ese permiso simplemente no se ofrece.
  if (auth.can('members:read'))
    members.value = (await api.listMembers({ limit: 100 })).items.filter(
      (m) => m.status === 'active',
    );
});
</script>

<template>
  <h1>Profesionales y recursos</h1>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>
  <AlertBox v-if="action.error.value" kind="error">{{ action.error.value }}</AlertBox>
  <p v-if="auth.can('resources:write') && !editing">
    <button type="button" @click="startEdit('new')">+ Nuevo</button>
  </p>

  <form v-if="editing" class="card" novalidate @submit.prevent="save">
    <h2 style="margin-top: 0">
      {{ editing === 'new' ? 'Nuevo profesional o recurso' : 'Editar' }}
    </h2>
    <AlertBox v-if="form.error.value" kind="error">{{ form.error.value }}</AlertBox>
    <div v-if="editing === 'new'" class="row">
      <div class="field" style="flex: 1">
        <label for="r-loc">Sucursal</label>
        <select id="r-loc" v-model="f.locationId">
          <option v-for="l in locations.filter((x) => x.isActive)" :key="l.id" :value="l.id">
            {{ l.name }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="r-kind">Tipo</label>
        <select id="r-kind" v-model="f.kind">
          <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </div>
    </div>
    <p v-else class="muted">
      {{ kindLabel(editing.kind) }} en {{ locName(editing.locationId) }} (la sucursal y el tipo no
      se pueden cambiar).
    </p>
    <FormField v-model="f.name" label="Nombre" required :error="form.fieldErrors.value['name']" />
    <div
      v-if="(editing === 'new' ? f.kind : editing.kind) === 'staff' && members.length > 0"
      class="field"
    >
      <label for="r-mem">Usuario vinculado (opcional)</label>
      <select id="r-mem" v-model="f.membershipId">
        <option value="">Ninguno</option>
        <option v-for="m in members" :key="m.membershipId" :value="m.membershipId">
          {{ m.fullName }} ({{ m.email }})
        </option>
      </select>
      <p class="field-hint">Le permite ver su propia agenda en el calendario.</p>
    </div>
    <div class="checklist" style="margin-bottom: 1rem">
      <label><input v-model="f.bookable" type="checkbox" /> Reservable en línea</label>
      <label><input v-model="f.auto" type="checkbox" /> Asignable automáticamente</label>
    </div>
    <div class="actions">
      <button
        class="primary"
        type="submit"
        style="width: auto"
        :disabled="form.loading.value || !f.name || (editing === 'new' && !f.locationId)"
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
          <th>Tipo</th>
          <th>Sucursal</th>
          <th>Estado</th>
          <th><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in list.items.value" :key="r.id">
          <td>{{ r.name }}</td>
          <td>{{ kindLabel(r.kind) }}</td>
          <td>{{ locName(r.locationId) }}</td>
          <td>
            <span :class="['badge', !r.isActive && 'off']">{{
              r.isActive ? 'Activo' : 'Desactivado'
            }}</span>
          </td>
          <td class="actions">
            <RouterLink v-if="auth.can('schedules:read')" :to="`/resources/${r.id}/schedule`"
              >Horario</RouterLink
            >
            <template v-if="auth.can('resources:write')">
              <button type="button" class="small" @click="startEdit(r)">Editar</button>
              <button
                type="button"
                class="small"
                :disabled="action.loading.value"
                @click="toggle(r)"
              >
                {{ r.isActive ? 'Desactivar' : 'Reactivar' }}
              </button>
              <button
                type="button"
                class="small danger"
                :disabled="action.loading.value"
                @click="remove(r)"
              >
                Eliminar
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="5" class="muted">Aún no hay profesionales ni recursos.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>
</template>

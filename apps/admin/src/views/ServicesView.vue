<script setup lang="ts">
import type { CategoryView, LocationView, ResourceView, ServiceView } from '@reservepro/contracts';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { usePagedList } from '../composables/use-paged-list';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const list = usePagedList((cursor) =>
  api.listServices({ limit: 50, ...(cursor ? { cursor } : {}) }),
);
const categories = ref<CategoryView[]>([]);
const locations = ref<LocationView[]>([]);
const resources = ref<ResourceView[]>([]);
const form = useAsyncAction();
const action = useAsyncAction();
const links = useAsyncAction();

const editing = ref<ServiceView | 'new' | null>(null);
const f = ref({
  name: '',
  description: '',
  categoryId: '',
  durationMinutes: 30,
  bufferBefore: 0,
  bufferAfter: 0,
  price: '',
  confirm: '',
  minNotice: '',
  maxAdvance: '',
  imageUrl: '',
});

const linking = ref<ServiceView | null>(null);
const selLocations = ref<string[]>([]);
const selResources = ref<string[]>([]);
const linkSaved = ref(false);
const newCategory = ref('');

const catName = (id: string | null) => categories.value.find((c) => c.id === id)?.name ?? '—';
// Solo se ofrecen los recursos de las sucursales marcadas (un recurso fuera de ellas no puede prestar el servicio).
const resourceChoices = computed(() =>
  resources.value.filter((r) => r.isActive && selLocations.value.includes(r.locationId)),
);

async function loadRefs() {
  const [c, l, r] = await Promise.all([
    api.listCategories({ limit: 100 }),
    api.listLocations({ limit: 100 }),
    api.listResources({ limit: 100 }),
  ]);
  categories.value = c.items;
  locations.value = l.items;
  resources.value = r.items;
}

function startEdit(s: ServiceView | 'new') {
  editing.value = s;
  linking.value = null;
  const v = s === 'new' ? null : s;
  f.value = {
    name: v?.name ?? '',
    description: v?.description ?? '',
    categoryId: v?.categoryId ?? '',
    durationMinutes: v?.durationMinutes ?? 30,
    bufferBefore: v?.bufferBeforeMinutes ?? 0,
    bufferAfter: v?.bufferAfterMinutes ?? 0,
    price: v?.price ?? '',
    confirm: v?.requiresConfirmation === null || v === null ? '' : String(v.requiresConfirmation),
    minNotice: v?.minNoticeMinutes?.toString() ?? '',
    maxAdvance: v?.maxAdvanceDays?.toString() ?? '',
    imageUrl: v?.imageUrl ?? '',
  };
}

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

async function save() {
  const x = f.value;
  const common = {
    name: x.name.trim(),
    description: x.description.trim() || null,
    categoryId: x.categoryId || null,
    durationMinutes: Number(x.durationMinutes),
    bufferBeforeMinutes: Number(x.bufferBefore),
    bufferAfterMinutes: Number(x.bufferAfter),
    price: x.price.trim(),
    requiresConfirmation: x.confirm === '' ? null : x.confirm === 'true',
    minNoticeMinutes: numOrNull(x.minNotice),
    maxAdvanceDays: numOrNull(x.maxAdvance),
    imageUrl: x.imageUrl.trim() || null,
  };
  const target = editing.value;
  const saved = await form.run(() =>
    target === 'new'
      ? api.createService(common)
      : api.updateService((target as ServiceView).id, common),
  );
  if (saved) {
    editing.value = null;
    await list.reload();
    openLinks(saved); // tras guardar, se asignan sucursales y recursos
  }
}

function openLinks(s: ServiceView) {
  linking.value = s;
  selLocations.value = [...s.locationIds];
  selResources.value = [...s.resourceIds];
  linkSaved.value = false;
}

async function saveLinks() {
  const s = linking.value;
  if (!s) return;
  const ok = await links.run(async () => {
    await api.setServiceLocations(s.id, { locationIds: selLocations.value });
    const allowed = new Set(resourceChoices.value.map((r) => r.id));
    const updated = await api.setServiceResources(s.id, {
      resourceIds: selResources.value.filter((r) => allowed.has(r)),
    });
    linking.value = updated;
    return true;
  });
  if (ok) {
    linkSaved.value = true;
    await list.reload();
  }
}

async function toggle(s: ServiceView) {
  await action.run(() => api.updateService(s.id, { isActive: !s.isActive }));
  await list.reload();
}
async function remove(s: ServiceView) {
  if (!window.confirm(`¿Eliminar el servicio "${s.name}"?`)) return;
  await action.run(() => api.deleteService(s.id));
  await list.reload();
}
async function addCategory() {
  if (!newCategory.value.trim()) return;
  const ok = await action.run(async () => {
    await api.createCategory({ name: newCategory.value.trim(), sortOrder: 0 });
    return true;
  });
  if (ok) {
    newCategory.value = '';
    await loadRefs();
  }
}
async function removeCategory(c: CategoryView) {
  await action.run(() => api.deleteCategory(c.id));
  await loadRefs();
}

onMounted(async () => {
  await Promise.all([list.reload(), loadRefs()]);
});
</script>

<template>
  <h1>Servicios</h1>
  <AlertBox v-if="list.error.value" kind="error">{{ list.error.value }}</AlertBox>
  <AlertBox v-if="action.error.value" kind="error">{{ action.error.value }}</AlertBox>

  <p v-if="auth.can('services:write') && !editing">
    <button type="button" @click="startEdit('new')">+ Nuevo servicio</button>
  </p>

  <form v-if="editing" class="card" novalidate @submit.prevent="save">
    <h2 style="margin-top: 0">{{ editing === 'new' ? 'Nuevo servicio' : 'Editar servicio' }}</h2>
    <AlertBox v-if="form.error.value" kind="error">{{ form.error.value }}</AlertBox>
    <FormField v-model="f.name" label="Nombre" required :error="form.fieldErrors.value['name']" />
    <FormField
      v-model="f.description"
      label="Descripción"
      :error="form.fieldErrors.value['description']"
    />
    <div class="field">
      <label for="s-cat">Categoría</label>
      <select id="s-cat" v-model="f.categoryId">
        <option value="">Sin categoría</option>
        <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
    </div>
    <div class="row">
      <div class="field">
        <label for="s-dur">Duración (min)</label
        ><input id="s-dur" v-model.number="f.durationMinutes" type="number" min="1" max="1440" />
      </div>
      <div class="field">
        <label for="s-bb">Preparación antes (min)</label
        ><input id="s-bb" v-model.number="f.bufferBefore" type="number" min="0" max="240" />
      </div>
      <div class="field">
        <label for="s-ba">Limpieza después (min)</label
        ><input id="s-ba" v-model.number="f.bufferAfter" type="number" min="0" max="240" />
      </div>
    </div>
    <FormField
      v-model="f.price"
      label="Precio"
      hint="Número con hasta 2 decimales, ej.: 12990 o 49.50. La moneda es la de tu empresa."
      required
      :error="form.fieldErrors.value['price']"
    />
    <div class="row">
      <div class="field">
        <label for="s-conf">Confirmación</label>
        <select id="s-conf" v-model="f.confirm">
          <option value="">Según la configuración de la empresa</option>
          <option value="false">Se confirma automáticamente</option>
          <option value="true">Requiere confirmación del negocio</option>
        </select>
      </div>
      <div class="field">
        <label for="s-mn">Antelación mínima (min)</label
        ><input id="s-mn" v-model="f.minNotice" type="number" min="0" placeholder="Empresa" />
      </div>
      <div class="field">
        <label for="s-ma">Antelación máxima (días)</label
        ><input
          id="s-ma"
          v-model="f.maxAdvance"
          type="number"
          min="1"
          max="730"
          placeholder="Empresa"
        />
      </div>
    </div>
    <FormField
      v-model="f.imageUrl"
      label="Imagen (URL https, opcional)"
      :error="form.fieldErrors.value['imageUrl']"
    />
    <div class="actions">
      <button
        class="primary"
        type="submit"
        style="width: auto"
        :disabled="form.loading.value || !f.name || !f.price"
      >
        Guardar
      </button>
      <button type="button" @click="editing = null">Cancelar</button>
    </div>
  </form>

  <section v-if="linking" class="card" aria-labelledby="vinculos">
    <h2 id="vinculos" style="margin-top: 0">Dónde y quién presta «{{ linking.name }}»</h2>
    <AlertBox v-if="links.error.value" kind="error">{{ links.error.value }}</AlertBox>
    <AlertBox v-if="linkSaved" kind="success">Vínculos guardados.</AlertBox>
    <fieldset class="checklist" style="border: 0; padding: 0">
      <legend><strong>Sucursales donde se ofrece</strong></legend>
      <label v-for="l in locations" :key="l.id"
        ><input v-model="selLocations" type="checkbox" :value="l.id" /> {{ l.name }}</label
      >
    </fieldset>
    <fieldset class="checklist" style="border: 0; padding: 0; margin-top: 0.75rem">
      <legend><strong>Profesionales y recursos que pueden prestarlo</strong></legend>
      <label v-for="r in resourceChoices" :key="r.id"
        ><input v-model="selResources" type="checkbox" :value="r.id" /> {{ r.name }}</label
      >
      <span v-if="resourceChoices.length === 0" class="muted"
        >Marca una sucursal para ver sus recursos.</span
      >
    </fieldset>
    <div class="actions" style="margin-top: 0.75rem">
      <button
        class="primary"
        type="button"
        style="width: auto"
        :disabled="links.loading.value"
        @click="saveLinks"
      >
        Guardar vínculos
      </button>
      <button type="button" @click="linking = null">Cerrar</button>
    </div>
  </section>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Servicio</th>
          <th>Categoría</th>
          <th>Duración</th>
          <th>Precio</th>
          <th>Estado</th>
          <th><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in list.items.value" :key="s.id">
          <td>
            {{ s.name }}<br /><span class="muted"
              >{{ s.locationIds.length }} sucursal(es) · {{ s.resourceIds.length }} recurso(s)</span
            >
          </td>
          <td>{{ catName(s.categoryId) }}</td>
          <td>{{ s.durationMinutes }} min</td>
          <td>{{ s.price }} {{ s.currency }}</td>
          <td>
            <span :class="['badge', !s.isActive && 'off']">{{
              s.isActive ? 'Activo' : 'Desactivado'
            }}</span>
          </td>
          <td class="actions">
            <template v-if="auth.can('services:write')">
              <button type="button" class="small" @click="startEdit(s)">Editar</button>
              <button type="button" class="small" @click="openLinks(s)">
                Sucursales y recursos
              </button>
              <button
                type="button"
                class="small"
                :disabled="action.loading.value"
                @click="toggle(s)"
              >
                {{ s.isActive ? 'Desactivar' : 'Reactivar' }}
              </button>
              <button
                type="button"
                class="small danger"
                :disabled="action.loading.value"
                @click="remove(s)"
              >
                Eliminar
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!list.loading.value && list.items.value.length === 0">
          <td colspan="6" class="muted">Aún no hay servicios.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="list.nextCursor.value"><button type="button" @click="list.more()">Cargar más</button></p>

  <section v-if="auth.can('services:write')" class="card" aria-labelledby="categorias">
    <h2 id="categorias" style="margin-top: 0">Categorías</h2>
    <form class="row" novalidate @submit.prevent="addCategory">
      <div style="flex: 1; min-width: 200px">
        <FormField v-model="newCategory" label="Nueva categoría" />
      </div>
      <div class="field">
        <button type="submit" :disabled="action.loading.value || !newCategory.trim()">
          Agregar
        </button>
      </div>
    </form>
    <p v-for="c in categories" :key="c.id" style="margin: 0.2rem 0">
      {{ c.name }}
      <button
        type="button"
        class="small danger"
        :aria-label="`Eliminar categoría ${c.name}`"
        @click="removeCategory(c)"
      >
        Eliminar
      </button>
    </p>
  </section>
</template>

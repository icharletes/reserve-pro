<script setup lang="ts">
import type { InvitationView, MemberView, RoleView } from '@reservepro/contracts';
import { onMounted, ref } from 'vue';
import AlertBox from '../components/AlertBox.vue';
import FormField from '../components/FormField.vue';
import { useAsyncAction } from '../composables/use-async-action';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const members = ref<MemberView[]>([]);
const nextCursor = ref<string | null>(null);
const roles = ref<RoleView[]>([]);
const invitations = ref<InvitationView[]>([]);
const loadError = ref<string | null>(null);
const notice = ref<string | null>(null);

const inviteEmail = ref('');
const inviteRole = ref('receptionist');
const invite = useAsyncAction();
const action = useAsyncAction();

async function load() {
  try {
    const [page, rs] = await Promise.all([api.listMembers({ limit: 25 }), api.listRoles()]);
    members.value = page.items;
    nextCursor.value = page.nextCursor;
    roles.value = rs;
    if (auth.can('members:invite')) invitations.value = await api.listInvitations();
  } catch {
    loadError.value = 'No se pudo cargar el equipo.';
  }
}
onMounted(load);

async function more() {
  if (!nextCursor.value) return;
  await action.run(async () => {
    const page = await api.listMembers({ limit: 25, cursor: nextCursor.value! });
    members.value.push(...page.items);
    nextCursor.value = page.nextCursor;
  });
}

async function sendInvite() {
  const res = await invite.run(() =>
    api.createInvitation({ email: inviteEmail.value.trim(), roleKey: inviteRole.value }),
  );
  if (!res) return;
  inviteEmail.value = '';
  notice.value = res.emailSent
    ? 'Invitación enviada.'
    : 'La invitación se creó, pero no pudimos enviar el correo. Usa "Reenviar".';
  invitations.value = await api.listInvitations();
}

async function toggle(m: MemberView) {
  const status = m.status === 'active' ? 'disabled' : 'active';
  const updated = await action.run(() => api.updateMember(m.membershipId, { status }));
  if (updated)
    members.value = members.value.map((x) =>
      x.membershipId === updated.membershipId ? updated : x,
    );
}

async function resend(i: InvitationView) {
  const res = await action.run(() => api.resendInvitation(i.id));
  if (res)
    notice.value = res.emailSent
      ? 'Invitación reenviada.'
      : 'No pudimos enviar el correo. Inténtalo de nuevo.';
  invitations.value = await api.listInvitations();
}

async function revoke(i: InvitationView) {
  await action.run(() => api.revokeInvitation(i.id));
  invitations.value = await api.listInvitations();
}
</script>

<template>
  <h1>Equipo</h1>
  <AlertBox v-if="loadError" kind="error">{{ loadError }}</AlertBox>
  <AlertBox v-if="notice" kind="success">{{ notice }}</AlertBox>
  <AlertBox v-if="action.error.value" kind="error">{{ action.error.value }}</AlertBox>

  <section v-if="auth.can('members:invite')" class="card" aria-labelledby="invitar">
    <h2 id="invitar" style="margin-top: 0">Invitar a una persona</h2>
    <AlertBox v-if="invite.error.value" kind="error">{{ invite.error.value }}</AlertBox>
    <form class="row" novalidate @submit.prevent="sendInvite">
      <div style="flex: 2; min-width: 220px">
        <FormField
          v-model="inviteEmail"
          label="Email"
          type="email"
          required
          :error="invite.fieldErrors.value['email']"
        />
      </div>
      <div class="field" style="flex: 1; min-width: 160px">
        <label for="rol">Rol</label>
        <select id="rol" v-model="inviteRole">
          <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.name }}</option>
        </select>
      </div>
      <div class="field">
        <button class="primary" type="submit" :disabled="invite.loading.value || !inviteEmail">
          Invitar
        </button>
      </div>
    </form>
  </section>

  <section aria-labelledby="miembros">
    <h2 id="miembros">Miembros</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Email</th>
            <th>Roles</th>
            <th>Estado</th>
            <th v-if="auth.can('members:update')"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in members" :key="m.membershipId">
            <td>{{ m.fullName }}</td>
            <td>{{ m.email }}</td>
            <td>{{ m.roles.map((r) => r.name).join(', ') }}</td>
            <td>
              <span :class="['badge', m.status === 'disabled' && 'off']">{{
                m.status === 'active' ? 'Activo' : 'Desactivado'
              }}</span>
            </td>
            <td v-if="auth.can('members:update')">
              <button
                v-if="m.userId !== auth.user?.id"
                type="button"
                class="small"
                :disabled="action.loading.value"
                @click="toggle(m)"
              >
                {{ m.status === 'active' ? 'Desactivar' : 'Reactivar' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="nextCursor">
      <button type="button" :disabled="action.loading.value" @click="more">Cargar más</button>
    </p>
  </section>

  <section v-if="auth.can('members:invite') && invitations.length > 0" aria-labelledby="pendientes">
    <h2 id="pendientes">Invitaciones pendientes</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Rol</th>
            <th>Vence</th>
            <th><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in invitations" :key="i.id">
            <td>{{ i.email }}</td>
            <td>{{ i.roleName }}</td>
            <td>
              {{ new Date(i.expiresAt).toLocaleDateString() }}
              <span v-if="i.expired" class="badge off">vencida</span>
            </td>
            <td>
              <button
                type="button"
                class="small"
                :disabled="action.loading.value"
                @click="resend(i)"
              >
                Reenviar
              </button>
              <button
                type="button"
                class="small danger"
                :disabled="action.loading.value"
                @click="revoke(i)"
              >
                Revocar
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>

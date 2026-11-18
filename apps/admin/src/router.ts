import type { PermissionKey } from '@reservepro/contracts';
import { type RouteRecordRaw, createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    /** Accesible sin sesión (y con ella). */
    public?: boolean;
    /** Solo para visitantes: con sesión redirige al inicio (login, registro). */
    guestOnly?: boolean;
    /** Exige sesión PERO no empresa activa (selector de empresa). */
    noTenant?: boolean;
    /** Permiso necesario para ver la pantalla (la API lo vuelve a exigir). */
    permission?: PermissionKey;
    /** Alternativa: basta con UNO de estos permisos. */
    permissionAny?: PermissionKey[];
    title?: string;
  }
}

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { guestOnly: true, title: 'Iniciar sesión' },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('./views/RegisterView.vue'),
    meta: { guestOnly: true, title: 'Crear cuenta' },
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: () => import('./views/ForgotPasswordView.vue'),
    meta: { guestOnly: true, title: 'Recuperar contraseña' },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('./views/ResetPasswordView.vue'),
    meta: { public: true, title: 'Nueva contraseña' },
  },
  {
    path: '/verify-email',
    name: 'verify-email',
    component: () => import('./views/VerifyEmailView.vue'),
    meta: { public: true, title: 'Verificar email' },
  },
  {
    path: '/accept-invitation',
    name: 'accept-invitation',
    component: () => import('./views/AcceptInvitationView.vue'),
    meta: { public: true, title: 'Aceptar invitación' },
  },
  {
    path: '/select-tenant',
    name: 'select-tenant',
    component: () => import('./views/SelectTenantView.vue'),
    meta: { noTenant: true, title: 'Elegir empresa' },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('./views/DashboardView.vue'),
    meta: { title: 'Inicio' },
  },
  {
    path: '/members',
    name: 'members',
    component: () => import('./views/MembersView.vue'),
    meta: { permission: 'members:read', title: 'Equipo' },
  },
  {
    path: '/audit',
    name: 'audit',
    component: () => import('./views/AuditView.vue'),
    meta: { permission: 'audit:read', title: 'Auditoría' },
  },
  {
    path: '/locations',
    name: 'locations',
    component: () => import('./views/LocationsView.vue'),
    meta: { permission: 'locations:read', title: 'Sucursales' },
  },
  {
    path: '/locations/:id/hours',
    name: 'location-hours',
    component: () => import('./views/LocationHoursView.vue'),
    meta: { permission: 'schedules:read', title: 'Horario de sucursal' },
  },
  {
    path: '/services',
    name: 'services',
    component: () => import('./views/ServicesView.vue'),
    meta: { permission: 'services:read', title: 'Servicios' },
  },
  {
    path: '/resources',
    name: 'resources',
    component: () => import('./views/ResourcesView.vue'),
    meta: { permission: 'resources:read', title: 'Profesionales y recursos' },
  },
  {
    path: '/resources/:id/schedule',
    name: 'resource-schedule',
    component: () => import('./views/ResourceScheduleView.vue'),
    meta: { permission: 'schedules:read', title: 'Horario del recurso' },
  },
  {
    path: '/holidays',
    name: 'holidays',
    component: () => import('./views/HolidaysView.vue'),
    meta: { permission: 'schedules:read', title: 'Feriados' },
  },
  {
    path: '/blocks',
    name: 'blocks',
    component: () => import('./views/BlocksView.vue'),
    meta: { permission: 'blocks:read', title: 'Bloqueos' },
  },
  {
    path: '/calendar',
    name: 'calendar',
    component: () => import('./views/CalendarView.vue'),
    meta: { permissionAny: ['calendar:read', 'calendar:read:own'], title: 'Calendario' },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('./views/ForbiddenView.vue'),
    meta: { title: 'Sin acceso' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./views/NotFoundView.vue'),
    meta: { public: true, title: 'No encontrado' },
  },
];

export function createAppRouter(history = createWebHistory()) {
  const router = createRouter({ history, routes });

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    await auth.bootstrap(); // espera a saber si hay sesión antes de decidir nada

    if (to.meta.public) return true;

    if (!auth.isAuthenticated) {
      // El destino se guarda para volver tras iniciar sesión (solo rutas internas: ver LoginView).
      return to.meta.guestOnly ? true : { name: 'login', query: { redirect: to.fullPath } };
    }
    if (to.meta.guestOnly) return { name: auth.hasTenant ? 'dashboard' : 'select-tenant' };

    if (!auth.hasTenant) return to.meta.noTenant ? true : { name: 'select-tenant' };
    if (to.meta.noTenant) return true; // cambiar de empresa con sesión activa es válido

    if (to.meta.permission && !auth.can(to.meta.permission)) return { name: 'forbidden' };
    if (to.meta.permissionAny && !auth.canAny(...to.meta.permissionAny))
      return { name: 'forbidden' };
    return true;
  });

  router.afterEach((to) => {
    document.title = to.meta.title ? `${to.meta.title} · ReservePro` : 'ReservePro';
  });
  return router;
}

import { type Mock, vi } from 'vitest';

const U1 = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f60';
const T1 = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f61';
const T2 = '0194f3a2-7b1c-7d3e-8a4f-1b2c3d4e5f62';

export const ids = { U1, T1, T2 };

export const auth = (activeTenantId: string | null = T1) => ({
  accessToken: 'tok',
  expiresIn: 900,
  user: { id: U1, email: 'ana@x.test', fullName: 'Ana Pérez', emailVerified: true },
  activeTenantId,
  memberships: [
    { membershipId: U1, tenantId: T1, tenantName: 'Barbería Uno', tenantSlug: 'barberia-uno' },
    { membershipId: U1, tenantId: T2, tenantName: 'Spa Dos', tenantSlug: 'spa-dos' },
  ],
});

export const me = (permissions: string[] = ['tenant:read']) => ({
  user: {
    id: U1,
    email: 'ana@x.test',
    fullName: 'Ana Pérez',
    isPlatformAdmin: false,
    emailVerified: true,
  },
  tenant: {
    id: T1,
    name: 'Barbería Uno',
    slug: 'barberia-uno',
    timezone: 'America/Santiago',
    currency: 'CLP',
  },
  membershipId: U1,
  roles: ['owner'],
  permissions,
});

const API_METHODS = [
  'restoreSession',
  'login',
  'register',
  'switchTenant',
  'logout',
  'me',
  'forgotPassword',
  'resetPassword',
  'verifyEmail',
  'resendVerification',
  'previewInvitation',
  'acceptInvitation',
  'listMembers',
  'listRoles',
  'listInvitations',
  'listAuditLogs',
  'getLocation',
  'getResource',
  'listLocations',
  'createLocation',
  'updateLocation',
  'deleteLocation',
  'listCategories',
  'createCategory',
  'deleteCategory',
  'listServices',
  'createService',
  'updateService',
  'deleteService',
  'setServiceLocations',
  'setServiceResources',
  'listResources',
  'createResource',
  'updateResource',
  'deleteResource',
  'getBusinessHours',
  'setBusinessHours',
  'getResourceSchedule',
  'setResourceSchedule',
  'listOverrides',
  'putOverride',
  'deleteOverride',
  'listHolidays',
  'putHoliday',
  'deleteHoliday',
  'listBlocks',
  'createBlocks',
  'deleteBlock',
  'getCalendar',
] as const;

/** Doble del módulo `../api`: cada prueba ajusta lo que necesita. */
export const apiMock = Object.fromEntries(API_METHODS.map((m) => [m, vi.fn()])) as Record<
  (typeof API_METHODS)[number],
  Mock
>;

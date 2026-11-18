import { PERMISSION_KEYS, type PermissionKey } from '@reservepro/contracts';

export interface RoleTemplate {
  key: string;
  name: string;
  permissions: readonly PermissionKey[];
}

const without = (excluded: PermissionKey[]): PermissionKey[] =>
  PERMISSION_KEYS.filter((p) => !excluded.includes(p));

const OWN_ONLY: PermissionKey[] = ['reservations:read:own', 'calendar:read:own'];

/**
 * Plantillas de los roles de sistema. Al crear una empresa se copian como filas de `roles` /
 * `role_permissions` de ESA empresa (ARCHITECTURE.md §3.1). Matriz: ARCHITECTURE.md §3.3.
 * `super_admin` NO es un rol de tenant (es `users.is_platform_admin`).
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'owner', name: 'Propietario', permissions: PERMISSION_KEYS },
  {
    key: 'admin',
    name: 'Administrador',
    // Todo salvo facturación; los permisos "own" son un subconjunto de los completos.
    permissions: without(['billing:manage', ...OWN_ONLY]),
  },
  {
    key: 'manager',
    name: 'Gerente',
    permissions: [
      'tenant:read',
      'members:read',
      'locations:read',
      'locations:write',
      'services:read',
      'services:write',
      'resources:read',
      'resources:write',
      'schedules:read',
      'schedules:write',
      'blocks:read',
      'blocks:write',
      'customers:read',
      'customers:write',
      'reservations:read',
      'reservations:create',
      'reservations:update',
      'reservations:confirm',
      'reservations:cancel',
      'reservations:reschedule',
      'reservations:status',
      'calendar:read',
      'notifications:read',
      'reports:read',
    ],
  },
  {
    key: 'receptionist',
    name: 'Recepción',
    permissions: [
      'tenant:read',
      'locations:read',
      'services:read',
      'resources:read',
      'schedules:read',
      'blocks:read',
      'customers:read',
      'customers:write',
      'reservations:read',
      'reservations:create',
      'reservations:update',
      'reservations:confirm',
      'reservations:cancel',
      'reservations:reschedule',
      'reservations:status',
      'calendar:read',
      'notifications:read',
    ],
  },
  {
    key: 'professional',
    name: 'Profesional',
    permissions: [
      'tenant:read',
      'services:read',
      'resources:read',
      'schedules:read',
      'blocks:read',
      'customers:read',
      'reservations:read:own',
      'reservations:status',
      'calendar:read:own',
    ],
  },
];
